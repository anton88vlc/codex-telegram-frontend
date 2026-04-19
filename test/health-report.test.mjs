import test from "node:test";
import assert from "node:assert/strict";

import { renderBindingStatus, renderHealth } from "../lib/health-report.mjs";

const config = {
  appServerUrl: "http://127.0.0.1:39300",
  botUsername: "codexbot",
  bridgeLogPath: "/repo/logs/bridge.stderr.log",
  eventLogPath: "/repo/logs/bridge.events.ndjson",
  nativeDebugBaseUrl: "http://127.0.0.1:9222",
  outboundPollIntervalMs: 2000,
  threadsDbPath: "/repo/state/threads.sqlite",
};

test("renderBindingStatus shows binding and local thread details", async () => {
  const text = await renderBindingStatus(
    config,
    "group:-100:topic:3",
    {
      threadId: "thread-1",
      transport: "native",
      threadTitle: "Telegram topic",
      lastInboundMessageId: 10,
      lastOutboundMessageIds: [11, 12],
      lastMirroredAt: "2026-04-19T10:00:00.000Z",
      lastMirroredPhase: "final_answer",
      statusBarMessageId: 99,
    },
    {
      getThreadByIdFn: async (dbPath, threadId) => {
        assert.equal(dbPath, config.threadsDbPath);
        assert.equal(threadId, "thread-1");
        return {
          id: "thread-1",
          title: "Codex thread",
          cwd: "/repo",
          archived: 0,
        };
      },
    },
  );

  assert.match(text, /\*\*Current binding\*\*/);
  assert.match(text, /thread: `thread-1`/);
  assert.match(text, /last outbound messages: `11, 12`/);
  assert.match(text, /thread cwd: `\/repo`/);
  assert.match(text, /thread archived: no/);
  assert.match(text, /thread title db: Codex thread/);
});

test("renderBindingStatus warns when the thread disappeared", async () => {
  const text = await renderBindingStatus(
    config,
    "group:-100:topic:3",
    { threadId: "missing-thread" },
    { getThreadByIdFn: async () => null },
  );

  assert.match(text, /warning: thread not found in the local threads DB/);
});

test("renderHealth summarizes transport, state doctor, project and thread clues", async () => {
  const text = await renderHealth(
    config,
    { bindings: {} },
    { chat: { id: -100, type: "supergroup" }, message_thread_id: 3 },
    "group:-100:topic:3",
    {
      threadId: "thread-1",
      threadTitle: "Telegram topic",
      lastInboundMessageId: 10,
      lastOutboundMessageIds: [11],
      lastMirroredAt: "2026-04-19T10:00:00.000Z",
      lastTransportPath: "app-control",
      appControlCooldownUntil: "2026-04-19T12:00:00.000Z",
      lastTransportErrorKind: "native_send_error",
      lastTransportErrorAt: "2026-04-19T10:01:00.000Z",
      statusBarMessageId: 99,
      statusBarUpdatedAt: "2026-04-19T10:02:00.000Z",
    },
    {
      readRecentBridgeEventsFn: async (logPath) => {
        assert.equal(logPath, config.eventLogPath);
        return [{ type: "native_send_error", error: "timeout" }];
      },
      summarizeBridgeEventsFn: (events) => ({
        total: events.length,
        appControlSends: 2,
        appServerFallbackSends: 1,
        nativeSendErrors: 1,
        opsDmFallbacks: 1,
        recentFailures: [
          {
            type: "native_send_error",
            ts: "2026-04-19T10:01:00.000Z",
            bindingKey: "group:-100:topic:3",
            error: "timeout while sending",
          },
        ],
      }),
      inspectStateDoctorFn: async ({ recentEvents }) => ({
        summary: {
          findings: recentEvents.length,
          repairable: 1,
        },
      }),
      loadProjectGroupForMessageFn: async () => ({
        projectGroup: {
          groupTitle: "Codex - repo",
          projectRoot: "/repo",
          topics: [{}, {}],
        },
      }),
      getThreadByIdFn: async () => ({
        id: "thread-1",
        title: "Codex thread",
        cwd: "/repo",
        archived: 0,
      }),
      nowMs: Date.parse("2026-04-19T11:00:00.000Z"),
    },
  );

  assert.match(text, /\*\*Bridge health\*\*/);
  assert.match(text, /delivery: app-control 2, app-server fallback 1, native errors 1, ops dm fallbacks 1/);
  assert.match(text, /state doctor: 1 findings, 1 safe repairs/);
  assert.match(text, /state repair hint/);
  assert.match(text, /project group: Codex - repo/);
  assert.match(text, /thread cwd: `\/repo`/);
  assert.match(text, /app-control cooldown until: `2026-04-19T12:00:00.000Z`/);
  assert.match(text, /recent failures:/);
  assert.match(text, /native_send_error 2026-04-19T10:01:00.000Z group:-100:topic:3 - timeout while sending/);
});

test("renderHealth degrades when event log reading fails", async () => {
  const text = await renderHealth(
    config,
    {},
    { chat: { id: 42, type: "private" } },
    "private:42",
    null,
    {
      readRecentBridgeEventsFn: async () => {
        throw new Error("missing log");
      },
      summarizeBridgeEventsFn: (events) => {
        assert.equal(events[0].type, "health_event_log_error");
        return {
          total: events.length,
          appControlSends: 0,
          appServerFallbackSends: 0,
          nativeSendErrors: 0,
          opsDmFallbacks: 0,
          recentFailures: [],
        };
      },
      inspectStateDoctorFn: async () => ({ summary: { findings: 0, repairable: 0 } }),
      loadProjectGroupForMessageFn: async () => ({ projectGroup: null }),
    },
  );

  assert.match(text, /binding: none/);
  assert.match(text, /event log: `\/repo\/logs\/bridge.events.ndjson` \(1 sampled\)/);
  assert.match(text, /warning: chat not found in bootstrap result/);
  assert.match(text, /recent failures: none in sampled log/);
});
