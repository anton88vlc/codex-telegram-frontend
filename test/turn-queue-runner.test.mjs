import test from "node:test";
import assert from "node:assert/strict";

import { drainTurnQueues, startQueuedTurn } from "../lib/turn-queue-runner.mjs";

const config = {
  botToken: "token",
  statePath: "/tmp/state.json",
  nativeHelperPath: "/tmp/app-control.js",
  nativeFallbackHelperPath: "/tmp/app-server.js",
  nativeTimeoutMs: 120000,
  nativeDebugBaseUrl: "http://127.0.0.1:9222",
  nativePollIntervalMs: 1000,
  nativeWaitForReply: false,
  turnQueueEnabled: true,
  sendTyping: false,
  typingHeartbeatEnabled: false,
};

function makeBinding(overrides = {}) {
  return {
    threadId: "thread-1",
    chatId: "-1001",
    messageThreadId: 3,
    transport: "native",
    turnQueue: [
      {
        id: "q1",
        prompt: "Run queued work",
        promptPreview: "Run queued work",
        replyToMessageId: 42,
        queueMessageId: 99,
      },
    ],
    ...overrides,
  };
}

test("startQueuedTurn edits queued receipt into Working and starts native send-only turn", async () => {
  const calls = {};
  const binding = makeBinding({ turnQueue: [] });
  const state = { bindings: { one: binding } };
  const result = await startQueuedTurn({
    config,
    state,
    bindingKey: "one",
    binding,
    queueItem: {
      id: "q1",
      prompt: "Run queued work",
      promptPreview: "Run queued work",
      replyToMessageId: 42,
      queueMessageId: 99,
    },
    captureWorktreeBaselineFn: async () => ({ head: "abc", summary: null }),
    editThenSendRichTextChunksFn: async (...args) => {
      (calls.edits ||= []).push(args);
      return [{ message_id: 99 }];
    },
    logEventFn: (...args) => (calls.events ||= []).push(args),
    refreshStatusBarsFn: async (...args) => (calls.status ||= []).push(args),
    rememberOutboundFn: (...args) => (calls.remembered ||= []).push(args),
    rememberOutboundMirrorSuppressionFn: (...args) => (calls.suppressions ||= []).push(args),
    saveStateFn: async (...args) => (calls.saves ||= []).push(args),
    sendNativeTurnFn: async (...args) => {
      (calls.native ||= []).push(args);
      return { transportPath: "app-control", mode: "send-only" };
    },
    shouldPreferAppServerFn: () => false,
    startProgressBubbleFn: (...args) => {
      (calls.progress ||= []).push(args);
      return { stop: async () => (calls.stops = (calls.stops || 0) + 1) };
    },
    subscribeAppServerStreamFn: async (...args) => (calls.subscriptions ||= []).push(args),
    syncTypingHeartbeatsFn: (...args) => (calls.typing ||= []).push(args),
    validateBindingForSendWithRescueFn: async ({ binding }) => ({
      ok: true,
      binding,
      thread: { id: "thread-1", cwd: "/repo", archived: 0 },
    }),
  });

  assert.deepEqual(result, { started: true });
  assert.equal(calls.edits[0][3], "Working...");
  assert.equal(calls.native[0][0].prompt, "Run queued work");
  assert.equal(binding.currentTurn.sendOnly, true);
  assert.equal(binding.currentTurn.codexProgressMessageId, 99);
  assert.equal(binding.lastInboundMessageId, 42);
  assert.equal(calls.suppressions[0][2], "Run queued work");
  assert.equal(calls.events.at(-1)[0], "queued_turn_started");
});

test("drainTurnQueues starts only idle non-paused bindings", async () => {
  const idle = makeBinding();
  const running = makeBinding({ currentTurn: { source: "telegram" } });
  const paused = makeBinding({ queuePaused: true });
  const state = {
    bindings: {
      idle,
      running,
      paused,
    },
  };
  const started = [];
  const result = await drainTurnQueues({
    config,
    state,
    startQueuedTurnFn: async ({ bindingKey, queueItem }) => {
      started.push({ bindingKey, queueItem });
      return { started: true };
    },
  });

  assert.deepEqual(result, { started: 1, changed: true });
  assert.equal(started[0].bindingKey, "idle");
  assert.equal(started[0].queueItem.prompt, "Run queued work");
  assert.equal(state.bindings.idle.turnQueue.length, 0);
  assert.equal(state.bindings.running.turnQueue.length, 1);
  assert.equal(state.bindings.paused.turnQueue.length, 1);
});
