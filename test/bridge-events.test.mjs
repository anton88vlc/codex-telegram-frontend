import test from "node:test";
import assert from "node:assert/strict";

import { parseBridgeEventLogText, summarizeBridgeEvents } from "../lib/bridge-events.mjs";

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
    { type: "native_send_success", transportPath: "app-server-fallback" },
    { type: "native_send_error", ts: "2026-04-18T22:31:00.000Z", error: "timeout" },
    { type: "ops_direct_chat_fallback", error: "bot blocked" },
  ]);

  assert.equal(summary.appControlSends, 1);
  assert.equal(summary.appServerFallbackSends, 1);
  assert.equal(summary.nativeSendErrors, 1);
  assert.equal(summary.opsDmFallbacks, 1);
  assert.equal(summary.recentFailures.length, 2);
});
