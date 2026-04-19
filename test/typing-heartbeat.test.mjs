import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTypingHeartbeatIntervalMs, startTypingHeartbeat, stopTypingHeartbeats } from "../lib/typing-heartbeat.mjs";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("normalizeTypingHeartbeatIntervalMs clamps into Telegram-friendly range", () => {
  assert.equal(normalizeTypingHeartbeatIntervalMs(250), 1000);
  assert.equal(normalizeTypingHeartbeatIntervalMs(9999), 5000);
  assert.equal(normalizeTypingHeartbeatIntervalMs("4000"), 4000);
  assert.equal(normalizeTypingHeartbeatIntervalMs("nope", 3000), 3000);
});

test("startTypingHeartbeat sends immediately and repeats until stopped", async () => {
  const calls = [];
  const heartbeat = startTypingHeartbeat({
    token: "token",
    target: { chatId: "-1001", messageThreadId: 3 },
    intervalMs: 1000,
    sendTyping: async (token, target) => {
      calls.push({ token, target });
    },
  });

  assert.equal(heartbeat.active, true);
  await wait(1100);
  heartbeat.stop();
  const callsAfterStop = calls.length;
  await wait(1100);

  assert.ok(callsAfterStop >= 2);
  assert.equal(calls.length, callsAfterStop);
  assert.deepEqual(calls[0], {
    token: "token",
    target: { chatId: "-1001", messageThreadId: 3 },
  });
});

test("startTypingHeartbeat swallows send errors and reports them", async () => {
  const errors = [];
  const heartbeat = startTypingHeartbeat({
    token: "token",
    target: { chatId: "-1001" },
    intervalMs: 1000,
    sendTyping: async () => {
      throw new Error("telegram hiccup");
    },
    onError(error) {
      errors.push(error.message);
    },
  });

  await wait(20);
  heartbeat.stop();

  assert.equal(heartbeat.active, true);
  assert.deepEqual(errors, ["telegram hiccup"]);
});

test("stopTypingHeartbeats stops and clears a heartbeat map", () => {
  let stopped = 0;
  const heartbeats = new Map([
    ["a", { stop: () => (stopped += 1) }],
    ["b", { stop: () => (stopped += 1) }],
  ]);

  assert.equal(stopTypingHeartbeats(heartbeats), 2);
  assert.equal(stopped, 2);
  assert.equal(heartbeats.size, 0);
});
