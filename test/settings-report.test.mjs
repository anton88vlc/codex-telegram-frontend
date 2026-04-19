import test from "node:test";
import assert from "node:assert/strict";

import { buildSettingsReport } from "../lib/settings-report.mjs";

test("buildSettingsReport shows safe runtime settings without secrets", () => {
  const text = buildSettingsReport({
    config: {
      botToken: "123456:secret-token",
      botTokenSource: "keychain",
      botTokenEnv: "CODEX_TELEGRAM_BOT_TOKEN",
      botTokenKeychainService: "codex-telegram-bridge-bot-token",
      botUsername: "cdxbot",
      allowedUserIds: [123],
      allowedChatIds: [],
      pollTimeoutSeconds: 30,
      sendTyping: true,
      nativeDebugBaseUrl: "http://127.0.0.1:9222",
      appServerUrl: "ws://127.0.0.1:27890",
      nativeTimeoutMs: 120000,
      nativeWaitForReply: false,
      nativePollIntervalMs: 1000,
      nativeIngressTransport: "app-server",
      appControlCooldownMs: 300000,
      appControlShowThread: true,
      outboundSyncEnabled: true,
      outboundMirrorPhases: ["commentary", "final_answer"],
      outboundProgressMode: "updates",
      outboundPollIntervalMs: 2000,
      worktreeSummaryEnabled: true,
      worktreeSummaryMaxFiles: 8,
      statusBarEnabled: true,
      statusBarPin: true,
      statusBarTailBytes: 524288,
      syncDefaultLimit: 3,
      projectIndexPath: "state/bootstrap-result.json",
      statePath: "state/state.json",
      eventLogPath: "logs/bridge.events.ndjson",
      bridgeLogPath: "logs/bridge.stderr.log",
      threadsDbPath: "/Users/test/.codex/state_5.sqlite",
    },
    state: {
      bindings: { "group:-100:topic:3": {} },
      outboundMirrors: { "group:-100:topic:3": {} },
    },
    bindingKey: "group:-100:topic:3",
    binding: {
      threadId: "thread-1",
      statusBarMessageId: 5,
      lastMirroredAt: "2026-04-18T22:25:00.000Z",
      lastMirroredPhase: "commentary",
    },
  });

  assert.match(text, /\*\*Bridge settings\*\*/);
  assert.match(text, /bot: @cdxbot; token: Keychain codex-telegram-bridge-bot-token/);
  assert.match(text, /transport: native; ingress app-server; app-control `http:\/\/127\.0\.0\.1:9222`; fallback `ws:\/\/127\.0\.0\.1:27890`/);
  assert.match(text, /wait reply off; native poll 1s; app-control cooldown 300s/);
  assert.match(text, /app-control: show thread on/);
  assert.match(text, /mirror: on; phases commentary, final_answer; progress updates; poll 2s/);
  assert.match(text, /worktree: changed files on; max 8/);
  assert.match(text, /event log `logs\/bridge\.events\.ndjson`; stderr `logs\/bridge\.stderr\.log`/);
  assert.match(text, /current binding: `group:-100:topic:3`; thread `thread-1`; status bar `5`/);
  assert.doesNotMatch(text, /123456:secret-token/);
});
