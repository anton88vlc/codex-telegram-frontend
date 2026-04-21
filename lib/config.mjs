import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_UNBOUND_GROUP_FALLBACK_MAX_AGE_MS,
  normalizeText,
} from "./message-routing.mjs";
import { normalizeOutboundProgressMode } from "./outbound-progress.mjs";
import { readJsonIfExists } from "./project-data.mjs";
import { clamp, parsePositiveInt } from "./thread-db.mjs";
import {
  DEFAULT_TYPING_HEARTBEAT_INTERVAL_MS,
  normalizeTypingHeartbeatIntervalMs,
} from "./typing-heartbeat.mjs";
import {
  DEFAULT_DEEPGRAM_TRANSCRIPTION_LANGUAGE,
  DEFAULT_VOICE_TRANSCRIPTION_MAX_BYTES,
  normalizeVoiceTranscriptionProvider,
} from "./voice-transcription.mjs";
import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MAX_COUNT,
} from "./telegram-attachments.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.local.json");
const DEFAULT_STATE_PATH = path.join(PROJECT_ROOT, "state", "state.json");
const DEFAULT_NATIVE_HELPER_PATH = path.join(PROJECT_ROOT, "scripts", "send_via_app_control.js");
const DEFAULT_NATIVE_FALLBACK_HELPER_PATH = path.join(PROJECT_ROOT, "scripts", "send_via_app_server.js");
const DEFAULT_NATIVE_CHAT_START_HELPER_PATH = path.join(PROJECT_ROOT, "scripts", "start_via_app_server.js");
const DEFAULT_PROJECT_INDEX_PATH = path.join(PROJECT_ROOT, "state", "bootstrap-result.json");
const DEFAULT_ATTACHMENT_STORAGE_DIR = path.join(PROJECT_ROOT, "state", "attachments");
const DEFAULT_BRIDGE_LOG_PATH = path.join(PROJECT_ROOT, "logs", "bridge.stderr.log");
const DEFAULT_EVENT_LOG_PATH = path.join(PROJECT_ROOT, "logs", "bridge.events.ndjson");
const DEFAULT_THREADS_DB_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");
const DEFAULT_NATIVE_DEBUG_BASE_URL = process.env.CODEX_REMOTE_DEBUG_URL || "http://127.0.0.1:9222";
const DEFAULT_APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL || "ws://127.0.0.1:27890";
const DEFAULT_NATIVE_POLL_INTERVAL_MS = 1_000;
const DEFAULT_NATIVE_WAIT_FOR_REPLY = false;
const DEFAULT_NATIVE_CHAT_START_TIMEOUT_MS = 45_000;
const DEFAULT_NATIVE_CHAT_START_CWD = os.homedir();
const DEFAULT_OUTBOUND_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OUTBOUND_MIRROR_PHASES = ["commentary", "final_answer"];
const DEFAULT_APP_SERVER_STREAM_CONNECT_TIMEOUT_MS = 1_200;
const DEFAULT_APP_SERVER_CONTROL_TIMEOUT_MS = 3_000;
const DEFAULT_APP_SERVER_STREAM_RECONNECT_MS = 5_000;
const DEFAULT_APP_SERVER_STREAM_MAX_EVENTS = 500;
const DEFAULT_DRAFT_STREAMING_MAX_CHARS = 1200;
const DEFAULT_DRAFT_STREAMING_ERROR_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_STATUS_BAR_TAIL_BYTES = 512 * 1024;
const DEFAULT_STATUS_BAR_CODEX_CONFIG_POLL_INTERVAL_MS = 5_000;
const DEFAULT_WORKTREE_SUMMARY_MAX_FILES = 0;
const DEFAULT_HISTORY_MAX_MESSAGES = 40;
const DEFAULT_HISTORY_ASSISTANT_PHASES = ["final_answer"];
const DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE = "codex-telegram-bridge-bot-token";
const DEFAULT_APP_CONTROL_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_TOPIC_AUTO_SYNC_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_TOPIC_AUTO_SYNC_MAX_THREAD_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOPIC_AUTO_SYNC_MAX_ACTIONS_PER_TICK = 8;
const DEFAULT_PRIVATE_TOPIC_AUTO_SYNC_LIMIT = 5;
const DEFAULT_PRIVATE_TOPIC_AUTO_SYNC_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_PRIVATE_TOPIC_AUTO_SYNC_MAX_THREAD_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PRIVATE_TOPIC_AUTO_SYNC_MAX_ACTIONS_PER_TICK = 3;
const DEFAULT_PRIVATE_TOPIC_AUTO_BACKFILL_MAX_MESSAGES = 10;
const DEFAULT_TURN_QUEUE_MAX_ITEMS = 10;
const execFileAsync = promisify(execFile);

