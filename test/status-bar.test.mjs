import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStatusBarEntities,
  buildStatusBarMessage,
  buildStatusBarText,
  extractLatestRuntimeStatus,
  makeStatusBarHash,
} from "../lib/status-bar.mjs";

test("extractLatestRuntimeStatus reads the latest token_count event", () => {
  const first = JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-18T18:00:00.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: 100 },
        model_context_window: 1000,
      },
      rate_limits: {
        primary: { used_percent: 10, window_minutes: 300, resets_at: 1776540000 },
      },
    },
  });
  const second = JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-18T19:00:00.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: 250 },
        model_context_window: 1000,
      },
      rate_limits: {
        primary: { used_percent: 20, window_minutes: 300, resets_at: 1776543600 },
      },
    },
  });

  const runtime = extractLatestRuntimeStatus(`${first}\n${second}\n`);

  assert.equal(runtime.timestamp, "2026-04-18T19:00:00.000Z");
  assert.equal(runtime.lastTokenUsage.total_tokens, 250);
  assert.equal(runtime.rateLimits.primary.used_percent, 20);
});

test("buildStatusBarText stays compact and shows remaining rate limits", () => {
  const nowMs = Date.parse("2026-04-18T19:00:00.000Z");
  const text = buildStatusBarText({
    binding: {
      threadId: "thread-1",
      transport: "native",
      lastTransportPath: "app-control",
      statusBarMessageId: 123,
      currentTurn: {
        source: "telegram",
        startedAt: "2026-04-18T19:00:00.000Z",
      },
    },
    thread: {
      id: "thread-1",
      title: "Рабочий тред",
      model: "gpt-5.4",
      reasoning_effort: "xhigh",
      tokens_used: 123456,
    },
    runtime: {
      timestamp: "2026-04-18T19:01:00.000Z",
      lastTokenUsage: { total_tokens: 179315 },
      modelContextWindow: 258400,
      rateLimits: {
        primary: {
          used_percent: 12,
          window_minutes: 300,
          resets_at: Date.parse("2026-04-18T21:58:00.000Z") / 1000,
        },
        secondary: {
          used_percent: 18,
          window_minutes: 10080,
          resets_at: Date.parse("2026-04-25T16:55:00.000Z") / 1000,
        },
      },
    },
    config: {
      outboundSyncEnabled: true,
      outboundPollIntervalMs: 2000,
    },
    nowMs,
  });

  assert.equal(
    text,
    [
      "gpt-5.4 | xhigh",
      "context: 179k / 258k (69%)",
      "5h: 88% left, reset 23:58 (2h 58m); week: 82% left, reset 18:55 (6d 21h)",
      "status: pinned, running 21:00, mirror on",
    ].join("\n"),
  );
  assert.equal(makeStatusBarHash(text).length, 40);
});

test("buildStatusBarText shows latest progress activity time", () => {
  const text = buildStatusBarText({
    binding: {
      statusBarMessageId: 123,
      currentTurn: {
        startedAt: "2026-04-18T19:00:00.000Z",
        progressItems: [
          {
            text: "Inspecting",
            timestamp: "2026-04-18T19:07:00.000Z",
          },
        ],
      },
      lastMirroredAt: "2026-04-18T19:08:00.000Z",
    },
    thread: {
      model: "gpt-5.4",
      reasoning_effort: "xhigh",
    },
    runtime: null,
    config: {
      outboundSyncEnabled: true,
    },
  });

  assert.match(text, /status: pinned, running 21:07, mirror on/);
});

test("buildStatusBarMessage marks reset times as Telegram date_time entities", () => {
  const runtime = {
    lastTokenUsage: { total_tokens: 179315 },
    modelContextWindow: 258400,
    rateLimits: {
      primary: {
        used_percent: 12,
        resets_at: Date.parse("2026-04-18T21:58:00.000Z") / 1000,
      },
      secondary: {
        used_percent: 18,
        resets_at: Date.parse("2026-04-25T16:55:00.000Z") / 1000,
      },
    },
  };
  const message = buildStatusBarMessage({
    binding: { statusBarMessageId: 123 },
    thread: { model: "gpt-5.4", reasoning_effort: "xhigh" },
    runtime,
    config: {},
    nowMs: Date.parse("2026-04-18T19:00:00.000Z"),
  });

  assert.deepEqual(
    message.entities.map((entity) => ({
      type: entity.type,
      text: message.text.slice(entity.offset, entity.offset + entity.length),
      unix_time: entity.unix_time,
      date_time_format: entity.date_time_format,
    })),
    [
      {
        type: "date_time",
        text: "23:58",
        unix_time: Date.parse("2026-04-18T21:58:00.000Z") / 1000,
        date_time_format: "t",
      },
      {
        type: "date_time",
        text: "18:55",
        unix_time: Date.parse("2026-04-25T16:55:00.000Z") / 1000,
        date_time_format: "t",
      },
    ],
  );
  assert.deepEqual(buildStatusBarEntities({ text: message.text, runtime: null }), []);
});
