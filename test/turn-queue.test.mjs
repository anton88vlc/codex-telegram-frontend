import test from "node:test";
import assert from "node:assert/strict";

import {
  clearTurnQueue,
  dequeueNextTurn,
  enqueueTurn,
  formatQueueList,
  formatQueuedTurnReceipt,
  makeTurnQueueItem,
  restoreQueuedTurnFront,
  setQueuedTurnReceipt,
} from "../lib/turn-queue.mjs";

test("turn queue enqueues, updates receipt and dequeues in order", () => {
  const binding = {};
  const item = makeTurnQueueItem({
    prompt: "Run tests",
    message: { message_id: 10 },
    promptPreview: "Run tests",
    now: "2026-04-20T08:00:00.000Z",
  });

  const queued = enqueueTurn(binding, item, { maxItems: 2 });
  assert.equal(queued.ok, true);
  assert.equal(queued.position, 1);
  assert.equal(formatQueuedTurnReceipt(queued), "Queued. I'll run this next.");

  setQueuedTurnReceipt(binding, item.id, 99);
  assert.equal(binding.turnQueue[0].queueMessageId, 99);

  const next = dequeueNextTurn(binding);
  assert.equal(next.prompt, "Run tests");
  assert.equal(next.queueMessageId, 99);
  assert.deepEqual(binding.turnQueue, []);
});

test("turn queue can be restored, rendered and cleared", () => {
  const binding = {
    currentTurn: { source: "telegram" },
  };
  restoreQueuedTurnFront(binding, {
    id: "q1",
    prompt: "First queued prompt",
    promptPreview: "First queued prompt",
  });

  const text = formatQueueList(binding);
  assert.match(text, /active: yes/);
  assert.match(text, /queued: 1/);
  assert.match(text, /First queued prompt/);
  assert.equal(clearTurnQueue(binding), 1);
  assert.deepEqual(binding.turnQueue, []);
});
