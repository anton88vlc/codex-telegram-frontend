import test from "node:test";
import assert from "node:assert/strict";

import {
  fileSizeOrZero,
  prepareOutboundMirrorAtFileEnd,
  validateBindingForSend,
  validateBindingForSendWithRescue,
} from "../lib/binding-send-validation.mjs";

const config = { threadsDbPath: "/repo/state/threads.sqlite" };

test("validateBindingForSend blocks parked sync topics before DB lookup", async () => {
  let lookedUp = false;
  const result = await validateBindingForSend(
    config,
    { threadId: "thread-1" },
    {
      isClosedSyncBindingFn: () => true,
      getThreadByIdFn: async () => {
        lookedUp = true;
      },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /sync-managed topic is parked/);
  assert.equal(lookedUp, false);
});

test("validateBindingForSend allows optional private Chat bindings while DB catches up", async () => {
  const events = [];
  const result = await validateBindingForSend(
    config,
    {
      threadId: "new-chat",
      chatId: "42",
      messageThreadId: 7,
      createdBy: "private-topic-auto",
      surface: "chat",
    },
    {
      getThreadByIdFn: async () => null,
      isThreadDbOptionalBindingFn: () => true,
      logEventFn: (...args) => events.push(args),
    },
  );

  assert.deepEqual(result, { ok: true, thread: null });
  assert.equal(events[0][0], "binding_thread_db_pending");
  assert.equal(events[0][1].threadId, "new-chat");
});

test("validateBindingForSend reports missing regular threads and logs DB errors", async () => {
  const missing = await validateBindingForSend(
    config,
    { threadId: "missing" },
    {
      getThreadByIdFn: async () => null,
      isThreadDbOptionalBindingFn: () => false,
    },
  );
  assert.equal(missing.ok, false);
  assert.match(missing.message, /no longer in the local Codex DB/);

  const events = [];
  const errored = await validateBindingForSend(
    config,
    { threadId: "flaky" },
    {
      getThreadByIdFn: async () => {
        throw new Error("sqlite locked");
      },
      logEventFn: (...args) => events.push(args),
    },
  );
  assert.deepEqual(errored, { ok: true, thread: null });
  assert.equal(events[0][0], "binding_validation_error");
  assert.match(events[0][1].error, /sqlite locked/);
});

test("prepareOutboundMirrorAtFileEnd starts mirror from the end of rollout file", () => {
  const state = {};
  const calls = [];

  prepareOutboundMirrorAtFileEnd(
    state,
    "binding-key",
    { id: "thread-2", rollout_path: "/tmp/rollout.jsonl" },
    {
      fileSizeFn: () => 123,
      removeOutboundMirrorFn: (...args) => calls.push(["remove", ...args]),
      setOutboundMirrorFn: (targetState, key, payload) => {
        calls.push(["set", key, payload]);
        targetState.mirror = payload;
      },
    },
  );

  assert.equal(calls[0][0], "set");
  assert.equal(state.mirror.threadId, "thread-2");
  assert.equal(state.mirror.byteOffset, 123);

  prepareOutboundMirrorAtFileEnd(
    state,
    "binding-key",
    { id: "thread-3" },
    {
      removeOutboundMirrorFn: (...args) => calls.push(["remove", ...args]),
      setOutboundMirrorFn: () => assert.fail("should not set mirror without rollout path"),
    },
  );
  assert.equal(calls.at(-1)[0], "remove");
});

test("fileSizeOrZero keeps missing or weird files harmless", () => {
  assert.equal(fileSizeOrZero(null), 0);
  assert.equal(fileSizeOrZero("/missing", { statFn: () => { throw new Error("missing"); } }), 0);
  assert.equal(fileSizeOrZero("/file", { statFn: () => ({ size: "5" }) }), 5);
});

test("validateBindingForSendWithRescue rebinds archived topics to a single successor", async () => {
  const state = { bindings: {} };
  const events = [];
  const oldThread = {
    id: "old",
    title: "Same thread",
    cwd: "/repo",
    archived: 1,
  };
  const successor = {
    id: "new",
    title: "Same thread",
    cwd: "/repo",
    archived: 0,
    rollout_path: "/tmp/rollout.jsonl",
  };

  const result = await validateBindingForSendWithRescue({
    config,
    state,
    bindingKey: "binding-key",
    binding: { threadId: "old", threadTitle: "Same thread" },
    getThreadByIdFn: async () => oldThread,
    findActiveThreadSuccessorsFn: async (dbPath, thread, options) => {
      assert.equal(dbPath, config.threadsDbPath);
      assert.equal(thread.id, "old");
      assert.deepEqual(options, { limit: 3 });
      return [successor];
    },
    prepareOutboundMirrorAtFileEndFn: (targetState, key, thread) => {
      targetState.mirror = { key, threadId: thread.id };
    },
    setBindingFn: (targetState, key, payload) => {
      targetState.bindings[key] = payload;
      return payload;
    },
    logEventFn: (...args) => events.push(args),
    now: "2026-04-19T12:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.thread.id, "new");
  assert.equal(result.binding.threadId, "new");
  assert.equal(state.bindings["binding-key"].reboundFromThreadId, "old");
  assert.equal(state.bindings["binding-key"].reboundAt, "2026-04-19T12:00:00.000Z");
  assert.deepEqual(state.mirror, { key: "binding-key", threadId: "new" });
  assert.equal(events.at(-1)[0], "binding_archived_rescued");
});

test("validateBindingForSendWithRescue refuses ambiguous archived replacements", async () => {
  const events = [];
  const result = await validateBindingForSendWithRescue({
    config,
    state: {},
    bindingKey: "binding-key",
    binding: { threadId: "old" },
    getThreadByIdFn: async () => ({ id: "old", archived: 1 }),
    findActiveThreadSuccessorsFn: async () => [
      { id: "one", title: "One", cwd: "/repo" },
      { id: "two", title: "Two", cwd: "/repo" },
    ],
    logEventFn: (...args) => events.push(args),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /2 possible active replacements/);
  assert.equal(events.at(-1)[0], "binding_archived_rescue_ambiguous");
  assert.equal(events.at(-1)[1].candidates.length, 2);
});
