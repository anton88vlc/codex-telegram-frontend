#!/usr/bin/env node

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sendNativeTurn } from "./lib/codex-native.mjs";
import { readRecentBridgeEvents, summarizeBridgeEvents } from "./lib/bridge-events.mjs";
import { normalizeInboundPrompt, normalizeText, parseCommand } from "./lib/message-routing.mjs";
import { appendTransportNotice, renderNativeSendError } from "./lib/native-ux.mjs";
import {
  appendOutboundProgressItem,
  formatOutboundProgressMirrorText,
  normalizeOutboundProgressMode,
} from "./lib/outbound-progress.mjs";
import { getInitialProgressText, startProgressBubble } from "./lib/progress-bubble.mjs";
import {
  getBindingsForChat,
  getBoundThreadIdsForChat,
  getProjectGroupForChat,
  loadProjectIndex,
  readJsonIfExists,
} from "./lib/project-data.mjs";
import {
  buildProjectSyncPlan,
  isClosedSyncBinding,
  isSyncManagedBinding,
  sanitizeTopicTitle,
  SYNC_PROJECT_CREATOR,
} from "./lib/project-sync.mjs";
import { buildSelfCheckReport, formatSelfCheckReport } from "./lib/runtime-health.mjs";
import { buildSettingsReport } from "./lib/settings-report.mjs";
import { buildStatusBarText, makeStatusBarHash, readRolloutRuntimeStatus } from "./lib/status-bar.mjs";
import {
  getBinding,
  getOutboundMirror,
  hasProcessedMessage,
  loadState,
  makeBindingKey,
  makeMessageKey,
  markProcessedMessage,
  rememberOutboundSuppression,
  removeBinding,
  removeOutboundMirror,
  saveStateMerged as saveState,
  setBinding,
  setOutboundMirror,
  consumeOutboundSuppression,
} from "./lib/state.mjs";
import { clamp, getThreadById, getThreadsByIds, listProjectThreads, parsePositiveInt } from "./lib/thread-db.mjs";
import { makeOutboundMirrorSignature, readThreadMirrorDelta } from "./lib/thread-rollout.mjs";
import {
  closeForumTopic,
  createForumTopic,
  editForumTopic,
  editThenSendRichTextChunks,
  editMessageText,
  getMe,
  getUpdates,
  pinChatMessage,
  reopenForumTopic,
  sendMessage,
  sendRichTextChunks,
  sendTextChunks,
  sendTyping,
} from "./lib/telegram.mjs";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.local.json");
const DEFAULT_STATE_PATH = path.join(PROJECT_ROOT, "state", "state.json");
const DEFAULT_NATIVE_HELPER_PATH = path.join(PROJECT_ROOT, "scripts", "send_via_app_control.js");
const DEFAULT_NATIVE_FALLBACK_HELPER_PATH = path.join(PROJECT_ROOT, "scripts", "send_via_app_server.js");
const DEFAULT_PROJECT_INDEX_PATH = path.join(PROJECT_ROOT, "state", "bootstrap-result.json");
const DEFAULT_BRIDGE_LOG_PATH = path.join(PROJECT_ROOT, "logs", "bridge.stderr.log");
const DEFAULT_THREADS_DB_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");
const DEFAULT_NATIVE_DEBUG_BASE_URL = process.env.CODEX_REMOTE_DEBUG_URL || "http://127.0.0.1:9222";
const DEFAULT_APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL || "ws://127.0.0.1:27890";
const DEFAULT_NATIVE_POLL_INTERVAL_MS = 1_000;
const DEFAULT_OUTBOUND_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OUTBOUND_MIRROR_PHASES = ["commentary", "final_answer"];
const DEFAULT_STATUS_BAR_TAIL_BYTES = 512 * 1024;
const DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE = "codex-telegram-bridge-bot-token";
const execFileAsync = promisify(execFile);

const TELEGRAM_SERVICE_MESSAGE_KEYS = [
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "message_auto_delete_timer_changed",
  "pinned_message",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "boost_added",
  "chat_background_set",
];

function fail(message, extra = {}) {
  const payload = { ok: false, error: message, ...extra };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    configPath: DEFAULT_CONFIG_PATH,
    once: false,
    selfCheck: false,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    switch (arg) {
      case "--config":
        out.configPath = argv[++idx];
        break;
      case "--once":
        out.once = true;
        break;
      case "--self-check":
        out.selfCheck = true;
        break;
      default:
        fail(`unknown argument: ${arg}`, { argv });
    }
  }
  return out;
}

async function loadConfig(configPath) {
  const fromFile = await readJsonIfExists(configPath, {});
  const botTokenEnv = fromFile?.botTokenEnv || "CODEX_TELEGRAM_BOT_TOKEN";
  const botTokenKeychainService = fromFile?.botTokenKeychainService || DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE;
  const envBotToken = process.env[botTokenEnv] || null;
  const configBotToken = fromFile?.botToken || null;
  const keychainBotToken = envBotToken || configBotToken ? null : await readKeychainSecret(botTokenKeychainService);
  const botToken = envBotToken || configBotToken || keychainBotToken || null;
  const botTokenSource = envBotToken ? "env" : configBotToken ? "config" : keychainBotToken ? "keychain" : "missing";
  if (!botToken) {
    fail(`missing Telegram bot token; set ${botTokenEnv}, botToken, or Keychain item ${botTokenKeychainService}`, {
      configPath,
    });
  }

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
    nativeTimeoutMs: Number.isFinite(fromFile?.nativeTimeoutMs) ? fromFile.nativeTimeoutMs : 120_000,
    nativePollIntervalMs: Number.isFinite(fromFile?.nativePollIntervalMs)
      ? fromFile.nativePollIntervalMs
      : DEFAULT_NATIVE_POLL_INTERVAL_MS,
    nativeDebugBaseUrl: fromFile?.nativeDebugBaseUrl || DEFAULT_NATIVE_DEBUG_BASE_URL,
    appServerUrl: fromFile?.appServerUrl || DEFAULT_APP_SERVER_URL,
    outboundSyncEnabled: fromFile?.outboundSyncEnabled !== false,
    outboundPollIntervalMs: Number.isFinite(fromFile?.outboundPollIntervalMs)
      ? fromFile.outboundPollIntervalMs
      : DEFAULT_OUTBOUND_POLL_INTERVAL_MS,
    outboundMirrorPhases: normalizeOutboundMirrorPhases(fromFile?.outboundMirrorPhases),
    outboundProgressMode: normalizeOutboundProgressMode(fromFile?.outboundProgressMode),
    codexUserDisplayName: normalizeText(fromFile?.codexUserDisplayName) || "Codex Desktop user",
    statusBarEnabled: fromFile?.statusBarEnabled !== false,
    statusBarPin: fromFile?.statusBarPin !== false,
    statusBarTailBytes: Number.isFinite(fromFile?.statusBarTailBytes)
      ? fromFile.statusBarTailBytes
      : DEFAULT_STATUS_BAR_TAIL_BYTES,
    statePath: fromFile?.statePath || DEFAULT_STATE_PATH,
    nativeHelperPath: fromFile?.nativeHelperPath || DEFAULT_NATIVE_HELPER_PATH,
    nativeFallbackHelperPath: fromFile?.nativeFallbackHelperPath || DEFAULT_NATIVE_FALLBACK_HELPER_PATH,
    projectIndexPath: fromFile?.projectIndexPath || DEFAULT_PROJECT_INDEX_PATH,
    bridgeLogPath: fromFile?.bridgeLogPath || DEFAULT_BRIDGE_LOG_PATH,
    threadsDbPath: fromFile?.threadsDbPath || DEFAULT_THREADS_DB_PATH,
    syncDefaultLimit: Number.isFinite(fromFile?.syncDefaultLimit) ? fromFile.syncDefaultLimit : 3,
  };
}

