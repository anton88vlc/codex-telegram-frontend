import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  configureBridgeEventLog,
  formatBridgeEventReport,
  logBridgeEvent,
  maybeRotateEventLogSync,
  parseBridgeEventLogText,
  readRecentBridgeEvents,
  summarizeBridgeEvents,
} from "../lib/bridge-events.mjs";

test("parseBridgeEventLogText reads old pretty events and new ndjson events", () => {
  const text = [
    "{",
    '  "ts": "2026-04-18T21:50:07.501Z",',
    '  "type": "native_send_error",',
    '  "bindingKey": "group:-100:topic:3",',
    '  "error": "timed out"',
    "}",
    '{"ts":"2026-04-18T22:30:00.000Z","type":"native_send_success","transportPath":"app-control"}',
  ].join("\n");

  const events = parseBridgeEventLogText(text);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "native_send_error");
  assert.equal(events[1].transportPath, "app-control");
});

test("summarizeBridgeEvents keeps delivery counters and recent failures", () => {
  const summary = summarizeBridgeEvents([
    { type: "native_send_success", transportPath: "app-control" },
    { type: "native_send_success", transportPath: "app-server" },
    { type: "native_send_success", transportPath: "app-server-fallback" },
    { type: "native_send_error", ts: "2026-04-18T22:31:00.000Z", error: "timeout" },
    { type: "ops_direct_chat_fallback", error: "bot blocked" },
  ]);

  assert.equal(summary.appControlSends, 1);
  assert.equal(summary.appServerSends, 1);
  assert.equal(summary.appServerFallbackSends, 1);
  assert.equal(summary.nativeSendErrors, 1);
  assert.equal(summary.opsDmFallbacks, 1);
  assert.equal(summary.recentFailures.length, 2);
});

test("readRecentBridgeEvents reads structured ndjson event log tail", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-events-"));
  const logPath = path.join(dir, "bridge.events.ndjson");
  await fs.writeFile(
    logPath,
    [
      '{"ts":"2026-04-19T00:00:00.000Z","type":"native_send_success","transportPath":"app-control"}',
      '{"ts":"2026-04-19T00:01:00.000Z","type":"native_send_error","error":"timeout"}',
      "",
    ].join("\n"),
    "utf8",
  );

  const events = await readRecentBridgeEvents(logPath, { limit: 1 });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "native_send_error");
});

test("maybeRotateEventLogSync rotates oversized event logs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-events-rotate-"));
  const logPath = path.join(dir, "bridge.events.ndjson");
  await fs.writeFile(logPath, `${"x".repeat(128)}\n`, "utf8");

  const rotated = maybeRotateEventLogSync(logPath, { maxBytes: 64 });

  assert.equal(rotated, true);
  assert.equal(await fs.readFile(`${logPath}.1`, "utf8"), `${"x".repeat(128)}\n`);
  await assert.rejects(fs.stat(logPath), /ENOENT/);
});

test("logBridgeEvent honors configured retention", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-events-retention-"));
  const logPath = path.join(dir, "bridge.events.ndjson");
  await fs.writeFile(logPath, `${"x".repeat(70 * 1024)}\n`, "utf8");
  configureBridgeEventLog({ eventLogPath: logPath, eventLogMaxBytes: 64 * 1024 });

  const originalStderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    logBridgeEvent("retention_smoke", { ok: true });
  } finally {
    process.stderr.write = originalStderrWrite;
    configureBridgeEventLog({ eventLogPath: null });
  }

  const events = await readRecentBridgeEvents(logPath);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "retention_smoke");
  assert.match(await fs.readFile(`${logPath}.1`, "utf8"), /^x+/);
});

test("formatBridgeEventReport renders an operator-friendly summary", () => {
  const text = formatBridgeEventReport(
    [
      { ts: "2026-05-01T10:00:00.000Z", type: "native_send_success", transportPath: "app-server" },
      { ts: "2026-05-01T10:01:00.000Z", type: "app_server_stream_subscribe_error", error: "timeout" },
    ],
    { logPath: "/repo/logs/bridge.events.ndjson" },
  );

  assert.match(text, /Bridge events/);
  assert.match(text, /path: \/repo\/logs\/bridge\.events\.ndjson/);
  assert.match(text, /native sends: 1 ok, 0 error/);
  assert.match(text, /app_server_stream_subscribe_error/);
});
