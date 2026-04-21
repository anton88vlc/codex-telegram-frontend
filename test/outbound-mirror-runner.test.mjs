import test from "node:test";
import assert from "node:assert/strict";

import { syncOutboundMirrors } from "../lib/outbound-mirror-runner.mjs";

const bindingKey = "group:-1001:topic:42";

function makeConfig(overrides = {}) {
  return {
    botToken: "token",
    threadsDbPath: "/tmp/threads.sqlite",
    codexUserDisplayName: "Anton",
    ...overrides,
  };
}

function makeBinding(overrides = {}) {
  return {
    threadId: "thread-1",
    chatId: "-1001",
    messageThreadId: 42,
    transport: "native",
    lastInboundMessageId: 7,
    ...overrides,
  };
}

function makeState(binding = makeBinding(), mirror = null) {
  return {
    bindings: { [bindingKey]: binding },
    outboundMirrors: mirror ? { [bindingKey]: mirror } : {},
  };
}

function makeThread(overrides = {}) {
  return {
    id: "thread-1",
    rollout_path: "/tmp/thread.jsonl",
    archived: 0,
    cwd: "/tmp/project",
    ...overrides,
  };
}

test("syncOutboundMirrors is a no-op when outbound sync is disabled", async () => {
  let touched = false;
  const result = await syncOutboundMirrors({
    config: makeConfig({ outboundSyncEnabled: false }),
    state: makeState(),
    getThreadsByIdsFn: async () => {
      touched = true;
      return [];
    },
  });

  assert.deepEqual(result, { delivered: 0, suppressed: 0, changed: false });
  assert.equal(touched, false);
});

test("syncOutboundMirrors delivers user and final assistant mirrors", async () => {
  const state = makeState();
  const calls = [];
  const result = await syncOutboundMirrors({
    config: makeConfig(),
    state,
    getThreadsByIdsFn: async (dbPath, threadIds) => {
      calls.push(["threads", dbPath, threadIds]);
      return [makeThread()];
    },
    readThreadMirrorDeltaFn: async (args) => {
      calls.push(["delta", args]);
      return {
        mirror: {
          rolloutPath: "/tmp/thread.jsonl",
          byteOffset: 100,
          partialLine: "",
          lastSignature: "a1",
        },
        messages: [
          {
            role: "user",
            phase: "input",
            text: "Please check this",
            signature: "u1",
            timestamp: "2026-04-19T10:00:00.000Z",
          },
          {
            role: "assistant",
            phase: "final_answer",
            text: "Checked.",
            signature: "a1",
            timestamp: "2026-04-19T10:01:00.000Z",
          },
        ],
      };
    },
    sendRichTextChunksFn: async (...args) => {
      calls.push(["send", ...args]);
      return [{ message_id: calls.filter((call) => call[0] === "send").length + 10 }];
    },
    completeOutboundProgressMessageFn: async (...args) => {
      calls.push(["complete", ...args]);
      return [];
    },
    loadChangedFilesTextForThreadFn: async () => "1 file changed +1 -0",
    captureWorktreeBaselineFn: async () => ({ head: "abc123", summary: { files: [] } }),
    rememberOutboundFn: (binding, sent) => {
      binding.lastOutboundMessageIds = sent.map((item) => item.message_id);
    },
  });

  assert.deepEqual(result, { delivered: 2, suppressed: 0, changed: true });
  assert.equal(calls.filter((call) => call[0] === "send").length, 2);
  assert.match(calls.find((call) => call[0] === "send")?.[3], /Anton via Codex/);
  assert.equal(state.bindings[bindingKey].currentTurn, null);
  assert.equal(state.bindings[bindingKey].lastMirroredRole, "assistant");
  assert.deepEqual(state.bindings[bindingKey].lastOutboundMessageIds, [12]);
  assert.equal(state.outboundMirrors[bindingKey].lastSignature, "a1");
  assert.equal(state.outboundMirrors[bindingKey].replyTargetMessageId, null);
  assert.deepEqual(state.outboundMirrors[bindingKey].pendingMessages, []);
});

test("syncOutboundMirrors consumes suppressed messages without sending them", async () => {
  const state = makeState(makeBinding(), {
    threadId: "thread-1",
    rolloutPath: "/tmp/thread.jsonl",
    suppressions: ["u1"],
    replyTargetMessageId: null,
  });
  const sends = [];
  const result = await syncOutboundMirrors({
    config: makeConfig(),
    state,
    getThreadsByIdsFn: async () => [makeThread()],
    readThreadMirrorDeltaFn: async () => ({
      mirror: {
        rolloutPath: "/tmp/thread.jsonl",
        byteOffset: 101,
        partialLine: "",
        lastSignature: "u1",
      },
      messages: [
        {
          role: "user",
          phase: "input",
          text: "Telegram-originated prompt",
          signature: "u1",
          timestamp: "2026-04-19T10:00:00.000Z",
        },
      ],
    }),
    sendRichTextChunksFn: async (...args) => {
      sends.push(args);
      return [];
    },
  });

  assert.deepEqual(result, { delivered: 0, suppressed: 1, changed: true });
  assert.deepEqual(sends, []);
  assert.deepEqual(state.outboundMirrors[bindingKey].suppressions, []);
  assert.equal(state.outboundMirrors[bindingKey].replyTargetMessageId, 7);
});

test("syncOutboundMirrors keeps pending messages after a delivery error", async () => {
  const events = [];
  const state = makeState();
  const message = {
    role: "assistant",
    phase: "commentary",
    text: "Working on it",
    signature: "c1",
    timestamp: "2026-04-19T10:00:00.000Z",
  };
  const result = await syncOutboundMirrors({
    config: makeConfig(),
    state,
    getThreadsByIdsFn: async () => [makeThread()],
    readThreadMirrorDeltaFn: async () => ({
      mirror: {
        rolloutPath: "/tmp/thread.jsonl",
        byteOffset: 102,
        partialLine: "",
        lastSignature: "c1",
      },
      messages: [message],
    }),
    upsertOutboundProgressMessageFn: async () => {
      throw new Error("telegram edit failed");
    },
    logEventFn: (...args) => events.push(args),
  });

  assert.deepEqual(result, { delivered: 0, suppressed: 0, changed: true });
  assert.deepEqual(state.outboundMirrors[bindingKey].pendingMessages, [message]);
  assert.equal(events[0][0], "outbound_mirror_delivery_error");
  assert.equal(events[0][1].error, "telegram edit failed");
});