function normalizeOutboundMirrorPhases(value) {
  const allowed = new Set(["commentary", "final_answer"]);
  const raw = Array.isArray(value) ? value : DEFAULT_OUTBOUND_MIRROR_PHASES;
  const phases = Array.from(new Set(raw.map((item) => normalizeText(item)).filter((item) => allowed.has(item))));
  return phases.length ? phases : [...DEFAULT_OUTBOUND_MIRROR_PHASES];
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

function buildTargetFromMessage(message) {
  return {
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id ?? null,
  };
}

function isTelegramServiceMessage(message) {
  return TELEGRAM_SERVICE_MESSAGE_KEYS.some((key) => key in (message || {}));
}

function formatThreadBullet(thread) {
  return `- ${sanitizeTopicTitle(thread.title, thread.id)} (${thread.id})`;
}

function buildBindingPayload({ message, thread, chatTitle }) {
  return {
    threadId: String(thread.id),
    transport: "native",
    chatId: String(message.chat.id),
    messageThreadId: message.message_thread_id ?? null,
    chatTitle: normalizeText(chatTitle || message.chat.title || message.chat.username || message.chat.first_name || ""),
    threadTitle: sanitizeTopicTitle(thread.title, thread.id),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function isAuthorized(config, message) {
  const userId = Number(message?.from?.id);
  const chatId = String(message?.chat?.id);
  if (config.allowedUserIds.length && !config.allowedUserIds.includes(userId)) {
    return false;
  }
  if (config.allowedChatIds.length && !config.allowedChatIds.includes(chatId)) {
    return false;
  }
  return true;
}

async function reply(token, message, text) {
  return sendRichTextChunks(token, buildTargetFromMessage(message), text, message.message_id);
}

async function replyPlain(token, message, text) {
  return sendTextChunks(token, buildTargetFromMessage(message), text, message.message_id);
}

function isTopicMessage(message) {
  return message.message_thread_id != null && (message.chat.type === "group" || message.chat.type === "supergroup");
}

function buildOpsDmIntro(message) {
  const chatTitle = normalizeText(message.chat.title || message.chat.username || message.chat.first_name || "chat");
  const topic = message.message_thread_id != null ? `, topic ${message.message_thread_id}` : "";
  return `**Ops details** from **${chatTitle}**${topic}\n\n`;
}

async function sendCommandResponse({
  config,
  message,
  text,
  quietInTopic = false,
  topicSummary = null,
}) {
  if (quietInTopic && isTopicMessage(message) && Number.isInteger(message.from?.id)) {
    try {
      await sendRichTextChunks(
        config.botToken,
        {
          chatId: message.from.id,
          messageThreadId: null,
        },
        `${buildOpsDmIntro(message)}${text}`,
      );
      return reply(
        config.botToken,
        message,
        topicSummary || "Done. I sent the details to your direct chat with the bot to keep this topic clean.",
      );
    } catch (error) {
      logBridgeEvent("ops_direct_chat_fallback", {
        chatId: message.chat.id,
        messageId: message.message_id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return reply(config.botToken, message, text);
}

function rememberOutbound(binding, sentMessages) {
  if (!binding || !Array.isArray(sentMessages)) {
    return;
  }
  binding.lastOutboundMessageIds = sentMessages
    .map((item) => item?.message_id)
    .filter((value) => Number.isInteger(value));
}

function rememberOutboundMirrorSuppression(state, bindingKey, text, { role = "assistant", phase = "final_answer" } = {}) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return null;
  }
  const signature = makeOutboundMirrorSignature({
    role,
    phase,
    text: normalizedText,
  });
  rememberOutboundSuppression(state, bindingKey, signature);
  return signature;
}

function isOutboundMirrorBindingEligible(binding) {
  if (!binding?.threadId) {
    return false;
  }
  if ((binding.transport || "native") !== "native") {
    return false;
  }
  if (isClosedSyncBinding(binding)) {
    return false;
  }
  if (!binding.chatId) {
    return false;
  }
  return true;
}

function isStatusBarBindingEligible(binding) {
  if (!isOutboundMirrorBindingEligible(binding)) {
    return false;
  }
  return binding.messageThreadId != null;
}

function formatOutboundUserMirrorText(text, config = {}) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  const displayName = normalizeText(config.codexUserDisplayName).replace(/\s+/g, " ") || "Codex Desktop user";
  return `**${displayName} via Codex Desktop**\n\n${normalized}`;
}

function isFinalAssistantMirrorMessage(message) {
  return message?.role === "assistant" && (normalizeText(message?.phase) || "final_answer") === "final_answer";
}

function isCommentaryAssistantMirrorMessage(message) {
  return message?.role === "assistant" && normalizeText(message?.phase) === "commentary";
}

function formatOutboundAssistantMirrorText(message) {
  const text = normalizeText(message?.text);
  if (!text || message?.role !== "assistant") {
    return text;
  }
  if ((normalizeText(message?.phase) || "final_answer") !== "commentary") {
    return text;
  }
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

async function upsertOutboundProgressMessage({ config, binding, target, replyToMessageId, message }) {
  const progressItems = appendOutboundProgressItem(binding.currentTurn, message);
  binding.currentTurn = {
    source: "codex",
    startedAt: message.timestamp || binding.currentTurn?.startedAt || new Date().toISOString(),
    promptPreview: binding.currentTurn?.promptPreview || "Codex progress",
    ...(binding.currentTurn || {}),
    progressItems,
  };
  const text = formatOutboundProgressMirrorText({
    message,
    currentTurn: binding.currentTurn,
    config,
  });
  if (!text) {
    return [];
  }
  const messageId = binding.currentTurn?.codexProgressMessageId;
  if (Number.isInteger(messageId)) {
    const edited = await editThenSendRichTextChunks(config.botToken, target, messageId, text);
    return edited.length ? edited : [{ message_id: messageId }];
  }
  const sent = await sendRichTextChunks(config.botToken, target, text, replyToMessageId);
  const progressMessageId = sent[0]?.message_id;
  if (Number.isInteger(progressMessageId)) {
    binding.currentTurn = {
      ...(binding.currentTurn || {}),
      codexProgressMessageId: progressMessageId,
    };
  }
  return sent;
}

async function completeOutboundProgressMessage({ config, binding, target }) {
  const messageId = binding.currentTurn?.codexProgressMessageId;
  if (!Number.isInteger(messageId)) {
    return [];
  }
  const text = formatOutboundProgressMirrorText({
    currentTurn: binding.currentTurn,
    config,
    completed: true,
  });
  const edited = await editThenSendRichTextChunks(
    config.botToken,
    target,
    messageId,
    text || "**Progress**\nDone. Final answer below.",
  );
  return edited.length ? edited : [{ message_id: messageId }];
}

function makePromptPreview(text) {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  if (normalized.length <= 160) {
    return normalized;
  }
  return `${normalized.slice(0, 157)}...`;
}

function isMissingStatusBarMessageError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /message to edit not found|message_id_invalid|message can't be edited|message not found/i.test(message);
}

function logBridgeEvent(type, payload = {}) {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), type, ...payload })}\n`);
}

function renderHelp(config) {
  const mentionHint = config.botUsername
    ? `If group privacy still blocks plain text, mention the bot: \`@${config.botUsername} your request\`.`
    : "If group privacy still blocks plain text, temporarily mention the bot in your message.";
  return [
    "**Commands**",
    "`/attach <thread-id>` - bind this chat or topic to a Codex thread",
    "`/attach-latest` - bind this topic to the newest unbound thread in this project",
    "`/detach` - remove the binding",
    "`/status` - show the current binding and thread",
    "`/health` - show bridge health for this chat/topic and transport paths",
    "`/settings` - show safe read-only runtime settings",
    "`/project-status [count]` - show desired thread column, active topics and sync preview",
    "`/sync-project [count] [dry-run]` - sync managed topics to the current project working set",
    "`/mode native` - explicitly use native transport",
    "`/help` - show this message",
    "",
    "After `/attach`, normal text from this chat goes to the bound Codex thread.",
    mentionHint,
    "v1 is intentionally narrow: **native transport** only. Heartbeat/UI-visible transport is phase 2.",
    "Final answers from the Codex thread are mirrored back into the bound Telegram chat/topic.",
  ].join("\n");
}

