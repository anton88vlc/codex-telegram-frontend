import { appendFileSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_TAIL_BYTES = 256 * 1024;
const DEFAULT_EVENT_LIMIT = 200;

let currentEventLogPath = null;
const ensuredEventLogDirs = new Set();

export function configureBridgeEventLog(config) {
  currentEventLogPath = String(config?.eventLogPath ?? "").trim() || null;
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
    appServerFallbackSends: safeEvents.filter(
      (event) => event.type === "native_send_success" && event.transportPath === "app-server-fallback",
    ).length,
    opsDmFallbacks: byType.get("ops_direct_chat_fallback") || 0,
    recentFailures,
  };
}
