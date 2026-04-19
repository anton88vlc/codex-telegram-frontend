import { normalizeText } from "./message-routing.mjs";

export const DEFAULT_OUTBOUND_PROGRESS_MODE = "updates";
const MAX_PROGRESS_ITEMS = 4;
const PROGRESS_ITEM_LIMIT = 500;
const PLAN_TEXT_LIMIT = 1000;
const VERBATIM_PROGRESS_LIMIT = 1200;

export function normalizeOutboundProgressMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["generic", "updates", "verbatim"].includes(normalized)) {
    return normalized;
  }
  return DEFAULT_OUTBOUND_PROGRESS_MODE;
}

export function compactProgressMirrorText(text, { limit = VERBATIM_PROGRESS_LIMIT } = {}) {
  const normalized = normalizeText(text).replace(/\r\n/g, "\n");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
}

export function formatProgressTimestamp(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeProgressItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      text: compactProgressMirrorText(item?.text, { limit: PROGRESS_ITEM_LIMIT }),
      timestamp: item?.timestamp ?? null,
    }))
    .filter((item) => item.text);
}

export function appendOutboundProgressItem(currentTurn, message, { limit = MAX_PROGRESS_ITEMS } = {}) {
  const existing = normalizeProgressItems(currentTurn?.progressItems);
  const text = compactProgressMirrorText(message?.text, { limit: PROGRESS_ITEM_LIMIT });
  if (!text) {
    return existing.slice(-limit);
  }

  const last = existing.at(-1);
  const next = last?.text === text ? existing : [...existing, { text, timestamp: message?.timestamp ?? null }];
  return next.slice(-limit);
}

function quoteProgressItem(text) {
  return compactProgressMirrorText(text, { limit: PROGRESS_ITEM_LIMIT })
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

function normalizePlanText(text) {
  return compactProgressMirrorText(text, { limit: PLAN_TEXT_LIMIT });
}

function normalizeChangedFilesText(text) {
  return compactProgressMirrorText(text, { limit: PLAN_TEXT_LIMIT });
}

function formatGenericProgress(message, { completed = false } = {}) {
  const timestamp = formatProgressTimestamp(message?.timestamp);
  return [
    "**Progress**",
    completed ? "Done. Final answer below." : "Codex is working...",
    timestamp ? `last activity: ${timestamp}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatUpdatesProgress({ currentTurn = null, message = null, completed = false } = {}) {
  const planText = normalizePlanText(currentTurn?.planText);
  const changedFilesText = normalizeChangedFilesText(currentTurn?.changedFilesText);
  const storedItems = normalizeProgressItems(currentTurn?.progressItems);
  const items = storedItems.length
    ? storedItems
    : normalizeProgressItems([{ text: message?.text, timestamp: message?.timestamp }]);
  const latestTimestamp = items.at(-1)?.timestamp || message?.timestamp || null;
  const timestamp = formatProgressTimestamp(latestTimestamp);
  const footer = ["**Progress**"];
  if (completed) {
    footer.push("Done. Final answer below.");
  } else if (timestamp) {
    footer.push(`last activity: ${timestamp}`);
  } else {
    footer.push("Codex is working...");
  }

  const lines = [];
  if (items.length) {
    lines.push(items.map((item) => quoteProgressItem(item.text)).join("\n\n"));
  }
  if (planText) {
    lines.push(planText);
  }
  if (changedFilesText) {
    lines.push(changedFilesText);
  }
  lines.push(footer.join("\n"));
  return lines.join("\n\n");
}

export function formatOutboundProgressMirrorText({ message = null, currentTurn = null, config = {}, completed = false } = {}) {
  const mode = normalizeOutboundProgressMode(config.outboundProgressMode);
  const rawText = compactProgressMirrorText(message?.text);

  if (mode === "generic") {
    return formatGenericProgress(message, { completed });
  }

  if (mode === "verbatim") {
    if (completed) {
      return rawText ? `**Progress**\nDone. Final answer below.\n\n${rawText}` : "**Progress**\nDone. Final answer below.";
    }
    return rawText ? `**Progress**\n${rawText}` : "";
  }

  return formatUpdatesProgress({
    currentTurn,
    message,
    completed,
  });
}