async function loadProjectGroupForMessage(config, message) {
  const groups = await loadProjectIndex(config.projectIndexPath);
  return {
    groups,
    projectGroup: getProjectGroupForChat(groups, message.chat.id),
  };
}

async function loadThreadsByBindings(config, entries) {
  const threadIds = entries
    .map(({ binding }) => String(binding?.threadId ?? "").trim())
    .filter(Boolean);
  const rows = await getThreadsByIds(config.threadsDbPath, threadIds);
  return new Map(rows.map((row) => [String(row.id), row]));
}

async function collectChatBindingDiagnostics(config, state, chatId) {
  const entries = getBindingsForChat(state, chatId);
  if (!entries.length) {
    return {
      entries,
      threadsById: new Map(),
      issues: [],
    };
  }

  const threadsById = await loadThreadsByBindings(config, entries);
  const issues = [];
  for (const { bindingKey, binding } of entries) {
    const threadId = String(binding?.threadId ?? "").trim();
    const thread = threadId ? threadsById.get(threadId) ?? null : null;
    if (!threadId) {
      issues.push(`- ${bindingKey}: missing threadId`);
      continue;
    }
    if (!thread) {
      issues.push(`- ${bindingKey}: thread ${threadId} missing in threads DB`);
      continue;
    }
    if (Number(thread.archived) !== 0) {
      issues.push(`- ${bindingKey}: thread ${threadId} archived`);
    }
  }
  return {
    entries,
    threadsById,
    issues,
  };
}

