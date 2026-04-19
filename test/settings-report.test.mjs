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
      typingHeartbeatEnabled: true,
      typingHeartbeatIntervalMs: 4000,
      unboundGroupFallbackEnabled: true,
      unboundGroupFallbackMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
      nativeDebugBaseUrl: "http://127.0.0.1:9222",
      appServerUrl: "ws://127.0.0.1:27890",
      nativeTimeoutMs: 120000,
      nativeWaitForReply: false,
      nativePollIntervalMs: 1000,
      nativeIngressTransport: "app-server",
      appControlCooldownMs: 300000,
      appControlShowThread: true,
      appServerStreamEnabled: true,
      appServerStreamConnectTimeoutMs: 1200,
      appServerStreamReconnectMs: 5000,
      outboundSyncEnabled: true,
      outboundMirrorPhases: ["commentary", "final_answer"],
      outboundProgressMode: "updates",
      outboundPollIntervalMs: 2000,
      worktreeSummaryEnabled: true,
      worktreeSummaryMaxFiles: 0,
      attachmentsEnabled: true,
      attachmentStorageDir: "state/attachments",
      attachmentMaxBytes: 20 * 1024 * 1024,
      attachmentMaxCount: 10,
      voiceTranscriptionEnabled: true,
      voiceTranscriptionProvider: "auto",
      voiceTranscriptionModel: "",
      voiceTranscriptionLanguage: "multi",
      voiceTranscriptionMaxBytes: 25 * 1024 * 1024,
      voiceTranscriptionDeepgramApiKeySource: "env DEEPGRAM_API_KEY",
      voiceTranscriptionOpenAIApiKeySource: "missing",
      historyMaxMessages: 12,
      historyMaxUserPrompts: 4,
      historyAssistantPhases: ["final_answer", "commentary"],
      historyIncludeHeartbeats: true,
      statusBarEnabled: true,
      statusBarPin: true,
      statusBarTailBytes: 524288,
      syncDefaultLimit: 3,
      topicAutoSyncEnabled: true,
      topicAutoSyncLimit: 5,
      topicAutoSyncPollIntervalMs: 60000,
      topicAutoSyncMaxThreadAgeMs: 7 * 24 * 60 * 60 * 1000,
      topicAutoSyncMaxActionsPerTick: 8,
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
  assert.match(text, /ingress: poll 30s; typing on; typing heartbeat on \/ 4s/);
  assert.match(text, /mobile rescue: on; max age 30d/);
  assert.match(text, /transport: native; ingress app-server; app-control `http:\/\/127\.0\.0\.1:9222`; fallback `ws:\/\/127\.0\.0\.1:27890`/);
  assert.match(text, /wait reply off; native poll 1s; app-control cooldown 5m/);
  assert.match(text, /app-control: show thread on/);
  assert.match(text, /app-server stream: on; connect 1200ms; reconnect 5s/);
  assert.match(text, /mirror: on; phases commentary, final_answer; progress updates; poll 2s/);
  assert.match(text, /worktree: changed files on; max all/);
  assert.match(text, /attachments: on; max 10; size 20mb; dir `state\/attachments`/);
  assert.match(text, /voice: on; provider auto; model auto; language multi; max 25mb; keys deepgram env DEEPGRAM_API_KEY, openai missing/);
  assert.match(text, /history import: max messages 12; max user prompts 4; phases final_answer, commentary; heartbeats on/);
  assert.match(text, /topic auto-sync: on; limit 5; poll 1m; max age 7d; max actions 8/);
  assert.match(text, /event log `logs\/bridge\.events\.ndjson`; stderr `logs\/bridge\.stderr\.log`/);
  assert.match(text, /current binding: `group:-100:topic:3`; thread `thread-1`; status bar `5`/);
  assert.doesNotMatch(text, /123456:secret-token/);
});
