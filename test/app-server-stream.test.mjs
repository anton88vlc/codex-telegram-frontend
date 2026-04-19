import test from "node:test";
import assert from "node:assert/strict";

import {
  categorizeAppServerMethod,
  normalizeAppServerNotification,
  shouldKeepAppServerStreamEvent,
  summarizeAppServerStreamEvents,
} from "../lib/app-server-stream.mjs";

test("categorizeAppServerMethod groups stream events by Telegram UX use", () => {
  assert.equal(categorizeAppServerMethod("item/agentMessage/delta"), "agent_delta");
  assert.equal(categorizeAppServerMethod("item/reasoning/textDelta"), "reasoning");
  assert.equal(categorizeAppServerMethod("turn/plan/updated"), "plan");
  assert.equal(categorizeAppServerMethod("turn/diff/updated"), "diff");
  assert.equal(categorizeAppServerMethod("thread/tokenUsage/updated"), "token_usage");
  assert.equal(categorizeAppServerMethod("account/rateLimits/updated"), "rate_limits");
});

test("normalizeAppServerNotification extracts stable event fields", () => {
  const event = normalizeAppServerNotification(
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "hello",
      },
    },
    { ts: "2026-04-19T00:00:00.000Z" },
  );

  assert.equal(event.type, "app_server_stream_event");
  assert.equal(event.ts, "2026-04-19T00:00:00.000Z");
  assert.equal(event.category, "agent_delta");
  assert.equal(event.threadId, "thread-1");
  assert.equal(event.turnId, "turn-1");
  assert.equal(event.itemId, "item-1");
  assert.equal(event.deltaChars, 5);
  assert.equal(event.textPreview, "hello");
});

test("shouldKeepAppServerStreamEvent filters by thread and turn while keeping global rate limits", () => {
  const target = normalizeAppServerNotification({
    method: "turn/plan/updated",
    params: { threadId: "thread-1", turnId: "turn-1", plan: [{ step: "ship", status: "in_progress" }] },
  });
  const other = normalizeAppServerNotification({
    method: "turn/plan/updated",
    params: { threadId: "thread-2", turnId: "turn-1", plan: [] },
  });
  const rate = normalizeAppServerNotification({
    method: "account/rateLimits/updated",
    params: { rateLimits: {} },
  });

  assert.equal(shouldKeepAppServerStreamEvent(target, { threadId: "thread-1", turnId: "turn-1" }), true);
  assert.equal(shouldKeepAppServerStreamEvent(other, { threadId: "thread-1", turnId: "turn-1" }), false);
  assert.equal(shouldKeepAppServerStreamEvent(rate, { threadId: "thread-1", turnId: "turn-1" }), true);
});

test("summarizeAppServerStreamEvents reports useful probe signals", () => {
  const events = [
    normalizeAppServerNotification({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    }),
    normalizeAppServerNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "abc" },
    }),
    normalizeAppServerNotification({
      method: "item/reasoning/textDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2", delta: "think" },
    }),
    normalizeAppServerNotification({
      method: "turn/diff/updated",
      params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git" },
    }),
    normalizeAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-3", text: "done", phase: "final_answer" },
      },
    }),
    normalizeAppServerNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    }),
  ];

  const summary = summarizeAppServerStreamEvents(events);

  assert.equal(summary.total, 6);
  assert.equal(summary.agentDeltaChars, 3);
  assert.equal(summary.reasoningDeltaChars, 5);
  assert.equal(summary.diffDeltaChars, 10);
  assert.equal(summary.finalAgentMessages, 1);
  assert.equal(summary.completedTurns, 1);
  assert.equal(summary.latestTurnId, "turn-1");
  assert.equal(summary.sawStreamingSignal, true);
});