async function renderBindingStatus(config, bindingKey, binding) {
  const lines = [
    "**Current binding**",
    `thread: \`${binding.threadId}\``,
    `transport: \`${binding.transport || "native"}\``,
    `key: \`${bindingKey}\``,
  ];
  if (binding.threadTitle) {
    lines.push(`thread title: ${binding.threadTitle}`);
  }
  if (binding.lastInboundMessageId != null) {
    lines.push(`last inbound message: \`${binding.lastInboundMessageId}\``);
  }
  if (Array.isArray(binding.lastOutboundMessageIds) && binding.lastOutboundMessageIds.length) {
    lines.push(`last outbound messages: \`${binding.lastOutboundMessageIds.join(", ")}\``);
  }
  if (binding.lastMirroredAt) {
    lines.push(`last mirrored at: \`${binding.lastMirroredAt}\` (${binding.lastMirroredPhase || "assistant"})`);
  }
  if (binding.statusBarMessageId) {
    lines.push(`status bar message: \`${binding.statusBarMessageId}\``);
  }

  try {
    const thread = await getThreadById(config.threadsDbPath, binding.threadId);
    if (!thread) {
      lines.push("warning: thread not found in the local threads DB");
    } else {
      lines.push(`thread cwd: \`${thread.cwd}\``);
      lines.push(`thread archived: ${Number(thread.archived) !== 0 ? "yes" : "no"}`);
      lines.push(`thread title db: ${sanitizeTopicTitle(thread.title, thread.id)}`);
    }
  } catch (error) {
    lines.push(`warning: threads DB lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return lines.join("\n");
}

async function renderHealth(config, state, message, bindingKey, binding) {
  const recentEvents = await readRecentBridgeEvents(config.bridgeLogPath).catch((error) => [
    {
      type: "health_event_log_error",
      error: error instanceof Error ? error.message : String(error),
    },
  ]);
  const eventSummary = summarizeBridgeEvents(recentEvents);
  const lines = [
    "**Bridge health**",
    `bot: ${config.botUsername ? `\`@${config.botUsername}\`` : "unknown username"}`,
    `chat: \`${String(message.chat.id)}\` (${message.chat.type || "unknown"})`,
    `topic: \`${message.message_thread_id ?? "direct/no-topic"}\``,
    `binding key: \`${bindingKey}\``,
    `native debug: \`${config.nativeDebugBaseUrl}\``,
    `app server: \`${config.appServerUrl}\``,
    `outbound mirror: ${config.outboundSyncEnabled === false ? "off" : `on (${config.outboundPollIntervalMs}ms poll)`}`,
    `status bar: ${config.statusBarEnabled === false ? "off" : "on"}`,
    `event log: \`${config.bridgeLogPath}\` (${eventSummary.total} sampled)`,
    `delivery: app-control ${eventSummary.appControlSends}, app-server fallback ${eventSummary.appServerFallbackSends}, native errors ${eventSummary.nativeSendErrors}, ops dm fallbacks ${eventSummary.opsDmFallbacks}`,
  ];

  if (binding) {
    lines.push(`binding thread: ${binding.threadId}`);
    if (binding.threadTitle) {
      lines.push(`binding title: ${binding.threadTitle}`);
    }
    if (binding.lastMirroredAt) {
      lines.push(`last mirrored: \`${binding.lastMirroredAt}\` (${binding.lastMirroredPhase || "assistant"})`);
    }
    if (binding.lastInboundMessageId != null) {
      lines.push(`last inbound message: \`${binding.lastInboundMessageId}\``);
    }
    if (Array.isArray(binding.lastOutboundMessageIds) && binding.lastOutboundMessageIds.length) {
      lines.push(`last outbound messages: \`${binding.lastOutboundMessageIds.join(", ")}\``);
    }
    if (binding.statusBarMessageId) {
      lines.push(`status bar message: \`${binding.statusBarMessageId}\``);
    }
    if (binding.statusBarUpdatedAt) {
      lines.push(`status bar updated: \`${binding.statusBarUpdatedAt}\``);
    }
    if (binding.lastTransportPath) {
      lines.push(`last transport path: \`${binding.lastTransportPath}\``);
    }
    if (binding.lastTransportErrorAt) {
      lines.push(
        `last transport error: \`${binding.lastTransportErrorKind || "send_failed"}\` at \`${binding.lastTransportErrorAt}\``,
      );
    }
  } else {
    lines.push("binding: none");
  }

  try {
    const { projectGroup } = await loadProjectGroupForMessage(config, message);
    if (projectGroup) {
      lines.push(`project group: ${projectGroup.groupTitle}`);
      lines.push(`project root: \`${projectGroup.projectRoot}\``);
      lines.push(`bootstrap topics: ${projectGroup.topics.length}`);
    } else {
      lines.push("warning: chat not found in bootstrap result");
    }
  } catch (error) {
    lines.push(`warning: project index unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (binding) {
    try {
      const thread = await getThreadById(config.threadsDbPath, binding.threadId);
      if (!thread) {
        lines.push(`warning: thread ${binding.threadId} missing in threads DB`);
      } else {
        lines.push(`thread cwd: \`${thread.cwd}\``);
        lines.push(`thread archived: ${Number(thread.archived) !== 0 ? "yes" : "no"}`);
      }
    } catch (error) {
      lines.push(`warning: threads lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (message.chat.type === "supergroup" || message.chat.type === "group") {
    lines.push(
      config.botUsername
        ? `hint: if plain text in the topic does not reach the bot, check bot privacy mode or write @${config.botUsername} your request`
        : "hint: if plain text in the topic does not reach the bot, check bot privacy mode",
    );
  }

  if (eventSummary.recentFailures.length) {
    lines.push("recent failures:");
    for (const event of eventSummary.recentFailures) {
      const at = event.ts ? ` ${event.ts}` : "";
      const key = event.bindingKey ? ` ${event.bindingKey}` : "";
      const detail = event.error ? ` - ${String(event.error).replace(/\s+/g, " ").slice(0, 180)}` : "";
      lines.push(`- ${event.type}${at}${key}${detail}`);
    }
  } else {
    lines.push("recent failures: none in sampled log");
  }

  return lines.join("\n");
}

function parseSyncProjectArgs(args, defaultLimit) {
  const dryRun = args.some((arg) => /^(dry-run|--dry-run)$/i.test(String(arg)));
  const numericArg = args.find((arg) => /^\d+$/.test(String(arg)));
  const requestedLimit = clamp(parsePositiveInt(numericArg, defaultLimit), 1, 10);
  return {
    dryRun,
    requestedLimit,
  };
}

async function buildSyncContext(config, state, message, requestedLimit) {
  const { projectGroup } = await loadProjectGroupForMessage(config, message);
  if (!projectGroup) {
    return {
      projectGroup: null,
      diagnostics: null,
      plan: null,
    };
  }

  const diagnostics = await collectChatBindingDiagnostics(config, state, message.chat.id);
  const threads = await listProjectThreads(config.threadsDbPath, projectGroup.projectRoot, {
    limit: requestedLimit,
  });
  const plan = buildProjectSyncPlan({
    entries: diagnostics.entries,
    threads,
    requestedLimit,
  });

  return {
    projectGroup,
    diagnostics,
    plan,
  };
}

function formatBindingLine(entry, thread) {
  const tags = [];
  if (isSyncManagedBinding(entry.binding)) {
    tags.push(isClosedSyncBinding(entry.binding) ? "sync-parked" : "sync");
  } else {
    tags.push("manual");
  }
  if (entry.binding.transport) {
    tags.push(entry.binding.transport);
  }
  return `- topic ${entry.binding.messageThreadId ?? "direct"} -> ${sanitizeTopicTitle(
    thread?.title || entry.binding.threadTitle,
    entry.binding.threadId,
  )} (${entry.binding.threadId}) [${tags.join(", ")}]`;
}

function renderSyncPreview(plan) {
  const lines = [
    `sync preview: keep ${plan.summary.keepCount}, rename ${plan.summary.renameCount}, reopen ${plan.summary.reopenCount}, create ${plan.summary.createCount}, park ${plan.summary.parkCount}`,
  ];

  if (plan.rename.length) {
    lines.push("", "**Rename sync topics**");
    for (const item of plan.rename) {
      lines.push(
        `- topic ${item.entry.binding.messageThreadId}: ${sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId)} -> ${sanitizeTopicTitle(item.thread.title, item.thread.id)}`,
      );
    }
  }

  if (plan.reopen.length) {
    lines.push("", "**Reopen parked sync topics**");
    for (const item of plan.reopen) {
      const action = item.renameNeeded ? "reopen + rename" : "reopen";
      lines.push(`- topic ${item.entry.binding.messageThreadId}: ${action} -> ${sanitizeTopicTitle(item.thread.title, item.thread.id)} (${item.thread.id})`);
    }
  }

  if (plan.create.length) {
    lines.push("", "**Create topics**");
    for (const item of plan.create) {
      lines.push(formatThreadBullet(item.thread));
    }
  }

  if (plan.park.length) {
    lines.push("", "**Park stale sync topics**");
    for (const item of plan.park) {
      lines.push(
        `- topic ${item.entry.binding.messageThreadId}: ${sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId)} (${item.entry.binding.threadId}) [${item.reason}]`,
      );
    }
  }

  if (
    plan.rename.length === 0 &&
    plan.reopen.length === 0 &&
    plan.create.length === 0 &&
    plan.park.length === 0
  ) {
    lines.push("", "sync preview: already aligned");
  }

  return lines.join("\n");
}

async function renderProjectStatus(config, state, message, requestedLimit) {
  const { projectGroup, diagnostics, plan } = await buildSyncContext(config, state, message, requestedLimit);
  if (!projectGroup || !diagnostics || !plan) {
    return "I cannot find a project mapping for this group. Bootstrap is incomplete, or this chat id is different.";
  }

  const lines = [
    `**Project status:** ${projectGroup.groupTitle}`,
    `project root: \`${projectGroup.projectRoot}\``,
    `desired thread column: ${plan.summary.desiredCount}`,
    `active bindings in this chat: ${plan.summary.activeCount}`,
    `parked sync topics: ${plan.summary.parkedCount}`,
    `bootstrap topics: ${projectGroup.topics.length}`,
    `stale bindings: ${diagnostics.issues.length}`,
  ];

  if (plan.desiredThreads.length) {
    lines.push("", "**Desired thread column**");
    for (const thread of plan.desiredThreads) {
      lines.push(formatThreadBullet(thread));
    }
  } else {
    lines.push("", "Desired thread column: empty");
  }

  if (plan.activeEntries.length) {
    lines.push("", "**Current active topics**");
    for (const entry of plan.activeEntries.slice(0, 12)) {
      const thread = diagnostics.threadsById.get(String(entry.binding.threadId)) ?? null;
      lines.push(formatBindingLine(entry, thread));
    }
  } else {
    lines.push("", "Current active topics: none");
  }

  if (plan.parkedEntries.length) {
    lines.push("", "**Parked sync topics**");
    for (const entry of plan.parkedEntries.slice(0, 12)) {
      const thread = diagnostics.threadsById.get(String(entry.binding.threadId)) ?? null;
      lines.push(formatBindingLine(entry, thread));
    }
  }

  if (diagnostics.issues.length) {
    lines.push("", "**Stale bindings**");
    lines.push(...diagnostics.issues);
  }

  lines.push("", "**Sync plan**");
  lines.push(renderSyncPreview(plan));

  return lines.join("\n");
}

