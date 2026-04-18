import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { normalizeText } from "./message-routing.mjs";

const DEFAULT_TAIL_BYTES = 512 * 1024;
const TIME_ZONE = "Europe/Madrid";

function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "n/a";
  }
  const absolute = Math.abs(number);
  if (absolute >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}m`;
  }
  if (absolute >= 1_000) {
    return `${Math.round(number / 1_000)}k`;
  }
  return String(Math.round(number));
}

function formatPercent(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "n/a";
  }
  return `${number.toFixed(digits)}%`;
}

function formatLocalTimeFromMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return "n/a";
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(number));
}

function formatLocalTimeFromSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return "n/a";
  }
  return formatLocalTimeFromMs(number * 1000);
}

function formatDurationUntilSeconds(value, { nowMs = Date.now() } = {}) {
  const resetAtMs = Number(value) * 1000;
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) {
    return "n/a";
  }
  const diffMs = Math.max(0, resetAtMs - nowMs);
  const totalMinutes = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatContext(runtime) {
  const contextWindow = runtime?.modelContextWindow;
  const lastTokens = runtime?.lastTokenUsage?.total_tokens ?? runtime?.lastTokenUsage?.input_tokens ?? null;
  if (!Number.isFinite(Number(contextWindow)) || !Number.isFinite(Number(lastTokens)) || Number(contextWindow) <= 0) {
    return "n/a";
  }
  const percent = Math.min(999, (Number(lastTokens) / Number(contextWindow)) * 100);
  return `${formatCompactNumber(lastTokens)} / ${formatCompactNumber(contextWindow)} (${formatPercent(percent)})`;
}

function formatRateLimit(limit, { label, nowMs = Date.now() } = {}) {
  if (!limit || typeof limit !== "object") {
    return `${label || "limit"}: n/a`;
  }
  const remaining = Math.max(0, 100 - Number(limit.used_percent));
  const windowMinutes = Number(limit.window_minutes);
  const windowLabel =
    label ||
    (Number.isFinite(windowMinutes) ? (windowMinutes >= 60 ? `${Math.round(windowMinutes / 60)}h` : `${windowMinutes}m`) : "limit");
  const reset = formatLocalTimeFromSeconds(limit.resets_at);
  const until = formatDurationUntilSeconds(limit.resets_at, { nowMs });
  return `${windowLabel}: ${formatPercent(remaining)} left, reset ${reset} (${until})`;
}

function formatCompactStatus(binding, config) {
  const pinned = binding?.statusBarMessageId ? "pinned" : "unpinned";
  const activity = binding?.currentTurn ? "running" : "idle";
  const activityTime = formatActivityTime(binding);
  const activityLabel = activityTime ? `${activity} ${activityTime}` : activity;
  const mirror = config.outboundSyncEnabled === false ? "mirror off" : "mirror on";
  return `${pinned}, ${activityLabel}, ${mirror}`;
}

function formatActivityTime(binding) {
  const progressItems = Array.isArray(binding?.currentTurn?.progressItems) ? binding.currentTurn.progressItems : [];
  const timestamp =
    progressItems.at(-1)?.timestamp || binding?.currentTurn?.startedAt || binding?.lastMirroredAt || binding?.updatedAt || null;
  if (!timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const formatted = formatLocalTimeFromMs(parsed);
  return formatted === "n/a" ? null : formatted;
}

export function makeStatusBarHash(text) {
  return createHash("sha1").update(String(text ?? "")).digest("hex");
}

export function extractRuntimeStatusFromLine(line) {
  const normalizedLine = String(line ?? "").trim();
  if (!normalizedLine) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(normalizedLine);
  } catch {
    return null;
  }

  if (parsed?.type !== "event_msg" || parsed?.payload?.type !== "token_count") {
    return null;
  }

  const payload = parsed.payload;
  return {
    timestamp: parsed.timestamp ?? null,
    totalTokenUsage: payload.info?.total_token_usage ?? null,
    lastTokenUsage: payload.info?.last_token_usage ?? null,
    modelContextWindow: payload.info?.model_context_window ?? null,
    rateLimits: payload.rate_limits ?? null,
  };
}

export function extractLatestRuntimeStatus(text) {
  let latest = null;
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const parsed = extractRuntimeStatusFromLine(line);
    if (parsed) {
      latest = parsed;
    }
  }
  return latest;
}

export async function readRolloutRuntimeStatus(rolloutPath, { tailBytes = DEFAULT_TAIL_BYTES } = {}) {
  const normalizedPath = normalizeText(rolloutPath);
  if (!normalizedPath) {
    return null;
  }

  let stats;
  try {
    stats = await fs.stat(normalizedPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const size = Number(stats.size) || 0;
  const limit = Math.max(1024, Number(tailBytes) || DEFAULT_TAIL_BYTES);
  const offset = Math.max(0, size - limit);
  const handle = await fs.open(normalizedPath, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return extractLatestRuntimeStatus(text);
  } finally {
    await handle.close();
  }
}

export function buildStatusBarText({ binding, thread, runtime = null, config = {}, nowMs = Date.now() }) {
  const model = normalizeText(thread?.model) || normalizeText(thread?.model_provider) || "n/a";
  const reasoning = normalizeText(thread?.reasoning_effort) || "n/a";
  const runtimeRateLimits = runtime?.rateLimits ?? {};

  const lines = [`${model} | ${reasoning}`, `context: ${formatContext(runtime)}`];
  const rates = [
    formatRateLimit(runtimeRateLimits.primary, { label: "5h", nowMs }),
    formatRateLimit(runtimeRateLimits.secondary, { label: "week", nowMs }),
  ].filter((item) => !item.endsWith(": n/a"));
  if (rates.length) {
    lines.push(rates.join("; "));
  }
  lines.push(`status: ${formatCompactStatus(binding, config)}`);

  return lines.join("\n");
}
