import test from "node:test";
import assert from "node:assert/strict";

import {
  selectOutboundMirrorBindingEntries,
  syncOutboundMirrors,
} from "../lib/outbound-mirror-runner.mjs";

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

test("syncOutboundMirrors can target one binding without touching other topics", async () => {
  const state = {
    bindings: {
      [bindingKey]: makeBinding({ threadId: "thread-1" }),
      "group:-1001:topic:99": makeBinding({ threadId: "thread-2", messageThreadId: 99 }),
    },
    outboundMirrors: {},
  };
  const requestedThreadIds = [];
  const result = await syncOutboundMirrors({
    config: makeConfig(),
    state,
    onlyBindingKey: bindingKey,
    getThreadsByIdsFn: async (_dbPath, threadIds) => {
      requestedThreadIds.push(...threadIds);
      return [makeThread({ id: "thread-1" })];
    },
    readThreadMirrorDeltaFn: async () => ({
      mirror: {
        rolloutPath: "/tmp/thread.jsonl",
        byteOffset: 100,
        partialLine: "",
        lastSignature: "a1",
      },
      messages: [
        {
          role: "assistant",
          phase: "final_answer",
          text: "Only this topic.",
          signature: "a1",
          timestamp: "2026-04-19T10:01:00.000Z",
        },
      ],
    }),
    sendRichTextChunksFn: async () => [{ message_id: 11 }],
    completeOutboundProgressMessageFn: async () => [],
  });

  assert.deepEqual(result, { delivered: 1, suppressed: 0, changed: true });
  assert.deepEqual(requestedThreadIds, ["thread-1"]);
  assert.equal(state.outboundMirrors[bindingKey].lastSignature, "a1");
  assert.equal(state.outboundMirrors["group:-1001:topic:99"], undefined);
});

test("syncOutboundMirrors stops after Telegram flood-control and keeps pending messages", async () => {
  const state = {
    bindings: {
      [bindingKey]: makeBinding({ threadId: "thread-1" }),
      "group:-1001:topic:99": makeBinding({ threadId: "thread-2", messageThreadId: 99 }),
    },
    outboundMirrors: {},
  };
  const rateLimitEvents = [];
  const result = await syncOutboundMirrors({
    config: makeConfig(),
    state,
    getThreadsByIdsFn: async () => [
      makeThread({ id: "thread-1" }),
      makeThread({ id: "thread-2" }),
    ],
    readThreadMirrorDeltaFn: async ({ threadId }) => ({
      mirror: {
        rolloutPath: `/tmp/${threadId}.jsonl`,
        byteOffset: 100,
        partialLine: "",
        lastSignature: `${threadId}:a1`,
      },
      messages: [
        {
          role: "assistant",
          phase: "final_answer",
          text: `Final ${threadId}`,
          signature: `${threadId}:a1`,
          timestamp: "2026-04-19T10:01:00.000Z",
        },
      ],
    }),
    sendRichTextChunksFn: async () => {
      throw new Error("telegram sendMessage failed: Too Many Requests: retry after 36");
    },
    onTelegramRateLimitFn: (error, context) => {
      rateLimitEvents.push({ error: error.message, context });
      return true;
    },
  });

  assert.deepEqual(result, { delivered: 0, suppressed: 0, changed: true });
  assert.equal(rateLimitEvents.length, 1);
  assert.equal(rateLimitEvents[0].context.bindingKey, bindingKey);
  assert.equal(state.outboundMirrors[bindingKey].pendingMessages.length, 1);
  assert.equal(state.outboundMirrors["group:-1001:topic:99"], undefined);
});