async function validateBindingForSend(config, binding) {
  if (isClosedSyncBinding(binding)) {
    return {
      ok: false,
      message: "This sync-managed topic is parked and should not be used as an active work chat. Run `/sync-project` to bring it back into the active set.",
    };
  }
  try {
    const thread = await getThreadById(config.threadsDbPath, binding.threadId);
    if (!thread) {
      return {
        ok: false,
        message: `This binding points to thread ${binding.threadId}, which is no longer in the local Codex DB. Use /detach and bind it again.`,
      };
    }
    if (Number(thread.archived) !== 0) {
      return {
        ok: false,
        message: `This binding points to archived thread ${binding.threadId}. Use /detach and pick an active thread.`,
      };
    }
    return { ok: true, thread };
  } catch (error) {
    logBridgeEvent("binding_validation_error", {
      threadId: binding.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: true, thread: null };
  }
}

async function handleCommand({ config, state, message, bindingKey, binding, parsed }) {
  switch (parsed.command) {
    case "/help":
    case "/start":
      await sendCommandResponse({
        config,
        message,
        text: renderHelp(config),
        quietInTopic: true,
        topicSummary: "I sent the help text to your direct chat with the bot to keep this topic clean.",
      });
      return true;

    case "/attach": {
      const threadId = parsed.args[0];
      if (!threadId) {
        await reply(config.botToken, message, "Missing thread id: /attach <thread-id>");
        return true;
      }
      removeOutboundMirror(state, bindingKey);
      setBinding(state, bindingKey, {
        threadId,
        transport: "native",
        chatId: String(message.chat.id),
        messageThreadId: message.message_thread_id ?? null,
        chatTitle: normalizeText(message.chat.title || message.chat.username || message.chat.first_name || ""),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const nextBinding = getBinding(state, bindingKey);
      const sent = await reply(config.botToken, message, `Bound this chat to thread ${threadId} via native transport.`);
      rememberOutbound(nextBinding, sent);
      return true;
    }

    case "/attach-latest": {
      if (message.message_thread_id == null) {
        await reply(config.botToken, message, "This command only makes sense inside a forum topic.");
        return true;
      }
      if (binding) {
        await reply(
          config.botToken,
          message,
          `This topic is already bound to ${binding.threadId}. If you want to move it, run /detach first.`,
        );
        return true;
      }

      const { projectGroup } = await loadProjectGroupForMessage(config, message);
      if (!projectGroup) {
        await reply(
          config.botToken,
          message,
          "I cannot find a project mapping for this group. Run bootstrap first, or bind manually.",
        );
        return true;
      }

      const boundThreadIds = getBoundThreadIdsForChat(state, message.chat.id);
      const candidates = await listProjectThreads(config.threadsDbPath, projectGroup.projectRoot, { limit: 12 });
      const nextThread = candidates.find((thread) => !boundThreadIds.has(String(thread.id)));

      if (!nextThread) {
        await reply(config.botToken, message, "I do not see any fresh unbound threads here right now.");
        return true;
      }

      const nextBinding = setBinding(
        state,
        bindingKey,
        buildBindingPayload({
          message,
          thread: nextThread,
          chatTitle: projectGroup.groupTitle,
        }),
      );
      removeOutboundMirror(state, bindingKey);
      const sent = await reply(
        config.botToken,
        message,
        `Bound this topic to a fresh thread.\nthread: ${nextThread.id}\ntitle: ${sanitizeTopicTitle(nextThread.title, nextThread.id)}`,
      );
      rememberOutbound(nextBinding, sent);
      return true;
    }

    case "/detach":
      if (!binding) {
        await reply(config.botToken, message, "There is no binding here already.");
        return true;
      }
      removeBinding(state, bindingKey);
      removeOutboundMirror(state, bindingKey);
      await reply(config.botToken, message, `Detached thread ${binding.threadId}.`);
      return true;

    case "/status":
      if (!binding) {
        await reply(config.botToken, message, "No binding here. Use /attach <thread-id>.");
        return true;
      }
      rememberOutbound(binding, await reply(config.botToken, message, await renderBindingStatus(config, bindingKey, binding)));
      return true;

    case "/health":
      rememberOutbound(
        binding,
        await sendCommandResponse({
          config,
          message,
          text: await renderHealth(config, state, message, bindingKey, binding),
          quietInTopic: true,
          topicSummary: "I sent the health report to your direct chat with the bot to keep this topic clean.",
        }),
      );
      return true;

    case "/settings":
    case "/config":
      rememberOutbound(
        binding,
        await sendCommandResponse({
          config,
          message,
          text: buildSettingsReport({ config, state, bindingKey, binding }),
          quietInTopic: true,
          topicSummary: "I sent the runtime settings to your direct chat with the bot to keep this topic clean.",
        }),
      );
      return true;

    case "/project-status": {
      const requestedLimit = clamp(parsePositiveInt(parsed.args[0], config.syncDefaultLimit), 1, 10);
      rememberOutbound(
        binding,
        await sendCommandResponse({
          config,
          message,
          text: await renderProjectStatus(config, state, message, requestedLimit),
          quietInTopic: true,
          topicSummary: "I sent the project summary to your direct chat with the bot to keep this topic clean.",
        }),
      );
      return true;
    }

    case "/sync-project": {
      const { dryRun, requestedLimit } = parseSyncProjectArgs(parsed.args, config.syncDefaultLimit);
      const { projectGroup, plan } = await buildSyncContext(config, state, message, requestedLimit);
      if (!projectGroup || !plan) {
        await reply(
          config.botToken,
          message,
          "I cannot find a project mapping for this group. Bootstrap is incomplete, or this chat id is different.",
        );
        return true;
      }

      const previewText = [
        dryRun ? `**Dry-run:** ${projectGroup.groupTitle}` : `**Sync plan:** ${projectGroup.groupTitle}`,
        `desired thread column: ${plan.summary.desiredCount}`,
        renderSyncPreview(plan),
      ].join("\n\n");

      if (dryRun) {
        await sendCommandResponse({
          config,
          message,
          text: previewText,
          quietInTopic: true,
          topicSummary: "I sent the `/sync-project` preview to your direct chat with the bot to keep this topic clean.",
        });
        return true;
      }

      const now = new Date().toISOString();
      const parkCurrentTopic = new Set(
        plan.park
          .filter((item) => item.entry.bindingKey === bindingKey)
          .map((item) => item.entry.bindingKey),
      );
      const parkBeforeReply = plan.park.filter((item) => !parkCurrentTopic.has(item.entry.bindingKey));
      const parkAfterReply = plan.park.filter((item) => parkCurrentTopic.has(item.entry.bindingKey));
      const changed = {
        renamed: [],
        reopened: [],
        created: [],
        parked: [],
      };

      for (const item of plan.rename) {
        const nextTitle = sanitizeTopicTitle(item.thread.title, item.thread.id);
        await editForumTopic(config.botToken, {
          chatId: message.chat.id,
          messageThreadId: item.entry.binding.messageThreadId,
          name: nextTitle,
        });
        state.bindings[item.entry.bindingKey] = {
          ...item.entry.binding,
          threadTitle: nextTitle,
          syncManaged: true,
          syncState: "active",
          topicStatus: "open",
          updatedAt: now,
          lastSyncedAt: now,
        };
        changed.renamed.push({
          topicId: item.entry.binding.messageThreadId,
          title: nextTitle,
          threadId: String(item.thread.id),
        });
      }

      for (const item of plan.reopen) {
        await reopenForumTopic(config.botToken, {
          chatId: message.chat.id,
          messageThreadId: item.entry.binding.messageThreadId,
        });
        const nextTitle = sanitizeTopicTitle(item.thread.title, item.thread.id);
        if (item.renameNeeded) {
          await editForumTopic(config.botToken, {
            chatId: message.chat.id,
            messageThreadId: item.entry.binding.messageThreadId,
            name: nextTitle,
          });
        }
        state.bindings[item.entry.bindingKey] = {
          ...item.entry.binding,
          threadTitle: nextTitle,
          syncManaged: true,
          syncState: "active",
          topicStatus: "open",
          updatedAt: now,
          lastSyncedAt: now,
        };
        changed.reopened.push({
          topicId: item.entry.binding.messageThreadId,
          title: nextTitle,
          threadId: String(item.thread.id),
        });
      }

      for (const item of plan.create) {
        const { thread } = item;
        const topic = await createForumTopic(config.botToken, {
          chatId: message.chat.id,
          name: sanitizeTopicTitle(thread.title, thread.id),
        });
        const topicId = Number(topic?.message_thread_id);
        if (!Number.isInteger(topicId)) {
          throw new Error(`createForumTopic returned invalid message_thread_id for ${thread.id}`);
        }
        const topicBindingKey = makeBindingKey({
          chatId: message.chat.id,
          messageThreadId: topicId,
        });
        setBinding(state, topicBindingKey, {
          ...buildBindingPayload({
            message: {
              ...message,
              message_thread_id: topicId,
            },
            thread,
            chatTitle: projectGroup.groupTitle,
          }),
          createdBy: SYNC_PROJECT_CREATOR,
          syncManaged: true,
          syncState: "active",
          topicStatus: "open",
          lastSyncedAt: now,
        });
        changed.created.push({
          topicId,
          title: sanitizeTopicTitle(thread.title, thread.id),
          threadId: String(thread.id),
        });
      }

      for (const item of parkBeforeReply) {
        await closeForumTopic(config.botToken, {
          chatId: message.chat.id,
          messageThreadId: item.entry.binding.messageThreadId,
        });
        state.bindings[item.entry.bindingKey] = {
          ...item.entry.binding,
          syncManaged: true,
          syncState: "closed",
          topicStatus: "closed",
          updatedAt: now,
          lastSyncedAt: now,
        };
        changed.parked.push({
          topicId: item.entry.binding.messageThreadId,
          title: sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId),
          threadId: String(item.entry.binding.threadId),
          reason: item.reason,
        });
      }

      const lines = [
        `Synced the working set for ${projectGroup.groupTitle}.`,
        `rename ${changed.renamed.length}, reopen ${changed.reopened.length}, create ${changed.created.length}, park ${plan.park.length}`,
      ];
      if (changed.renamed.length) {
        lines.push("", "**Renamed**");
        lines.push(...changed.renamed.map((item) => `- topic ${item.topicId}: ${item.title} -> ${item.threadId}`));
      }
      if (changed.reopened.length) {
        lines.push("", "**Reopened**");
        lines.push(...changed.reopened.map((item) => `- topic ${item.topicId}: ${item.title} -> ${item.threadId}`));
      }
      if (changed.created.length) {
        lines.push("", "**Created**");
        lines.push(...changed.created.map((item) => `- topic ${item.topicId}: ${item.title} -> ${item.threadId}`));
      }
      if (plan.park.length) {
        lines.push("", "**Parked**");
        const parkedLines = [
          ...changed.parked,
          ...parkAfterReply.map((item) => ({
            topicId: item.entry.binding.messageThreadId,
            title: sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId),
            threadId: String(item.entry.binding.threadId),
            reason: item.reason,
          })),
        ];
        lines.push(...parkedLines.map((item) => `- topic ${item.topicId}: ${item.title} -> ${item.threadId} [${item.reason}]`));
      }
      if (
        changed.renamed.length === 0 &&
        changed.reopened.length === 0 &&
        changed.created.length === 0 &&
        plan.park.length === 0
      ) {
        lines.push("", "Already aligned. Nothing had to change.");
      }
      await sendCommandResponse({
        config,
        message,
        text: lines.join("\n"),
        quietInTopic: true,
        topicSummary:
          plan.park.length > 0
            ? "Working set synced; I sent the details to your direct chat with the bot."
            : "Working set is already aligned; I sent the details to your direct chat with the bot.",
      });

      for (const item of parkAfterReply) {
        try {
          await closeForumTopic(config.botToken, {
            chatId: message.chat.id,
            messageThreadId: item.entry.binding.messageThreadId,
          });
          state.bindings[item.entry.bindingKey] = {
            ...item.entry.binding,
            syncManaged: true,
            syncState: "closed",
            topicStatus: "closed",
            updatedAt: now,
            lastSyncedAt: now,
          };
          changed.parked.push({
            topicId: item.entry.binding.messageThreadId,
            title: sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId),
            threadId: String(item.entry.binding.threadId),
            reason: item.reason,
          });
        } catch (error) {
          logBridgeEvent("sync_project_park_after_reply_error", {
            chatId: message.chat.id,
            messageThreadId: item.entry.binding.messageThreadId,
            threadId: item.entry.binding.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return true;
    }

    case "/mode": {
      const mode = normalizeText(parsed.args[0] || "");
      if (!binding) {
        await reply(config.botToken, message, "Bind a thread first: /attach <thread-id>.");
        return true;
      }
      if (mode !== "native") {
        await reply(
          config.botToken,
          message,
          "v1 only supports native transport. Heartbeat transport is intentionally left for phase 2.",
        );
        return true;
      }
      binding.transport = "native";
      binding.updatedAt = new Date().toISOString();
      rememberOutbound(binding, await reply(config.botToken, message, "OK, transport = native."));
      return true;
    }

    default:
      await reply(config.botToken, message, "Unknown command. /help shows the available options.");
      return true;
  }
}

async function handlePlainText({ config, state, message, bindingKey, binding }) {
  if (!binding) {
    await reply(config.botToken, message, "No binding here. Use /attach <thread-id>.");
    return;
  }

  if ((binding.transport || "native") !== "native") {
    await reply(config.botToken, message, "This v1 bridge only supports native transport.");
    return;
  }

  const prompt = normalizeInboundPrompt(message.text, {
    botUsername: config.botUsername,
  });
  if (!prompt) {
    await reply(config.botToken, message, "The text is empty. If you mention the bot, put the actual request after the mention.");
    return;
  }

  const bindingValidation = await validateBindingForSend(config, binding);
  if (!bindingValidation.ok) {
    await reply(config.botToken, message, bindingValidation.message);
    return;
  }

  binding.lastInboundMessageId = message.message_id ?? null;
  binding.currentTurn = {
    source: "telegram",
    startedAt: new Date().toISOString(),
    promptPreview: makePromptPreview(prompt),
  };
  binding.updatedAt = new Date().toISOString();
  state.bindings[bindingKey] = binding;
  rememberOutboundMirrorSuppression(state, bindingKey, prompt, {
    role: "user",
    phase: null,
  });
  await refreshStatusBars({ config, state, onlyBindingKey: bindingKey });
  await saveState(config.statePath, state);

  if (config.sendTyping) {
    await sendTyping(config.botToken, buildTargetFromMessage(message)).catch(() => null);
  }

  const target = buildTargetFromMessage(message);
  const receipt = await replyPlain(config.botToken, message, getInitialProgressText());
  const receiptMessageId = receipt[0]?.message_id ?? null;
  rememberOutbound(binding, receipt);
  const progressBubble = startProgressBubble({
    token: config.botToken,
    target,
    messageId: receiptMessageId,
    onError(error) {
      logBridgeEvent("progress_bubble_error", {
        threadId: binding.threadId,
        bindingKey,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  try {
    const result = await sendNativeTurn({
      helperPath: config.nativeHelperPath,
      fallbackHelperPath: config.nativeFallbackHelperPath,
      threadId: binding.threadId,
      prompt,
      timeoutMs: config.nativeTimeoutMs,
      debugBaseUrl: config.nativeDebugBaseUrl,
      appServerUrl: config.appServerUrl,
      pollIntervalMs: config.nativePollIntervalMs,
    });
    binding.updatedAt = new Date().toISOString();
    binding.lastTransportPath = result.transportPath || null;
    delete binding.lastTransportErrorAt;
    delete binding.lastTransportErrorKind;
    logBridgeEvent("native_send_success", {
      threadId: binding.threadId,
      bindingKey,
      transportPath: binding.lastTransportPath,
      primaryError: result.primaryError || null,
    });
    delete binding.currentTurn;
    state.bindings[bindingKey] = binding;
    await progressBubble.stop();
    const replyText = normalizeText(result?.reply?.text) || "(empty reply)";
    const deliveredReplyText = appendTransportNotice(replyText, result);
    const sent = receiptMessageId
      ? await editThenSendRichTextChunks(config.botToken, target, receiptMessageId, deliveredReplyText)
      : await reply(config.botToken, message, deliveredReplyText);
    rememberOutbound(binding, sent);
    rememberOutboundMirrorSuppression(state, bindingKey, replyText, {
      role: "assistant",
      phase: "final_answer",
    });
  } catch (error) {
    await progressBubble.stop();
    delete binding.currentTurn;
    binding.updatedAt = new Date().toISOString();
    binding.lastTransportErrorAt = new Date().toISOString();
    binding.lastTransportErrorKind = normalizeText(error?.kind) || "send_failed";
    state.bindings[bindingKey] = binding;
    logBridgeEvent("native_send_error", {
      threadId: binding.threadId,
      bindingKey,
      kind: binding.lastTransportErrorKind,
      attempts: Array.isArray(error?.attempts) ? error.attempts : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    const errorText = renderNativeSendError(error);
    const sent = receiptMessageId
      ? await editThenSendRichTextChunks(config.botToken, target, receiptMessageId, errorText)
      : await reply(config.botToken, message, errorText);
    rememberOutbound(binding, sent);
  }
}

async function processMessage({ config, state, message }) {
  if (!message?.chat?.id) {
    return false;
  }
  if (message?.from?.is_bot) {
    return false;
  }
  if (!isAuthorized(config, message)) {
    return false;
  }
  if (isTelegramServiceMessage(message)) {
    logBridgeEvent("skip_service_message", {
      chatId: message.chat.id,
      messageId: message.message_id ?? null,
      messageThreadId: message.message_thread_id ?? null,
      serviceKeys: TELEGRAM_SERVICE_MESSAGE_KEYS.filter((key) => key in message),
    });
    return false;
  }
  if (typeof message.text !== "string" || !message.text.trim()) {
    await reply(config.botToken, message, "I only understand text for now. Images and files are coming later.");
    return true;
  }

  const bindingKey = makeBindingKey({
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id ?? null,
  });
  const binding = getBinding(state, bindingKey);
  const parsed = parseCommand(message.text);
  try {
    if (parsed) {
      return await handleCommand({ config, state, message, bindingKey, binding, parsed });
    }
    return await handlePlainText({ config, state, message, bindingKey, binding });
  } catch (error) {
    logBridgeEvent("process_message_error", {
      chatId: message.chat.id,
      messageId: message.message_id ?? null,
      bindingKey,
      command: parsed?.command || null,
      error: error instanceof Error ? error.message : String(error),
    });
    await reply(
      config.botToken,
      message,
      parsed
        ? "I could not run that command. Short version is here; technical details are in the log."
        : "I could not process this message. The bridge is alive, but this request stumbled; details are in the log.",
    );
    return true;
  }
}

async function syncOutboundMirrors({ config, state }) {
  if (config.outboundSyncEnabled === false) {
    return { delivered: 0, suppressed: 0, changed: false };
  }

  const bindingEntries = Object.entries(state.bindings ?? {}).filter(([, binding]) =>
    isOutboundMirrorBindingEligible(binding),
  );
  if (bindingEntries.length === 0) {
    return { delivered: 0, suppressed: 0, changed: false };
  }

  const threads = await getThreadsByIds(
    config.threadsDbPath,
    bindingEntries.map(([, binding]) => binding.threadId),
  );
  const threadsById = new Map(threads.map((thread) => [String(thread.id), thread]));

  let delivered = 0;
  let suppressed = 0;
  let changed = false;

  for (const [bindingKey, binding] of bindingEntries) {
    const thread = threadsById.get(String(binding.threadId));
    if (!thread?.rollout_path || Number(thread.archived) !== 0) {
      continue;
    }

    const previousMirror = getOutboundMirror(state, bindingKey);
    let delta;
    try {
      delta = await readThreadMirrorDelta({
        rolloutPath: thread.rollout_path,
        mirrorState: previousMirror,
        threadId: binding.threadId,
        phases: config.outboundMirrorPhases,
      });
    } catch (error) {
      logBridgeEvent("outbound_mirror_scan_error", {
        bindingKey,
        threadId: binding.threadId,
        rolloutPath: thread.rollout_path,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const carryPending =
      previousMirror?.threadId === binding.threadId && previousMirror?.rolloutPath === delta.mirror.rolloutPath
        ? Array.isArray(previousMirror?.pendingMessages)
          ? previousMirror.pendingMessages
          : []
        : [];
    const queuedMessages = [...carryPending, ...delta.messages];
    let pendingMessages = [];
    let lastSignature = normalizeText(delta.mirror.lastSignature) || null;
    let replyTargetMessageId = Number.isInteger(previousMirror?.replyTargetMessageId)
      ? previousMirror.replyTargetMessageId
      : null;

    for (let index = 0; index < queuedMessages.length; index += 1) {
      const message = queuedMessages[index];
      if (!message?.text || !message?.signature || !message?.role) {
        continue;
      }

      if (consumeOutboundSuppression(state, bindingKey, message.signature)) {
        lastSignature = message.signature;
        if (message.role === "user") {
          replyTargetMessageId = Number.isInteger(binding.lastInboundMessageId) ? binding.lastInboundMessageId : null;
        } else if (message.role === "assistant") {
          if (isFinalAssistantMirrorMessage(message)) {
            replyTargetMessageId = null;
            delete binding.currentTurn;
          }
        }
        suppressed += 1;
        changed = true;
        continue;
      }

      try {
        const target = {
          chatId: binding.chatId,
          messageThreadId: binding.messageThreadId ?? null,
        };
        const isFinalAssistant = isFinalAssistantMirrorMessage(message);
        const isCommentaryAssistant = isCommentaryAssistantMirrorMessage(message);
        let sent = [];
        if (message.role === "user") {
          sent = await sendRichTextChunks(config.botToken, target, formatOutboundUserMirrorText(message.text, config));
        } else if (isCommentaryAssistant) {
          sent = await upsertOutboundProgressMessage({
            config,
            binding,
            target,
            replyToMessageId: replyTargetMessageId,
            message,
          });
        } else {
          sent = await sendRichTextChunks(config.botToken, target, formatOutboundAssistantMirrorText(message), replyTargetMessageId);
          if (isFinalAssistant) {
            await completeOutboundProgressMessage({ config, binding, target });
          }
        }
        rememberOutbound(binding, sent);
        binding.updatedAt = new Date().toISOString();
        binding.lastMirroredAt = message.timestamp || binding.updatedAt;
        binding.lastMirroredPhase = message.phase || message.role;
        binding.lastMirroredRole = message.role;
        state.bindings[bindingKey] = binding;
        if (message.role === "user") {
          replyTargetMessageId = sent[0]?.message_id ?? replyTargetMessageId;
          binding.lastMirroredUserMessageId = replyTargetMessageId;
          binding.currentTurn = {
            source: "codex",
            startedAt: message.timestamp || new Date().toISOString(),
            promptPreview: makePromptPreview(message.text),
          };
        } else if (isFinalAssistant) {
          replyTargetMessageId = null;
          delete binding.currentTurn;
        }
        lastSignature = message.signature;
        delivered += 1;
        changed = true;
      } catch (error) {
        pendingMessages = queuedMessages.slice(index);
        logBridgeEvent("outbound_mirror_delivery_error", {
          bindingKey,
          threadId: binding.threadId,
          rolloutPath: thread.rollout_path,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    const liveMirror = getOutboundMirror(state, bindingKey);
    const nextSuppressions = Array.isArray(liveMirror?.suppressions)
      ? liveMirror.suppressions.filter((item) => item !== lastSignature)
      : [];
    const nextMirror = {
      ...delta.mirror,
      threadId: binding.threadId,
      rolloutPath: thread.rollout_path,
      lastSignature,
      pendingMessages,
      replyTargetMessageId,
      suppressions: nextSuppressions,
    };
    if (JSON.stringify(previousMirror ?? null) !== JSON.stringify(nextMirror)) {
      setOutboundMirror(state, bindingKey, nextMirror);
      changed = true;
    }
  }

  return { delivered, suppressed, changed };
}

async function reserveStatusBarMessage({ config, bindingKey, binding, text }) {
  const sent = await sendMessage(config.botToken, {
    chatId: binding.chatId,
    messageThreadId: binding.messageThreadId,
    text,
  });
  const messageId = sent?.message_id;
  if (!Number.isInteger(messageId)) {
    throw new Error(`status bar reserve returned invalid message_id for ${bindingKey}`);
  }

  if (config.statusBarPin !== false) {
    try {
      await pinChatMessage(config.botToken, {
        chatId: binding.chatId,
        messageId,
        disableNotification: true,
      });
      binding.statusBarPinnedAt = new Date().toISOString();
    } catch (error) {
      logBridgeEvent("status_bar_pin_error", {
        bindingKey,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  binding.statusBarMessageId = messageId;
  return messageId;
}

async function refreshStatusBars({ config, state, onlyBindingKey = null } = {}) {
  if (config.statusBarEnabled === false) {
    return { changed: false, updated: 0 };
  }

  const bindingEntries = Object.entries(state.bindings ?? {}).filter(([bindingKey, binding]) => {
    if (onlyBindingKey && bindingKey !== onlyBindingKey) {
      return false;
    }
    return isStatusBarBindingEligible(binding);
  });
  if (bindingEntries.length === 0) {
    return { changed: false, updated: 0 };
  }

  const threads = await getThreadsByIds(
    config.threadsDbPath,
    bindingEntries.map(([, binding]) => binding.threadId),
  );
  const threadsById = new Map(threads.map((thread) => [String(thread.id), thread]));
  let changed = false;
  let updated = 0;

  for (const [bindingKey, binding] of bindingEntries) {
    const thread = threadsById.get(String(binding.threadId));
    if (!thread?.rollout_path || Number(thread.archived) !== 0) {
      continue;
    }

    let runtime = null;
    try {
      runtime = await readRolloutRuntimeStatus(thread.rollout_path, {
        tailBytes: config.statusBarTailBytes,
      });
    } catch (error) {
      logBridgeEvent("status_bar_runtime_error", {
        bindingKey,
        threadId: binding.threadId,
        rolloutPath: thread.rollout_path,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const text = buildStatusBarText({
      binding,
      thread,
      runtime,
      config,
    });
    const hash = makeStatusBarHash(text);
    if (binding.statusBarMessageId && binding.statusBarTextHash === hash) {
      continue;
    }

    try {
      if (!binding.statusBarMessageId) {
        await reserveStatusBarMessage({ config, bindingKey, binding, text });
      } else {
        try {
          await editMessageText(config.botToken, {
            chatId: binding.chatId,
            messageId: binding.statusBarMessageId,
            text,
          });
        } catch (error) {
          if (!isMissingStatusBarMessageError(error)) {
            throw error;
          }
          delete binding.statusBarMessageId;
          await reserveStatusBarMessage({ config, bindingKey, binding, text });
        }
      }
      binding.statusBarTextHash = hash;
      binding.statusBarUpdatedAt = new Date().toISOString();
      state.bindings[bindingKey] = binding;
      changed = true;
      updated += 1;
    } catch (error) {
      logBridgeEvent("status_bar_update_error", {
        bindingKey,
        threadId: binding.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { changed, updated };
}

async function checkpointMessage(statePath, state, update) {
  const updateId = Number.isInteger(update?.update_id) ? update.update_id : state.lastUpdateId;
  const messageKey = makeMessageKey(update.message);
  if (hasProcessedMessage(state, messageKey)) {
    state.lastUpdateId = Math.max(state.lastUpdateId, updateId);
    await saveState(statePath, state);
    return { messageKey, alreadyProcessed: true };
  }

  state.lastUpdateId = Math.max(state.lastUpdateId, updateId);
  markProcessedMessage(state, messageKey);
  await saveState(statePath, state);
  return { messageKey, alreadyProcessed: false };
}

async function hydrateBotIdentity(config) {
  if (config.botUsername) {
    return;
  }
  try {
    const me = await getMe(config.botToken);
    if (me?.username) {
      config.botUsername = String(me.username).replace(/^@+/, "");
    }
  } catch (error) {
    logBridgeEvent("telegram_me_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.configPath);
  const state = await loadState(config.statePath);
  const effectivePollTimeoutSeconds =
    config.outboundSyncEnabled === false
      ? config.pollTimeoutSeconds
      : Math.min(config.pollTimeoutSeconds, clamp(Math.ceil(config.outboundPollIntervalMs / 1000), 1, 10));

  await hydrateBotIdentity(config);

  if (args.selfCheck) {
    const report = await buildSelfCheckReport({ config, state });
    process.stdout.write(`${formatSelfCheckReport(report, config)}\n`);
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  let consecutivePollErrors = 0;
  while (true) {
    let updates = [];
    try {
      updates = await getUpdates(config.botToken, {
        offset: state.lastUpdateId > 0 ? state.lastUpdateId + 1 : 0,
        timeoutSeconds: effectivePollTimeoutSeconds,
        limit: 50,
      });
      consecutivePollErrors = 0;
    } catch (error) {
      consecutivePollErrors += 1;
      logBridgeEvent("poll_error", {
        consecutivePollErrors,
        error: error instanceof Error ? error.message : String(error),
      });
      await saveState(config.statePath, state);
      if (args.once) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 1000 * consecutivePollErrors)));
      continue;
    }

    for (const update of updates) {
      if (update?.message) {
        const checkpoint = await checkpointMessage(config.statePath, state, update);
        if (checkpoint.alreadyProcessed) {
          continue;
        }
        await processMessage({ config, state, message: update.message });
        await saveState(config.statePath, state);
      } else {
        state.lastUpdateId = Number.isInteger(update.update_id) ? update.update_id : state.lastUpdateId;
        await saveState(config.statePath, state);
      }
    }

    let syncResult = { changed: false };
    try {
      syncResult = await syncOutboundMirrors({ config, state });
    } catch (error) {
      logBridgeEvent("outbound_mirror_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let statusBarResult = { changed: false };
    try {
      statusBarResult = await refreshStatusBars({ config, state });
    } catch (error) {
      logBridgeEvent("status_bar_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (syncResult.changed || statusBarResult.changed) {
      await saveState(config.statePath, state);
    }

    if (args.once) {
      break;
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