function normalizeOutboundMirrorPhases(value) {
  const allowed = new Set(["commentary", "final_answer"]);
  const raw = Array.isArray(value) ? value : DEFAULT_OUTBOUND_MIRROR_PHASES;
  const phases = Array.from(new Set(raw.map((item) => normalizeText(item)).filter((item) => allowed.has(item))));
  return phases.length ? phases : [...DEFAULT_OUTBOUND_MIRROR_PHASES];
}

function normalizeHistoryAssistantPhases(value) {
  const raw = Array.isArray(value) ? value : DEFAULT_HISTORY_ASSISTANT_PHASES;
  const phases = Array.from(new Set(raw.map((item) => normalizeText(item)).filter(Boolean)));
  return phases.length ? phases : [...DEFAULT_HISTORY_ASSISTANT_PHASES];
}

async function readKeychainSecret(serviceName) {
  const normalizedService = normalizeText(serviceName);
  if (!normalizedService) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      normalizedService,
      "-w",
    ]);
    const secret = String(stdout ?? "").trim();
    return secret || null;
  } catch {
    return null;
  }
}

async function readOptionalSecret({ envName, configValue = null, keychainService = null } = {}) {
  const normalizedEnvName = normalizeText(envName);
  const envValue = normalizedEnvName ? process.env[normalizedEnvName] : null;
  if (envValue) {
    return { value: envValue, source: `env ${normalizedEnvName}` };
  }
  if (configValue) {
    return { value: String(configValue), source: "config" };
  }
  const normalizedService = normalizeText(keychainService);
  const keychainValue = normalizedService ? await readKeychainSecret(normalizedService) : null;
  if (keychainValue) {
    return { value: keychainValue, source: `Keychain ${normalizedService}` };
  }
  return { value: null, source: "missing" };
}