test("selectOutboundMirrorBindingEntries keeps hot topics and rotates the rest", () => {
  const nowMs = Date.parse("2026-04-21T10:30:00.000Z");
  const state = {};
  const entries = [
    ["hot", makeBinding({ threadId: "hot", currentTurn: { startedAt: "2026-04-21T10:20:00.000Z" } })],
    ["cold-1", makeBinding({ threadId: "cold-1", lastMirroredAt: "2026-04-19T10:00:00.000Z" })],
    ["cold-2", makeBinding({ threadId: "cold-2", lastMirroredAt: "2026-04-19T10:00:00.000Z" })],
    ["cold-3", makeBinding({ threadId: "cold-3", lastMirroredAt: "2026-04-19T10:00:00.000Z" })],
  ];
  const config = {
    outboundMirrorMaxBindingsPerPoll: 2,
    bindingHotMaxAgeMs: 30 * 60 * 1000,
    bindingWarmMaxAgeMs: 24 * 60 * 60 * 1000,
  };

  assert.deepEqual(
    selectOutboundMirrorBindingEntries({ state, entries, config, nowMs }).map(([key]) => key),
    ["hot", "cold-1"],
  );
  assert.deepEqual(
    selectOutboundMirrorBindingEntries({ state, entries, config, nowMs }).map(([key]) => key),
    ["hot", "cold-2"],
  );
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

test("syncOutboundMirrors skips rollout progress when app-server already owns live progress", async () => {
  const state = makeState(
    makeBinding({
      currentTurn: {
        progressSource: "app-server",
        progressItems: [{ text: "Thinking: from app-server", timestamp: "2026-04-19T10:00:00.000Z" }],
      },
    }),
  );
  const calls = [];
  const commentary = {
    role: "assistant",
    phase: "commentary",
    text: "Thinking: from rollout",
    signature: "c1",
    timestamp: "2026-04-19T10:00:01.000Z",
  };

  const result = await syncOutboundMirrors({
    config: makeConfig({ appServerStreamEnabled: true }),
    state,
    getThreadsByIdsFn: async () => [makeThread()],
    readThreadMirrorDeltaFn: async () => ({
      mirror: {
        rolloutPath: "/tmp/thread.jsonl",
        byteOffset: 102,
        partialLine: "",
        lastSignature: "c1",
      },
      messages: [commentary],
    }),
    upsertOutboundProgressMessageFn: async (...args) => {
      calls.push(args);
      return [];
    },
  });

  assert.deepEqual(result, { delivered: 0, suppressed: 1, changed: true });
  assert.deepEqual(calls, []);
  assert.equal(state.bindings[bindingKey].lastRolloutProgressSkippedAt, "2026-04-19T10:00:01.000Z");
  assert.equal(state.outboundMirrors[bindingKey].lastSignature, "c1");
});

test("syncOutboundMirrors sends generated images as Telegram photos", async () => {
  const state = makeState(makeBinding({ currentTurn: { startedAt: "2026-04-21T19:51:15.000Z" } }), {
    threadId: "thread-1",
    rolloutPath: "/tmp/thread.jsonl",
    replyTargetMessageId: 77,
  });
  const calls = [];
  const message = {
    role: "assistant",
    phase: "image_generation",
    text: "Generated image",
    media: [
      {
        type: "photo",
        source: "codex_image_generation",
        imageId: "ig_1",
        path: "/tmp/generated/ig_1.png",
        mimeType: "image/png",
      },
    ],
    signature: "img1",
    timestamp: "2026-04-21T19:52:43.000Z",
  };

  const result = await syncOutboundMirrors({
    config: makeConfig(),
    state,
    getThreadsByIdsFn: async () => [makeThread()],
    readThreadMirrorDeltaFn: async () => ({
      mirror: {
        rolloutPath: "/tmp/thread.jsonl",
        byteOffset: 103,
        partialLine: "",
        lastSignature: "img1",
      },
      messages: [message],
    }),
    sendPhotoFn: async (...args) => {
      calls.push(["photo", ...args]);
      return { message_id: 88 };
    },
    completeOutboundProgressMessageFn: async (...args) => {
      calls.push(["complete", ...args]);
      return [];
    },
    rememberOutboundFn: (binding, sent) => {
      binding.lastOutboundMessageIds = sent.map((item) => item.message_id);
    },
  });

  assert.deepEqual(result, { delivered: 1, suppressed: 0, changed: true });
  assert.equal(calls[0][0], "photo");
  assert.equal(calls[0][2].photoPath, "/tmp/generated/ig_1.png");
  assert.equal(calls[0][2].replyToMessageId, 77);
  assert.equal(calls[1][0], "complete");
  assert.equal(state.bindings[bindingKey].currentTurn, null);
  assert.equal(state.outboundMirrors[bindingKey].replyTargetMessageId, null);
  assert.deepEqual(state.bindings[bindingKey].lastOutboundMessageIds, [88]);
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
