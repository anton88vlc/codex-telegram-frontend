import test from "node:test";
import assert from "node:assert/strict";

import {
  isMissingStatusBarMessageError,
  refreshStatusBars,
  reserveStatusBarMessage,
} from "../lib/status-bar-runner.mjs";

const config = {
  botToken: "token",
  threadsDbPath: "/tmp/threads.sqlite",
  statusBarTailBytes: 1024,
};

function makeState(binding = {}) {
  return {
    bindings: {
      "group:-1001:topic:42": {
        threadId: "thread-1",
        chatId: "-1001",
        messageThreadId: 42,
        ...binding,
      },
    },
  };
}

function makeDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    getThreadsByIdsFn: async (dbPath, threadIds) => {
      calls.push(["threads", dbPath, threadIds]);
      return [{ id: "thread-1", rollout_path: "/tmp/rollout.jsonl", archived: 0 }];
    },
    readRolloutRuntimeStatusFn: async (rolloutPath, options) => {
      calls.push(["runtime", rolloutPath, options]);
      return { lastTokenUsage: { total_tokens: 10 }, modelContextWindow: 100 };
    },
    buildStatusBarMessageFn: ({ runtime }) => ({
      text: `status ${runtime?.lastTokenUsage?.total_tokens ?? "none"}`,
      entities: [],
    }),
    makeStatusBarHashFn: (text) => `hash:${text}`,
    editMessageTextFn: async (...args) => {
      calls.push(["edit", ...args]);
      return { ok: true };
    },
    reserveStatusBarMessageFn: async ({ binding, message }) => {
      calls.push(["reserve", binding.chatId, binding.messageThreadId, message.text]);
      binding.statusBarMessageId = 77;
      return 77;
    },
    logEventFn: (type, payload) => calls.push(["event", type, payload]),
    ...overrides,
  };
}

test("isMissingStatusBarMessageError detects Telegram edit-missing failures", () => {
  assert.equal(isMissingStatusBarMessageError(new Error("message to edit not found")), true);
  assert.equal(isMissingStatusBarMessageError(new Error("MESSAGE_ID_INVALID")), true);
  assert.equal(isMissingStatusBarMessageError(new Error("network down")), false);
});

test("reserveStatusBarMessage sends, pins and records the message id", async () => {
  const binding = { chatId: "-1001", messageThreadId: 42 };
  const calls = [];
  const messageId = await reserveStatusBarMessage({
    config,
    bindingKey: "group:-1001:topic:42",
    binding,
    message: { text: "status", entities: [] },
    sendMessageFn: async (...args) => {
      calls.push(["send", ...args]);
      return { message_id: 55 };
    },
    pinChatMessageFn: async (...args) => calls.push(["pin", ...args]),
  });

  assert.equal(messageId, 55);
  assert.equal(binding.statusBarMessageId, 55);
  assert.ok(binding.statusBarPinnedAt);
  assert.equal(calls[0][0], "send");
  assert.equal(calls[1][0], "pin");
});

test("refreshStatusBars reserves a missing status bar", async () => {
  const state = makeState();
  const deps = makeDeps();
  const result = await refreshStatusBars({ config, state, ...deps });

  assert.deepEqual(result, { changed: true, updated: 1 });
  assert.equal(state.bindings["group:-1001:topic:42"].statusBarMessageId, 77);
  assert.match(state.bindings["group:-1001:topic:42"].statusBarTextHash, /^hash:/);
  assert.equal(deps.calls.at(-1)[0], "reserve");
});

test("refreshStatusBars skips unchanged status bars", async () => {
  const message = { text: "status 10", entities: [] };
  const state = makeState({
    statusBarMessageId: 77,
    statusBarTextHash: `hash:${JSON.stringify(message)}`,
  });
  const result = await refreshStatusBars({ config, state, ...makeDeps() });

  assert.deepEqual(result, { changed: false, updated: 0 });
});

test("refreshStatusBars recreates a missing edited message", async () => {
  const state = makeState({ statusBarMessageId: 66, statusBarTextHash: "old" });
  const deps = makeDeps({
    editMessageTextFn: async () => {
      throw new Error("message to edit not found");
    },
  });
  const result = await refreshStatusBars({ config, state, ...deps });

  assert.deepEqual(result, { changed: true, updated: 1 });
  assert.equal(state.bindings["group:-1001:topic:42"].statusBarMessageId, 77);
  assert.equal(deps.calls.at(-1)[0], "reserve");
});

test("refreshStatusBars logs runtime read errors and still updates with empty runtime", async () => {
  const state = makeState();
  const deps = makeDeps({
    readRolloutRuntimeStatusFn: async () => {
      throw new Error("rollout unreadable");
    },
  });
  const result = await refreshStatusBars({ config, state, ...deps });

  assert.deepEqual(result, { changed: true, updated: 1 });
  assert.equal(deps.calls.find((call) => call[0] === "event")?.[1], "status_bar_runtime_error");
  assert.equal(deps.calls.find((call) => call[0] === "reserve")?.[3], "status none");
});