export async function loadConfig(configPath) {
  const fromFile = await readJsonIfExists(configPath, {});
  const botTokenEnv = fromFile?.botTokenEnv || "CODEX_TELEGRAM_BOT_TOKEN";
  const botTokenKeychainService = fromFile?.botTokenKeychainService || DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE;
  const envBotToken = process.env[botTokenEnv] || null;
  const configBotToken = fromFile?.botToken || null;
  const keychainBotToken = envBotToken || configBotToken ? null : await readKeychainSecret(botTokenKeychainService);
  const botToken = envBotToken || configBotToken || keychainBotToken || null;
  const botTokenSource = envBotToken ? "env" : configBotToken ? "config" : keychainBotToken ? "keychain" : "missing";
  if (!botToken) {
    throw new Error(`missing Telegram bot token; set ${botTokenEnv}, botToken, or Keychain item ${botTokenKeychainService}`);
  }

  const voiceTranscriptionProvider = normalizeVoiceTranscriptionProvider(fromFile?.voiceTranscriptionProvider);
  const voiceTranscriptionOpenAIKeyEnv = normalizeText(
    fromFile?.voiceTranscriptionOpenAIKeyEnv || fromFile?.voiceTranscriptionApiKeyEnv || "OPENAI_API_KEY",
  );
  const voiceTranscriptionDeepgramKeyEnv = normalizeText(
    fromFile?.voiceTranscriptionDeepgramKeyEnv || fromFile?.voiceTranscriptionApiKeyEnv || "DEEPGRAM_API_KEY",
  );
  const voiceTranscriptionOpenAISecret = await readOptionalSecret({
    envName: voiceTranscriptionOpenAIKeyEnv,
    configValue:
      fromFile?.voiceTranscriptionOpenAIApiKey ||
      (voiceTranscriptionProvider === "openai" ? fromFile?.voiceTranscriptionApiKey : null),
    keychainService:
      fromFile?.voiceTranscriptionOpenAIKeychainService ||
      (voiceTranscriptionProvider === "openai" ? fromFile?.voiceTranscriptionKeychainService : null) ||
      "codex-telegram-bridge-openai-api-key",
  });
  const voiceTranscriptionDeepgramSecret = await readOptionalSecret({
    envName: voiceTranscriptionDeepgramKeyEnv,
    configValue:
      fromFile?.voiceTranscriptionDeepgramApiKey ||
      (voiceTranscriptionProvider === "deepgram" ? fromFile?.voiceTranscriptionApiKey : null),
    keychainService:
      fromFile?.voiceTranscriptionDeepgramKeychainService ||
      (voiceTranscriptionProvider === "deepgram" ? fromFile?.voiceTranscriptionKeychainService : null) ||
      "codex-telegram-bridge-deepgram-api-key",
  });
  const syncDefaultLimit = clamp(parsePositiveInt(fromFile?.syncDefaultLimit, 3), 1, 10);
  const topicAutoSyncLimit = clamp(parsePositiveInt(fromFile?.topicAutoSyncLimit, syncDefaultLimit), 1, 10);

  return {
    botToken,
    botTokenSource,
    botTokenEnv,
    botTokenKeychainService,
    botUsername: normalizeText(fromFile?.botUsername).replace(/^@+/, "") || null,
    allowedUserIds: Array.isArray(fromFile?.allowedUserIds)
      ? fromFile.allowedUserIds.map(Number).filter(Number.isFinite)
      : [],
    allowedChatIds: Array.isArray(fromFile?.allowedChatIds) ? fromFile.allowedChatIds.map(String) : [],
    pollTimeoutSeconds: Number.isFinite(fromFile?.pollTimeoutSeconds) ? fromFile.pollTimeoutSeconds : 30,
    sendTyping: fromFile?.sendTyping !== false,
    typingHeartbeatEnabled: fromFile?.typingHeartbeatEnabled !== false,
    typingHeartbeatIntervalMs: normalizeTypingHeartbeatIntervalMs(
      fromFile?.typingHeartbeatIntervalMs,
      DEFAULT_TYPING_HEARTBEAT_INTERVAL_MS,
    ),
    unboundGroupFallbackEnabled: fromFile?.unboundGroupFallbackEnabled !== false,
    unboundGroupFallbackMaxAgeMs: Number.isFinite(fromFile?.unboundGroupFallbackMaxAgeMs)
      ? Math.max(0, Number(fromFile.unboundGroupFallbackMaxAgeMs))
      : DEFAULT_UNBOUND_GROUP_FALLBACK_MAX_AGE_MS,
    nativeTimeoutMs: Number.isFinite(fromFile?.nativeTimeoutMs) ? fromFile.nativeTimeoutMs : 120_000,
    nativeWaitForReply:
      typeof fromFile?.nativeWaitForReply === "boolean"
        ? fromFile.nativeWaitForReply
        : DEFAULT_NATIVE_WAIT_FOR_REPLY,
    nativePollIntervalMs: Number.isFinite(fromFile?.nativePollIntervalMs)
      ? fromFile.nativePollIntervalMs
      : DEFAULT_NATIVE_POLL_INTERVAL_MS,
    nativeIngressTransport: ["app-control", "app-server", "auto"].includes(normalizeText(fromFile?.nativeIngressTransport))
      ? normalizeText(fromFile.nativeIngressTransport)
      : "app-control",
    turnQueueEnabled: fromFile?.turnQueueEnabled !== false,
    turnQueueMaxItems: Number.isFinite(fromFile?.turnQueueMaxItems)
      ? Math.max(1, Math.min(100, Number(fromFile.turnQueueMaxItems)))
      : DEFAULT_TURN_QUEUE_MAX_ITEMS,
    privateTopicAutoCreateChats: fromFile?.privateTopicAutoCreateChats === true,
    nativeChatStartTimeoutMs: Number.isFinite(fromFile?.nativeChatStartTimeoutMs)
      ? fromFile.nativeChatStartTimeoutMs
      : DEFAULT_NATIVE_CHAT_START_TIMEOUT_MS,
    nativeChatStartCwd:
      Object.prototype.hasOwnProperty.call(fromFile || {}, "nativeChatStartCwd")
        ? normalizeText(fromFile.nativeChatStartCwd) || DEFAULT_NATIVE_CHAT_START_CWD
        : DEFAULT_NATIVE_CHAT_START_CWD,
    appControlCooldownMs: Number.isFinite(fromFile?.appControlCooldownMs)
      ? fromFile.appControlCooldownMs
      : DEFAULT_APP_CONTROL_COOLDOWN_MS,
    appControlShowThread: fromFile?.appControlShowThread === true,
    nativeDebugBaseUrl: fromFile?.nativeDebugBaseUrl || DEFAULT_NATIVE_DEBUG_BASE_URL,
    appServerUrl: fromFile?.appServerUrl || DEFAULT_APP_SERVER_URL,
    appServerControlTimeoutMs: Number.isFinite(fromFile?.appServerControlTimeoutMs)
      ? Math.max(500, Number(fromFile.appServerControlTimeoutMs))
      : DEFAULT_APP_SERVER_CONTROL_TIMEOUT_MS,
    appServerStreamEnabled: fromFile?.appServerStreamEnabled !== false,
    appServerStreamConnectTimeoutMs: Number.isFinite(fromFile?.appServerStreamConnectTimeoutMs)
      ? fromFile.appServerStreamConnectTimeoutMs
      : DEFAULT_APP_SERVER_STREAM_CONNECT_TIMEOUT_MS,
    appServerStreamReconnectMs: Number.isFinite(fromFile?.appServerStreamReconnectMs)
      ? fromFile.appServerStreamReconnectMs
      : DEFAULT_APP_SERVER_STREAM_RECONNECT_MS,
    appServerStreamMaxEvents: Number.isFinite(fromFile?.appServerStreamMaxEvents)
      ? Math.max(50, Math.min(5000, Number(fromFile.appServerStreamMaxEvents)))
      : DEFAULT_APP_SERVER_STREAM_MAX_EVENTS,
    draftStreamingEnabled: fromFile?.draftStreamingEnabled !== false,
    draftStreamingMaxChars: Number.isFinite(fromFile?.draftStreamingMaxChars)
      ? Math.max(1, Math.min(4096, Number(fromFile.draftStreamingMaxChars)))
      : DEFAULT_DRAFT_STREAMING_MAX_CHARS,
    draftStreamingErrorCooldownMs: Number.isFinite(fromFile?.draftStreamingErrorCooldownMs)
      ? Math.max(0, Number(fromFile.draftStreamingErrorCooldownMs))
      : DEFAULT_DRAFT_STREAMING_ERROR_COOLDOWN_MS,
    outboundSyncEnabled: fromFile?.outboundSyncEnabled !== false,
    outboundPollIntervalMs: Number.isFinite(fromFile?.outboundPollIntervalMs)
      ? fromFile.outboundPollIntervalMs
      : DEFAULT_OUTBOUND_POLL_INTERVAL_MS,
    outboundMirrorPhases: normalizeOutboundMirrorPhases(fromFile?.outboundMirrorPhases),
    outboundProgressMode: normalizeOutboundProgressMode(fromFile?.outboundProgressMode),
    codexUserDisplayName: normalizeText(fromFile?.codexUserDisplayName) || "Codex Desktop user",
    statusBarEnabled: fromFile?.statusBarEnabled !== false,
    statusBarPin: fromFile?.statusBarPin !== false,
    statusBarFastMode: fromFile?.statusBarFastMode ?? null,
    statusBarTailBytes: Number.isFinite(fromFile?.statusBarTailBytes)
      ? fromFile.statusBarTailBytes
      : DEFAULT_STATUS_BAR_TAIL_BYTES,
    statusBarCodexConfigPollIntervalMs: Number.isFinite(fromFile?.statusBarCodexConfigPollIntervalMs)
      ? Math.max(0, Number(fromFile.statusBarCodexConfigPollIntervalMs))
      : DEFAULT_STATUS_BAR_CODEX_CONFIG_POLL_INTERVAL_MS,
    worktreeSummaryEnabled: fromFile?.worktreeSummaryEnabled !== false,
    worktreeSummaryMaxFiles: Number.isFinite(fromFile?.worktreeSummaryMaxFiles)
      ? Math.max(0, Math.min(200, Number(fromFile.worktreeSummaryMaxFiles)))
      : DEFAULT_WORKTREE_SUMMARY_MAX_FILES,
    attachmentsEnabled: fromFile?.attachmentsEnabled !== false,
    attachmentStorageDir: fromFile?.attachmentStorageDir || DEFAULT_ATTACHMENT_STORAGE_DIR,
    attachmentMaxBytes: Number.isFinite(fromFile?.attachmentMaxBytes)
      ? Math.max(1, Number(fromFile.attachmentMaxBytes))
      : DEFAULT_ATTACHMENT_MAX_BYTES,
    attachmentMaxCount: Number.isFinite(fromFile?.attachmentMaxCount)
      ? Math.max(1, Math.min(10, Number(fromFile.attachmentMaxCount)))
      : DEFAULT_ATTACHMENT_MAX_COUNT,
    voiceTranscriptionEnabled: fromFile?.voiceTranscriptionEnabled !== false,
    voiceTranscriptionProvider,
    voiceTranscriptionModel: normalizeText(fromFile?.voiceTranscriptionModel),
    voiceTranscriptionLanguage:
      fromFile?.voiceTranscriptionLanguage === null
        ? ""
        : normalizeText(fromFile?.voiceTranscriptionLanguage) || DEFAULT_DEEPGRAM_TRANSCRIPTION_LANGUAGE,
    voiceTranscriptionPrompt: normalizeText(fromFile?.voiceTranscriptionPrompt),
    voiceTranscriptionBaseUrl: normalizeText(fromFile?.voiceTranscriptionBaseUrl),
    voiceTranscriptionMaxBytes: Number.isFinite(fromFile?.voiceTranscriptionMaxBytes)
      ? Math.max(1, Number(fromFile.voiceTranscriptionMaxBytes))
      : DEFAULT_VOICE_TRANSCRIPTION_MAX_BYTES,
    voiceTranscriptionMaxCount: Number.isFinite(fromFile?.voiceTranscriptionMaxCount)
      ? Math.max(1, Math.min(3, Number(fromFile.voiceTranscriptionMaxCount)))
      : 1,
    voiceTranscriptionKeepFiles: fromFile?.voiceTranscriptionKeepFiles === true,
    voiceTranscriptionTimeoutMs: Number.isFinite(fromFile?.voiceTranscriptionTimeoutMs)
      ? Math.max(1_000, Number(fromFile.voiceTranscriptionTimeoutMs))
      : 60_000,
    voiceTranscriptionCommand: Array.isArray(fromFile?.voiceTranscriptionCommand)
      ? fromFile.voiceTranscriptionCommand.map(String).filter(Boolean)
      : [],
    voiceTranscriptionOpenAIKeyEnv,
    voiceTranscriptionDeepgramKeyEnv,
    voiceTranscriptionOpenAIApiKey: voiceTranscriptionOpenAISecret.value,
    voiceTranscriptionOpenAIApiKeySource: voiceTranscriptionOpenAISecret.source,
    voiceTranscriptionDeepgramApiKey: voiceTranscriptionDeepgramSecret.value,
    voiceTranscriptionDeepgramApiKeySource: voiceTranscriptionDeepgramSecret.source,
    historyMaxMessages: Number.isFinite(fromFile?.historyMaxMessages)
      ? Math.max(1, Number(fromFile.historyMaxMessages))
      : DEFAULT_HISTORY_MAX_MESSAGES,
    historyMaxUserPrompts: Number.isFinite(fromFile?.historyMaxUserPrompts)
      ? Math.max(1, Number(fromFile.historyMaxUserPrompts))
      : null,
    historyAssistantPhases: normalizeHistoryAssistantPhases(fromFile?.historyAssistantPhases),
    historyIncludeHeartbeats: fromFile?.historyIncludeHeartbeats === true,
    statePath: fromFile?.statePath || DEFAULT_STATE_PATH,
    nativeHelperPath: fromFile?.nativeHelperPath || DEFAULT_NATIVE_HELPER_PATH,
    nativeFallbackHelperPath: fromFile?.nativeFallbackHelperPath || DEFAULT_NATIVE_FALLBACK_HELPER_PATH,
    nativeChatStartHelperPath: fromFile?.nativeChatStartHelperPath || DEFAULT_NATIVE_CHAT_START_HELPER_PATH,
    projectIndexPath: fromFile?.projectIndexPath || DEFAULT_PROJECT_INDEX_PATH,
    bridgeLogPath: fromFile?.bridgeLogPath || DEFAULT_BRIDGE_LOG_PATH,
    eventLogPath: fromFile?.eventLogPath || DEFAULT_EVENT_LOG_PATH,
    threadsDbPath: fromFile?.threadsDbPath || DEFAULT_THREADS_DB_PATH,
    syncDefaultLimit,
    topicAutoSyncEnabled: fromFile?.topicAutoSyncEnabled === true,
    topicAutoSyncLimit,
    topicAutoSyncPollIntervalMs: Number.isFinite(fromFile?.topicAutoSyncPollIntervalMs)
      ? Math.max(10_000, Number(fromFile.topicAutoSyncPollIntervalMs))
      : DEFAULT_TOPIC_AUTO_SYNC_POLL_INTERVAL_MS,
    topicAutoSyncMaxThreadAgeMs: Number.isFinite(fromFile?.topicAutoSyncMaxThreadAgeMs)
      ? Math.max(0, Number(fromFile.topicAutoSyncMaxThreadAgeMs))
      : DEFAULT_TOPIC_AUTO_SYNC_MAX_THREAD_AGE_MS,
    topicAutoSyncMaxActionsPerTick: Number.isFinite(fromFile?.topicAutoSyncMaxActionsPerTick)
      ? Math.max(1, Math.min(50, Number(fromFile.topicAutoSyncMaxActionsPerTick)))
      : DEFAULT_TOPIC_AUTO_SYNC_MAX_ACTIONS_PER_TICK,
    privateTopicAutoSyncEnabled: fromFile?.privateTopicAutoSyncEnabled !== false,
    privateTopicAutoSyncLimit: Number.isFinite(fromFile?.privateTopicAutoSyncLimit)
      ? Math.max(1, Math.min(20, Number(fromFile.privateTopicAutoSyncLimit)))
      : DEFAULT_PRIVATE_TOPIC_AUTO_SYNC_LIMIT,
    privateTopicAutoSyncPollIntervalMs: Number.isFinite(fromFile?.privateTopicAutoSyncPollIntervalMs)
      ? Math.max(10_000, Number(fromFile.privateTopicAutoSyncPollIntervalMs))
      : DEFAULT_PRIVATE_TOPIC_AUTO_SYNC_POLL_INTERVAL_MS,
    privateTopicAutoSyncMaxThreadAgeMs: Number.isFinite(fromFile?.privateTopicAutoSyncMaxThreadAgeMs)
      ? Math.max(0, Number(fromFile.privateTopicAutoSyncMaxThreadAgeMs))
      : DEFAULT_PRIVATE_TOPIC_AUTO_SYNC_MAX_THREAD_AGE_MS,
    privateTopicAutoSyncMaxActionsPerTick: Number.isFinite(fromFile?.privateTopicAutoSyncMaxActionsPerTick)
      ? Math.max(1, Math.min(20, Number(fromFile.privateTopicAutoSyncMaxActionsPerTick)))
      : DEFAULT_PRIVATE_TOPIC_AUTO_SYNC_MAX_ACTIONS_PER_TICK,
    privateTopicAutoBackfillEnabled: fromFile?.privateTopicAutoBackfillEnabled !== false,
    privateTopicAutoBackfillMaxMessages: Number.isFinite(fromFile?.privateTopicAutoBackfillMaxMessages)
      ? Math.max(1, Math.min(40, Number(fromFile.privateTopicAutoBackfillMaxMessages)))
      : DEFAULT_PRIVATE_TOPIC_AUTO_BACKFILL_MAX_MESSAGES,
  };
}
