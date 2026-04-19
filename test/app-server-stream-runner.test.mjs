import test from "node:test";
import assert from "node:assert/strict";

import {
  appServerLineKey,
  getAppServerPatch,
  makeAppServerLiveStream,
  subscribeAppServerStream,
  syncAppServerStreamProgress,
  syncAppServerStreamSubscriptions,
} from "../lib/app-server-stream-runner.mjs";

test("makeAppServerLiveStream builds a stream when enabled", () => {
  const events = [];
  class FakeStream {
    constructor(options) {
      this.options = options;
    }
  }
  const stream = makeAppServerLiveStream(
    {
      appServerUrl: "ws://127.0.0.1:27890",
      appServerStreamConnectTimeoutMs: 100,
      appServerStreamReconnectMs: 200,
      appServerStreamMaxEvents: 10,
    },
    {
      AppServerLiveStreamClass: FakeStream,
      logEventFn: (type, payload) => events.push({ type, payload }),
    },
  );

  assert.equal(stream.options.url, "ws://127.0.0.1:27890");
  stream.options.onStatus({ status: "connected" });
  assert.deepEqual(events, [{ type: "app_server_stream_status", payload: { status: "connected" } }]);
  assert.equal(makeAppServerLiveStream({ appServerStreamEnabled: false }), null);
});

test("subscribeAppServerStream reports subscribe failures without throwing", async () => {
  const events = [];
  const ok = await subscribeAppServerStream({
    config: {},
    stream: {
      subscribe: async (threadId) => {
        assert.equal(threadId, "thread-1");
        throw new Error("offline");
      },
    },
    bindingKey: "binding-1",
    binding: { threadId: "thread-1" },
    logEventFn: (type, payload) => events.push({ type, payload }),
  });

  assert.equal(ok, false);
  assert.equal(events[0].type, "app_server_stream_subscribe_error");
  assert.equal(events[0].payload.threadId, "thread-1");
});

test("syncAppServerStreamSubscriptions subscribes active bindings with current turns", async () => {
  const subscribed = [];
  const result = await syncAppServerStreamSubscriptions({
    config: {},
    state: {
      bindings: {
        one: { threadId: "thread-1", chatId: "-1001", currentTurn: {} },
        two: { threadId: "thread-2", chatId: "-1001" },
      },
    },
    stream: {},
    subscribeAppServerStreamFn: async ({ binding }) => {
      subscribed.push(binding.threadId);
      return true;
    },
  });

  assert.deepEqual(result, { subscribed: 1 });
  assert.deepEqual(subscribed, ["thread-1"]);
});

test("app-server patch helpers keep deterministic buckets", () => {
  const patches = new Map();
  const patch = getAppServerPatch(patches, "binding-1");
  patch.eventCount += 1;
  assert.equal(getAppServerPatch(patches, "binding-1").eventCount, 1);
  assert.equal(appServerLineKey({ category: "reasoning", itemId: "item-1" }), "reasoning:item-1");
});

test("syncAppServerStreamProgress converts stream events into progress updates", async () => {
  const state = {
    bindings: {
      "binding-1": {
        threadId: "thread-1",
        chatId: "-1001",
        messageThreadId: 42,
        currentTurn: {},
        lastInboundMessageId: 7,
      },
    },
  };
  const calls = [];
  const result = await syncAppServerStreamProgress({
    config: { botToken: "token", threadsDbPath: "/tmp/threads.sqlite" },
    state,
    stream: {
      drainEvents: () => [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          category: "reasoning",
          method: "item/reasoning/textDelta",
          itemId: "reason-1",
          deltaText: "Checking ",
          ts: "2026-04-19T10:00:00.000Z",
        },
        {
          threadId: "thread-1",
          turnId: "turn-1",
          category: "reasoning",
          method: "item/reasoning/textDelta",
          itemId: "reason-1",
          deltaText: "repo",
          ts: "2026-04-19T10:00:01.000Z",
        },
      ],
    },
    getThreadsByIdsFn: async (dbPath, threadIds) => {
      calls.push(["threads", dbPath, threadIds]);
      return [{ id: "thread-1", rollout_path: "/tmp/rollout.jsonl" }];
    },
    loadChangedFilesTextForThreadFn: async ({ thread, binding }) => {
      calls.push(["changed", thread.id, binding.threadId]);
      return "**Changed files**\n1 file changed +1 -0";
    },
    upsertOutboundProgressMessageFn: async ({ target, replyToMessageId, message, changedFilesText }) => {
      calls.push(["upsert", target, replyToMessageId, message, changedFilesText]);
      return [{ message_id: 99 }];
    },
    rememberOutboundFn: (binding, sent) => {
      calls.push(["remember", binding.threadId, sent[0].message_id]);
    },
    logEventFn: (type, payload) => calls.push(["event", type, payload]),
  });

  assert.deepEqual(result, { changed: true, applied: 1, events: 2 });
  assert.equal(state.bindings["binding-1"].currentTurn.appServerTurnId, "turn-1");
  assert.equal(state.bindings["binding-1"].lastAppServerStreamAt, "2026-04-19T10:00:01.000Z");
  const upsert = calls.find((call) => call[0] === "upsert");
  assert.deepEqual(upsert[1], { chatId: "-1001", messageThreadId: 42 });
  assert.equal(upsert[2], 7);
  assert.match(upsert[3].text, /Thinking: Checking repo/);
  assert.match(upsert[4], /Changed files/);
  assert.equal(calls.find((call) => call[0] === "event")?.[1], "app_server_stream_progress");
});

test("syncAppServerStreamProgress ignores empty streams", async () => {
  const result = await syncAppServerStreamProgress({
    config: {},
    state: {},
    stream: { drainEvents: () => [] },
  });
  assert.deepEqual(result, { changed: false, applied: 0, events: 0 });
});
