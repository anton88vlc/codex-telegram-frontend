import { normalizeText } from "./message-routing.mjs";

export const DEFAULT_TURN_QUEUE_MAX_ITEMS = 10;

function nowId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeTurnQueue(binding) {
  return (Array.isArray(binding?.turnQueue) ? binding.turnQueue : [])
    .map((item) => ({
      id: normalizeText(item?.id) || nowId(),
      prompt: normalizeText(item?.prompt),
      promptPreview: normalizeText(item?.promptPreview),
      sourceMessageId: Number.isInteger(item?.sourceMessageId) ? item.sourceMessageId : null,
      replyToMessageId: Number.isInteger(item?.replyToMessageId) ? item.replyToMessageId : null,
      queueMessageId: Number.isInteger(item?.queueMessageId) ? item.queueMessageId : null,
      createdAt: normalizeText(item?.createdAt),
      queuedAt: normalizeText(item?.queuedAt),
    }))
    .filter((item) => item.prompt);
}

export function getTurnQueueLength(binding) {
  return normalizeTurnQueue(binding).length;
}

export function makeTurnQueueItem({ prompt, message, replyMessage = message, promptPreview, now = new Date().toISOString() }) {
  const sourceMessageId = Number.isInteger(message?.message_id) ? message.message_id : null;
  const replyToMessageId = Number.isInteger(replyMessage?.message_id) ? replyMessage.message_id : sourceMessageId;
  return {
    id: `${sourceMessageId || "msg"}-${nowId()}`,
    prompt: normalizeText(prompt),
    promptPreview: normalizeText(promptPreview) || normalizeText(prompt).slice(0, 120),
    sourceMessageId,
    replyToMessageId,
    queueMessageId: null,
    createdAt: now,
    queuedAt: now,
  };
}

export function enqueueTurn(binding, item, { maxItems = DEFAULT_TURN_QUEUE_MAX_ITEMS } = {}) {
  const queue = normalizeTurnQueue(binding);
  const limit = Math.max(1, Number(maxItems) || DEFAULT_TURN_QUEUE_MAX_ITEMS);
  if (queue.length >= limit) {
    return {
      ok: false,
      reason: "full",
      length: queue.length,
      maxItems: limit,
    };
  }
  const nextItem = {
    ...item,
    prompt: normalizeText(item?.prompt),
  };
  if (!nextItem.prompt) {
    return {
      ok: false,
      reason: "empty",
      length: queue.length,
      maxItems: limit,
    };
  }
  queue.push(nextItem);
  binding.turnQueue = queue;
  return {
    ok: true,
    item: nextItem,
    position: queue.length,
    length: queue.length,
    maxItems: limit,
  };
}

export function setQueuedTurnReceipt(binding, itemId, messageId) {
  if (!Number.isInteger(messageId)) {
    return null;
  }
  const queue = normalizeTurnQueue(binding);
  const item = queue.find((candidate) => candidate.id === itemId);
  if (!item) {
    return null;
  }
  item.queueMessageId = messageId;
  binding.turnQueue = queue;
  return item;
}

export function dequeueNextTurn(binding) {
  const queue = normalizeTurnQueue(binding);
  const item = queue.shift() || null;
  binding.turnQueue = queue;
  return item;
}

export function restoreQueuedTurnFront(binding, item) {
  const queue = normalizeTurnQueue(binding);
  if (item?.prompt) {
    binding.turnQueue = [item, ...queue.filter((candidate) => candidate.id !== item.id)];
  } else {
    binding.turnQueue = queue;
  }
}

export function clearTurnQueue(binding) {
  const count = getTurnQueueLength(binding);
  binding.turnQueue = [];
  binding.queuePaused = false;
  delete binding.queueLastError;
  delete binding.queueLastErrorAt;
  return count;
}

export function formatQueuedTurnReceipt({ position }) {
  return position <= 1 ? "Queued. I'll run this next." : `Queued #${position}.`;
}

export function formatQueueFull({ maxItems }) {
  return `Queue is full (${maxItems}). Let Codex finish something, or run /cancel-queue.`;
}

export function formatQueueList(binding) {
  const queue = normalizeTurnQueue(binding);
  const lines = ["**Queue**"];
  lines.push(`active: ${binding?.currentTurn ? "yes" : "no"}`);
  lines.push(`queued: ${queue.length}`);
  if (binding?.queuePaused) {
    lines.push("paused: yes");
  }
  if (binding?.queueLastError) {
    lines.push(`last error: ${normalizeText(binding.queueLastError)}`);
  }
  if (queue.length) {
    lines.push("");
    queue.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.promptPreview || item.prompt.slice(0, 80)}`);
    });
  }
  return lines.join("\n");
}
