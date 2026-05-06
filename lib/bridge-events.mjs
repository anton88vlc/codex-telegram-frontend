import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_TAIL_BYTES = 256 * 1024;
const DEFAULT_EVENT_LIMIT = 200;
export const DEFAULT_EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

let currentEventLogPath = null;
let currentEventLogMaxBytes = DEFAULT_EVENT_LOG_MAX_BYTES;
const ensuredEventLogDirs = new Set();

export function configureBridgeEventLog(config) {
  currentEventLogPath = String(config?.eventLogPath ?? "").trim() || null;
  currentEventLogMaxBytes = normalizeEventLogMaxBytes(config?.eventLogMaxBytes);
}

export function normalizeEventLogMaxBytes(value, fallback = DEFAULT_EVENT_LOG_MAX_BYTES) {
  if (value === false || value === 0) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(64 * 1024, Math.floor(parsed));
}

export function maybeRotateEventLogSync(logPath, { maxBytes = DEFAULT_EVENT_LOG_MAX_BYTES } = {}) {
  if (!logPath || !maxBytes) {
    return false;
  }
  let stats;
  try {
    stats = statSync(logPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if ((Number(stats.size) || 0) < maxBytes) {
    return false;
  }
  const rotatedPath = `${logPath}.1`;
  try {
    unlinkSync(rotatedPath);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }
  renameSync(logPath, rotatedPath);
  return true;
}

function appendBridgeEventToFile(line, eventType = "unknown") {
  if (!currentEventLogPath) {
    return;
  }
  try {
    const dir = path.dirname(currentEventLogPath);
    if (!ensuredEventLogDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      ensuredEventLogDirs.add(dir);
    }
    maybeRotateEventLogSync(currentEventLogPath, { maxBytes: currentEventLogMaxBytes });
    appendFileSync(currentEventLogPath, `${line}\n`, "utf8");
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: "event_log_write_error",
        eventType,
        path: currentEventLogPath,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}

export function logBridgeEvent(type, payload = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
  process.stderr.write(`${line}\n`);
  appendBridgeEventToFile(line, type);
}

function isBridgeEvent(value) {
  return Boolean(value && typeof value === "object" && typeof value.type === "string");
}

function countBraceDelta(line) {
  let delta = 0;
  let inString = false;
  let escaped = false;
  for (const char of String(line)) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") delta += 1;
    if (char === "}") delta -= 1;
  }
  return delta;
}

function parseEventChunk(text) {
  try {
    const parsed = JSON.parse(text);
    return isBridgeEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseBridgeEventLogText(text) {
  const events = [];
  let buffer = "";
  let depth = 0;

  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!buffer && !trimmed.startsWith("{")) {
      continue;
    }

    buffer = buffer ? `${buffer}\n${line}` : line;
    depth += countBraceDelta(line);

    if (depth <= 0) {
      const event = parseEventChunk(buffer);
      if (event) {
        events.push(event);
      }
      buffer = "";
      depth = 0;
    }
  }

  return events;
}

export async function readRecentBridgeEvents(logPath, { limit = DEFAULT_EVENT_LIMIT, tailBytes = DEFAULT_TAIL_BYTES } = {}) {
  if (!logPath) {
    return [];
  }

  let stats;
  try {
    stats = await fs.stat(logPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const size = Number(stats.size) || 0;
  const offset = Math.max(0, size - Math.max(1024, Number(tailBytes) || DEFAULT_TAIL_BYTES));
  const handle = await fs.open(logPath, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return parseBridgeEventLogText(text).slice(-Math.max(1, Number(limit) || DEFAULT_EVENT_LIMIT));
  } finally {
    await handle.close();
  }
}

export function summarizeBridgeEvents(events) {
  const safeEvents = Array.isArray(events) ? events.filter(isBridgeEvent) : [];
  const byType = new Map();
  for (const event of safeEvents) {
    byType.set(event.type, (byType.get(event.type) || 0) + 1);
  }

  const recentFailures = safeEvents
    .filter((event) => /error|failed|fallback/i.test(event.type))
    .slice(-5)
    .map((event) => ({
      ts: event.ts || null,
      type: event.type,
      bindingKey: event.bindingKey || null,
      error: event.error || null,
    }));

  return {
    total: safeEvents.length,
    byType: Object.fromEntries([...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    nativeSendSuccess: byType.get("native_send_success") || 0,
    nativeSendErrors: byType.get("native_send_error") || 0,
    appControlSends: safeEvents.filter((event) => event.type === "native_send_success" && event.transportPath === "app-control").length,
    appServerSends: safeEvents.filter((event) => event.type === "native_send_success" && event.transportPath === "app-server").length,
    appServerFallbackSends: safeEvents.filter(
      (event) => event.type === "native_send_success" && event.transportPath === "app-server-fallback",
    ).length,
    opsDmFallbacks: byType.get("ops_direct_chat_fallback") || 0,
    recentFailures,
  };
}

function formatTime(value) {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function compactValue(value, maxLength = 110) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function formatBridgeEventReport(events, { logPath = "", limitTypes = 8, limitFailures = 8 } = {}) {
  const safeEvents = Array.isArray(events) ? events.filter(isBridgeEvent) : [];
  const summary = summarizeBridgeEvents(safeEvents);
  const firstTs = safeEvents[0]?.ts || null;
  const lastTs = safeEvents.at(-1)?.ts || null;
  const topTypes = Object.entries(summary.byType)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, Number(limitTypes) || 8));
  const recentFailures = safeEvents
    .filter((event) => /error|failed|fallback/i.test(event.type))
    .slice(-Math.max(1, Number(limitFailures) || 8));

  const lines = ["Bridge events"];
  if (logPath) {
    lines.push(`path: ${logPath}`);
  }
  lines.push(`sampled: ${summary.total}`);
  if (summary.total > 0) {
    lines.push(`window: ${formatTime(firstTs)} -> ${formatTime(lastTs)}`);
  }
  lines.push(
    `native sends: ${summary.nativeSendSuccess} ok, ${summary.nativeSendErrors} error; app-control ${summary.appControlSends}, app-server ${summary.appServerSends}, fallback ${summary.appServerFallbackSends}`,
  );
  lines.push(`ops DM fallbacks: ${summary.opsDmFallbacks}`);
  lines.push("");
  lines.push("Top event types");
  if (topTypes.length) {
    for (const [type, count] of topTypes) {
      lines.push(`- ${type}: ${count}`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");
  lines.push("Recent failures");
  if (recentFailures.length) {
    for (const event of recentFailures) {
      const bits = [formatTime(event.ts), event.type];
      if (event.bindingKey) bits.push(event.bindingKey);
      if (event.threadId) bits.push(event.threadId);
      if (event.error) bits.push(compactValue(event.error));
      lines.push(`- ${bits.join(" | ")}`);
    }
  } else {
    lines.push("- none");
  }
  return lines.join("\n");
}
