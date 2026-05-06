import test from "node:test";
import assert from "node:assert/strict";

import {
  createTelegramRateLimitGate,
  parseTelegramRetryAfterSeconds,
} from "../lib/telegram-rate-limit.mjs";

test("parseTelegramRetryAfterSeconds detects Bot API flood-control errors", () => {
  assert.equal(
    parseTelegramRetryAfterSeconds(new Error("telegram editMessageText failed: Too Many Requests: retry after 41")),
    41,
  );
  assert.equal(parseTelegramRetryAfterSeconds(new Error("telegram sendMessage failed: Bad Request")), null);
});

test("telegram rate-limit gate marks cooldown and throttles skip logs", () => {
  let nowMs = Date.parse("2026-05-06T10:00:00.000Z");
  const events = [];
  const gate = createTelegramRateLimitGate({
    nowMsFn: () => nowMs,
    retryPaddingMs: 0,
    logEventFn: (type, payload) => events.push({ type, payload }),
  });

  assert.equal(gate.mark(new Error("Too Many Requests: retry after 10"), { stage: "status_bar" }), true);
  assert.equal(gate.isActive(), true);
  assert.equal(gate.remainingMs(), 10_000);
  assert.equal(gate.logSkip("outbound_mirror"), true);
  assert.equal(gate.logSkip("draft_stream"), true);
  assert.equal(events.filter((event) => event.type === "telegram_rate_limit_skip").length, 1);

  nowMs += 31_000;
  assert.equal(gate.isActive(), false);
});

test("telegram rate-limit gate backs off repeated flood-control errors", () => {
  let nowMs = Date.parse("2026-05-06T10:00:00.000Z");
  const events = [];
  const gate = createTelegramRateLimitGate({
    nowMsFn: () => nowMs,
    retryPaddingMs: 0,
    logEventFn: (type, payload) => events.push({ type, payload }),
  });

  assert.equal(gate.mark(new Error("Too Many Requests: retry after 10")), true);
  nowMs += 11_000;
  assert.equal(gate.mark(new Error("Too Many Requests: retry after 10")), true);

  assert.equal(gate.remainingMs(), 20_000);
  assert.equal(events.at(-1).payload.retryMultiplier, 2);
});
