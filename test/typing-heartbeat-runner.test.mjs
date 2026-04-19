import test from "node:test";
import assert from "node:assert/strict";

import {
  isTypingHeartbeatBindingEligible,
  syncTypingHeartbeats,
} from "../lib/typing-heartbeat-runner.mjs";

function makeBinding(overrides = {}) {
  return {
    threadId: "thread-1",
    chatId: "-1001",
    messageThreadId: 42,
    transport: "native",
    currentTurn: { startedAt: "2026-04-19T10:00:00.000Z" },
    ...overrides,
  };
}

function makeState(bindings = {}) {
  return { bindings };
}

test("isTypingHeartbeatBindingEligible requires typing, mirror eligibility and an active turn", () => {
  assert.equal(isTypingHeartbeatBindingEligible({}, makeBinding()), true);
  assert.equal(isTypingHeartbeatBindingEligible({ sendTyping: false }, makeBinding()), false);
  assert.equal(isTypingHeartbeatBindingEligible({ typingHeartbeatEnabled: false }, makeBinding()), false);
  assert.equal(isTypingHeartbeatBindingEligible({}, makeBinding({ currentTurn: null })), false);
  assert.equal(isTypingHeartbeatBindingEligible({}, makeBinding({ threadId: "" })), false);
  assert.equal(isTypingHeartbeatBindingEligible({}, makeBinding({ transport: "app-server" })), false);
});

test("syncTypingHeartbeats starts a heartbeat for eligible active bindings", () => {
  const calls = [];
  const heartbeats = new Map();
  const result = syncTypingHeartbeats({
    config: { botToken: "token", typingHeartbeatIntervalMs: 4000 },
    state: makeState({ "group:-1001:topic:42": makeBinding() }),
    heartbeats,
    startTypingHeartbeatFn: (options) => {
      calls.push(["start", options]);
      return { active: true, stop() {} };
    },
    logEventFn: (...args) => calls.push(["event", ...args]),
  });

  assert.deepEqual(result, { started: 1, stopped: 0, running: 1 });
  assert.equal(heartbeats.size, 1);
  assert.equal(calls[0][1].token, "token");
  assert.deepEqual(calls[0][1].target, { chatId: "-1001", messageThreadId: 42 });
  assert.equal(calls[1][1], "typing_heartbeat_start");
});

test("syncTypingHeartbeats does not duplicate an already running heartbeat", () => {
  const heartbeats = new Map([["group:-1001:topic:42", { stop() {} }]]);
  const result = syncTypingHeartbeats({
    config: {},
    state: makeState({ "group:-1001:topic:42": makeBinding() }),
    heartbeats,
    startTypingHeartbeatFn: () => {
      throw new Error("should not start twice");
    },
  });

  assert.deepEqual(result, { started: 0, stopped: 0, running: 1 });
});

test("syncTypingHeartbeats stops all running heartbeats when disabled", () => {
  let stopped = 0;
  const events = [];
  const heartbeats = new Map([
    ["a", { stop: () => (stopped += 1) }],
    ["b", { stop: () => (stopped += 1) }],
  ]);
  const result = syncTypingHeartbeats({
    config: { sendTyping: false },
    state: makeState(),
    heartbeats,
    stopTypingHeartbeatsFn: (items) => {
      let count = 0;
      for (const [key, heartbeat] of items.entries()) {
        heartbeat.stop();
        items.delete(key);
        count += 1;
      }
      return count;
    },
    logEventFn: (...args) => events.push(args),
  });

  assert.deepEqual(result, { started: 0, stopped: 2, running: 0 });
  assert.equal(stopped, 2);
  assert.equal(heartbeats.size, 0);
  assert.deepEqual(events, [["typing_heartbeats_stop_all", { stopped: 2, reason: "disabled" }]]);
});

test("syncTypingHeartbeats stops only the selected heartbeat when disabled with onlyBindingKey", () => {
  let stopped = 0;
  const heartbeats = new Map([
    ["a", { stop: () => (stopped += 1) }],
    ["b", { stop: () => (stopped += 1) }],
  ]);
  const result = syncTypingHeartbeats({
    config: { typingHeartbeatEnabled: false },
    state: makeState(),
    heartbeats,
    onlyBindingKey: "a",
    logEventFn: () => null,
  });

  assert.deepEqual(result, { started: 0, stopped: 1, running: 1 });
  assert.equal(stopped, 1);
  assert.deepEqual([...heartbeats.keys()], ["b"]);
});

test("syncTypingHeartbeats stops stale heartbeats that no longer have an active turn", () => {
  let stopped = 0;
  const events = [];
  const heartbeats = new Map([
    ["stale", { stop: () => (stopped += 1) }],
    ["active", { stop: () => (stopped += 1) }],
  ]);
  const result = syncTypingHeartbeats({
    config: {},
    state: makeState({
      stale: makeBinding({ currentTurn: null }),
      active: makeBinding({ threadId: "thread-2", chatId: "-1002", messageThreadId: 43 }),
    }),
    heartbeats,
    logEventFn: (...args) => events.push(args),
  });

  assert.deepEqual(result, { started: 0, stopped: 1, running: 1 });
  assert.equal(stopped, 1);
  assert.deepEqual([...heartbeats.keys()], ["active"]);
  assert.deepEqual(events, [["typing_heartbeat_stop", { bindingKey: "stale", reason: "idle" }]]);
});

test("syncTypingHeartbeats reports send errors through bridge events", () => {
  const events = [];
  syncTypingHeartbeats({
    config: {},
    state: makeState({ active: makeBinding() }),
    heartbeats: new Map(),
    startTypingHeartbeatFn: ({ onError }) => {
      onError(new Error("telegram down"));
      return { active: false, stop() {} };
    },
    logEventFn: (...args) => events.push(args),
  });

  assert.deepEqual(events, [
    [
      "typing_heartbeat_error",
      { bindingKey: "active", threadId: "thread-1", error: "telegram down" },
    ],
  ]);
});
