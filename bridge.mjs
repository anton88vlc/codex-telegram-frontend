#!/usr/bin/env node

import { statSync } from "node:fs";
import process from "node:process";

import { createNativeChat, sendNativeTurn } from "./lib/codex-native.mjs";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./lib/config.mjs";
import { AppServerLiveStream } from "./lib/app-server-live.mjs";
import { appendAppServerStreamBuffer, formatAppServerStreamProgressLine } from "./lib/app-server-stream.mjs";
import {
  CODEX_CHATS_SURFACE,
  PRIVATE_TOPIC_AUTO_CREATE_CREATOR,
  isThreadDbOptionalBinding,
} from "./lib/binding-classification.mjs";
import {
  configureBridgeEventLog,
  logBridgeEvent,
  readRecentBridgeEvents,
  summarizeBridgeEvents,
} from "./lib/bridge-events.mjs";
import {
  findFallbackTopicBindingForUnboundGroupMessage,
  normalizeInboundPrompt,
  normalizeText,
  parseCommand,
} from "./lib/message-routing.mjs";
import { appendTransportNotice, renderNativeSendError } from "./lib/native-ux.mjs";
import {
  appendOutboundProgressItem,
  formatOutboundProgressMirrorText,
} from "./lib/outbound-progress.mjs";
import { getInitialProgressText, startProgressBubble } from "./lib/progress-bubble.mjs";
import {
  getBindingsForChat,
  getBoundThreadIdsForChat,
  getProjectGroupForChat,
  loadProjectIndex,
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
import { inspectStateDoctor } from "./lib/state-doctor.mjs";
import { buildStatusBarMessage, makeStatusBarHash, readRolloutRuntimeStatus } from "./lib/status-bar.mjs";
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
import {
  clamp,
  findActiveThreadSuccessors,
  getThreadById,
  getThreadsByIds,
  listProjectThreads,
  parsePositiveInt,
} from "./lib/thread-db.mjs";
import { makeOutboundMirrorSignature, readThreadMirrorDelta } from "./lib/thread-rollout.mjs";
import {
  normalizeTypingHeartbeatIntervalMs,
  startTypingHeartbeat,
  stopTypingHeartbeats,
} from "./lib/typing-heartbeat.mjs";
import {
  buildTargetFromBinding,
  buildTargetFromMessage,
  formatUnboundGroupFallbackBubble,
  isPrivateTopicMessage,
  isTopicMessage,
  reply,
  replyPlain,
} from "./lib/telegram-targets.mjs";
import {
  chooseVoiceTranscriptionProvider,
  collectTelegramVoiceRefs,
  formatVoiceTranscriptBubble,
  formatVoiceTranscriptPrompt,
  formatVoiceTranscriptionReceipt,
  transcribeTelegramVoice,
} from "./lib/voice-transcription.mjs";
import {
  collectTelegramAttachments,
  formatAttachmentPrompt,
  formatAttachmentReceipt,
  getMessageIngressText,
  groupTelegramMediaGroupUpdates,
  hasUnsupportedTelegramMedia,
  saveTelegramAttachments,
} from "./lib/telegram-attachments.mjs";
import { formatWorktreeSummary, readGitHead, readWorktreeSummary, subtractWorktreeSummary } from "./lib/worktree-summary.mjs";
import {
  closeForumTopic,
  createForumTopic,
  downloadTelegramFile,
  editForumTopic,
  editThenSendRichTextChunks,
  editMessageText,
  getFile,
  getMe,
  getUpdates,
  pinChatMessage,
  reopenForumTopic,
  sendMessage,
  sendRichTextChunks,
  sendTyping,
} from "./lib/telegram.mjs";

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

async function rerouteUnboundGroupMessageToFallbackTopic({ config, state, message, promptText, attachmentRefs, voiceRefs }) {
  if (config.unboundGroupFallbackEnabled === false) {
    return null;
  }
  const fallback = findFallbackTopicBindingForUnboundGroupMessage(state, message, {
    maxAgeMs: config.unboundGroupFallbackMaxAgeMs,
  });
  if (!fallback?.binding) {
    return null;
  }

  const sent = await sendRichTextChunks(
    config.botToken,
    buildTargetFromBinding(fallback.binding),
    formatUnboundGroupFallbackBubble({
      message,
      promptText,
      attachmentRefs,
      voiceRefs,
    }),
  );
  const routedMessageId = sent[0]?.message_id;
  const routedMessage = {
    ...message,
    message_id: Number.isInteger(routedMessageId) ? routedMessageId : message.message_id,
    message_thread_id: fallback.binding.messageThreadId ?? message.message_thread_id ?? null,
    routedFromMessage: {
      chatId: String(message.chat.id),
      messageThreadId: message.message_thread_id ?? null,
      messageId: message.message_id ?? null,
    },
  };
  fallback.binding.lastUnboundFallbackAt = new Date().toISOString();
  fallback.binding.lastUnboundFallbackFrom = routedMessage.routedFromMessage;
  fallback.binding.updatedAt = fallback.binding.lastUnboundFallbackAt;
  state.bindings[fallback.bindingKey] = fallback.binding;
  rememberOutbound(fallback.binding, sent);
  logBridgeEvent("unbound_group_message_rerouted", {
    chatId: message.chat.id,
    fromMessageThreadId: message.message_thread_id ?? null,
    fromMessageId: message.message_id ?? null,
    toMessageThreadId: fallback.binding.messageThreadId ?? null,
    toMessageId: Number.isInteger(routedMessageId) ? routedMessageId : null,
    bindingKey: fallback.bindingKey,
    threadId: fallback.binding.threadId,
    activityMs: fallback.activityMs,
  });
  return {
    bindingKey: fallback.bindingKey,
    binding: fallback.binding,
    message: routedMessage,
  };
}

function isTelegramServiceMessage(message) {
  return TELEGRAM_SERVICE_MESSAGE_KEYS.some((key) => key in (message || {}));
}

function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function appControlCooldownUntilMs(binding) {
  return parseTimestampMs(binding?.appControlCooldownUntil);
}

function shouldPreferAppServer(binding, config, nowMs = Date.now()) {
  if (!config.nativeFallbackHelperPath) {
    return false;
  }
  if (config.nativeIngressTransport === "app-server") {
    return true;
  }
  return Boolean(appControlCooldownUntilMs(binding) > nowMs);
}

function markAppControlCooldown(binding, config, error, nowMs = Date.now()) {
  const cooldownMs = Math.max(0, Number(config.appControlCooldownMs) || 0);
  if (!cooldownMs) {
    return null;
  }
  const kind = normalizeText(error?.kind) || "send_failed";
  const until = new Date(nowMs + cooldownMs).toISOString();
  binding.appControlCooldownUntil = until;
  binding.lastTransportErrorAt = new Date(nowMs).toISOString();
  binding.lastTransportErrorKind = kind;
  return until;
}

function markTransportError(binding, error, nowMs = Date.now()) {
  binding.lastTransportErrorAt = new Date(nowMs).toISOString();
  binding.lastTransportErrorKind = normalizeText(error?.kind) || "send_failed";
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

function getPrivateTopicTitleStore(state) {
  if (!state.privateTopicTitles || typeof state.privateTopicTitles !== "object") {
    state.privateTopicTitles = {};
  }
  return state.privateTopicTitles;
}

function isGenericPrivateTopicTitle(title) {
  const normalized = normalizeText(title).toLowerCase();
  return ["new thread", "new topic", "new chat", "новая тема", "новый тред", "nuevo tema"].includes(normalized);
}

function rememberPrivateTopicTitle(state, message) {
  if (!isPrivateTopicMessage(message)) {
    return false;
  }
  const topicTitle = normalizeText(message?.forum_topic_created?.name);
  if (!topicTitle) {
    return false;
  }
  const bindingKey = makeBindingKey({
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id,
  });
  getPrivateTopicTitleStore(state)[bindingKey] = {
    title: sanitizeTopicTitle(topicTitle, "New Codex Chat"),
    updatedAt: new Date().toISOString(),
    messageId: message.message_id ?? null,
  };
  return true;
}

function makePrivateTopicChatTitle({ state, bindingKey, message }) {
  const remembered = normalizeText(getPrivateTopicTitleStore(state)?.[bindingKey]?.title);
  if (remembered && !isGenericPrivateTopicTitle(remembered)) {
    return sanitizeTopicTitle(remembered, "New Codex Chat");
  }

  const serviceTitle = normalizeText(message?.reply_to_message?.forum_topic_created?.name);
  if (serviceTitle && !isGenericPrivateTopicTitle(serviceTitle)) {
    return sanitizeTopicTitle(serviceTitle, "New Codex Chat");
  }

  return "New Codex Chat";
}

function shouldAutoCreatePrivateTopicBinding({ config, message, binding }) {
  return !binding && config.privateTopicAutoCreateChats !== false && isPrivateTopicMessage(message);
}

async function maybeRenamePrivateTopic({ config, message, title }) {
  if (!isPrivateTopicMessage(message) || !normalizeText(title)) {
    return;
  }
  try {
    await editForumTopic(config.botToken, {
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      name: title,
    });
  } catch (error) {
    logBridgeEvent("private_topic_rename_error", {
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id ?? null,
      title,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function autoCreatePrivateTopicBinding({ config, state, message, bindingKey, promptText, sendPrompt = null }) {
  if (config.privateTopicAutoCreateChats === false || !isPrivateTopicMessage(message)) {
    return null;
  }

  const title = makePrivateTopicChatTitle({ state, bindingKey, message, promptText });
  const result = await createNativeChat({
    helperPath: config.nativeChatStartHelperPath,
    title,
    cwd: config.nativeChatStartCwd,
    prompt: sendPrompt,
    timeoutMs: config.nativeChatStartTimeoutMs,
    appServerUrl: config.appServerUrl,
  });
  const threadId = normalizeText(result.threadId || result.thread?.id);
  if (!threadId) {
    throw new Error("Codex app-server created a chat without returning a thread id");
  }

  removeOutboundMirror(state, bindingKey);
  const now = new Date().toISOString();
  const binding = setBinding(state, bindingKey, {
    threadId,
    transport: "native",
    chatId: String(message.chat.id),
    messageThreadId: message.message_thread_id ?? null,
    chatTitle: normalizeText(message.chat.title || message.chat.username || message.chat.first_name || "Codex Chats"),
    threadTitle: title,
    createdAt: now,
    updatedAt: now,
    createdBy: PRIVATE_TOPIC_AUTO_CREATE_CREATOR,
    surface: CODEX_CHATS_SURFACE,
    lastTransportPath: result.transportPath || "app-server-thread-start",
    lastNativeMode: result.mode || null,
  });
  await maybeRenamePrivateTopic({ config, message, title });

  logBridgeEvent("private_topic_chat_created", {
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id ?? null,
    messageId: message.message_id ?? null,
    bindingKey,
    threadId,
    title,
    cwd: config.nativeChatStartCwd,
    sentInitialPrompt: Boolean(sendPrompt),
  });

  return binding;
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

async function captureWorktreeBaseline(thread) {
  const cwd = normalizeText(thread?.cwd);
  if (!cwd) {
    return {
      head: null,
      summary: null,
    };
  }
  const head = await readGitHead(cwd);
  const summary = await readWorktreeSummary(cwd, { baseRef: head });
  return {
    head,
    summary,
  };
}

async function loadChangedFilesTextForThread({ config, thread, binding, cache }) {
  if (config.worktreeSummaryEnabled === false) {
    return null;
  }
  const cwd = normalizeText(thread?.cwd);
  if (!cwd) {
    return null;
  }
  let baseRef = normalizeText(binding?.currentTurn?.worktreeBaseHead);
  let baselineSummary = binding?.currentTurn?.worktreeBaseSummary || null;
  if (!baseRef && binding?.currentTurn) {
    const baseline = await captureWorktreeBaseline(thread);
    baseRef = baseline.head;
    baselineSummary = baseline.summary;
    if (baseRef || baselineSummary) {
      binding.currentTurn.worktreeBaseHead = baseRef;
      binding.currentTurn.worktreeBaseSummary = baselineSummary;
    }
  }
  const cacheKey = `${cwd}\0${baseRef || ""}\0${JSON.stringify(baselineSummary?.files || [])}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) || null;
  }
  const summary = subtractWorktreeSummary(await readWorktreeSummary(cwd, { baseRef }), baselineSummary);
  const text = formatWorktreeSummary(summary, {
    maxFiles: config.worktreeSummaryMaxFiles,
  });
  cache.set(cacheKey, text);
  return text || null;
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

function isTypingHeartbeatBindingEligible(config, binding) {
  return (
    config.sendTyping !== false &&
    config.typingHeartbeatEnabled !== false &&
    isOutboundMirrorBindingEligible(binding) &&
    Boolean(binding?.currentTurn)
  );
}

function syncTypingHeartbeats({ config, state, heartbeats, onlyBindingKey = null } = {}) {
  if (!heartbeats) {
    return { started: 0, stopped: 0, running: 0 };
  }

  if (config.sendTyping === false || config.typingHeartbeatEnabled === false) {
    if (onlyBindingKey) {
      const heartbeat = heartbeats.get(onlyBindingKey);
      if (heartbeat) {
        heartbeat.stop();
        heartbeats.delete(onlyBindingKey);
        logBridgeEvent("typing_heartbeat_stop", { bindingKey: onlyBindingKey, reason: "disabled" });
        return { started: 0, stopped: 1, running: heartbeats.size };
      }
      return { started: 0, stopped: 0, running: heartbeats.size };
    }
    const stopped = stopTypingHeartbeats(heartbeats);
    if (stopped) {
      logBridgeEvent("typing_heartbeats_stop_all", { stopped, reason: "disabled" });
    }
    return { started: 0, stopped, running: 0 };
  }

  const eligibleKeys = new Set();
  let started = 0;
  let stopped = 0;
  const bindingEntries = Object.entries(state.bindings ?? {}).filter(([bindingKey]) => {
    return !onlyBindingKey || bindingKey === onlyBindingKey;
  });

  for (const [bindingKey, binding] of bindingEntries) {
    if (!isTypingHeartbeatBindingEligible(config, binding)) {
      continue;
    }
    eligibleKeys.add(bindingKey);
    if (heartbeats.has(bindingKey)) {
      continue;
    }
    const heartbeat = startTypingHeartbeat({
      token: config.botToken,
      target: buildTargetFromBinding(binding),
      sendTyping,
      intervalMs: config.typingHeartbeatIntervalMs,
      onError(error) {
        logBridgeEvent("typing_heartbeat_error", {
          bindingKey,
          threadId: binding.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    if (heartbeat.active) {
      heartbeats.set(bindingKey, heartbeat);
      started += 1;
      logBridgeEvent("typing_heartbeat_start", {
        bindingKey,
        threadId: binding.threadId,
        intervalMs: config.typingHeartbeatIntervalMs,
      });
    }
  }

  for (const [bindingKey, heartbeat] of heartbeats.entries()) {
    if (onlyBindingKey && bindingKey !== onlyBindingKey) {
      continue;
    }
    if (eligibleKeys.has(bindingKey)) {
      continue;
    }
    heartbeat.stop();
    heartbeats.delete(bindingKey);
    stopped += 1;
    logBridgeEvent("typing_heartbeat_stop", { bindingKey, reason: "idle" });
  }

  return { started, stopped, running: heartbeats.size };
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

function isPlanMirrorMessage(message) {
  return message?.role === "plan" && normalizeText(message?.phase) === "update_plan";
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

async function upsertOutboundProgressMessage({
  config,
  binding,
  target,
  replyToMessageId,
  message,
  changedFilesText = null,
}) {
  const baseTurn = {
    source: "codex",
    startedAt: message.timestamp || binding.currentTurn?.startedAt || new Date().toISOString(),
    promptPreview: binding.currentTurn?.promptPreview || "Codex progress",
    ...(binding.currentTurn || {}),
  };
  binding.currentTurn = isPlanMirrorMessage(message)
    ? {
        ...baseTurn,
        planText: normalizeText(message.text),
        planUpdatedAt: message.timestamp || new Date().toISOString(),
      }
    : {
        ...baseTurn,
        progressItems: appendOutboundProgressItem(binding.currentTurn, message),
      };
  if (changedFilesText) {
    binding.currentTurn.changedFilesText = changedFilesText;
  } else {
    delete binding.currentTurn.changedFilesText;
  }
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

async function completeOutboundProgressMessage({ config, binding, target, changedFilesText = null }) {
  const messageId = binding.currentTurn?.codexProgressMessageId;
  if (!Number.isInteger(messageId)) {
    return [];
  }
  if (changedFilesText) {
    binding.currentTurn.changedFilesText = changedFilesText;
  } else if (binding.currentTurn) {
    delete binding.currentTurn.changedFilesText;
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

function makeAppServerLiveStream(config) {
  if (config.appServerStreamEnabled === false || !config.appServerUrl) {
    return null;
  }
  return new AppServerLiveStream({
    url: config.appServerUrl,
    connectTimeoutMs: config.appServerStreamConnectTimeoutMs,
    reconnectMs: config.appServerStreamReconnectMs,
    maxQueuedEvents: config.appServerStreamMaxEvents,
    onStatus(payload) {
      logBridgeEvent("app_server_stream_status", payload);
    },
  });
}

async function subscribeAppServerStream({ config, stream, bindingKey, binding }) {
  if (!stream || config.appServerStreamEnabled === false || !binding?.threadId) {
    return false;
  }
  try {
    await stream.subscribe(binding.threadId);
    return true;
  } catch (error) {
    logBridgeEvent("app_server_stream_subscribe_error", {
      bindingKey,
      threadId: binding.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function syncAppServerStreamSubscriptions({ config, state, stream }) {
  if (!stream || config.appServerStreamEnabled === false) {
    return { subscribed: 0 };
  }
  let subscribed = 0;
  const entries = Object.entries(state.bindings ?? {}).filter(([, binding]) => {
    return isOutboundMirrorBindingEligible(binding) && binding?.currentTurn;
  });
  for (const [bindingKey, binding] of entries) {
    if (await subscribeAppServerStream({ config, stream, bindingKey, binding })) {
      subscribed += 1;
    }
  }
  return { subscribed };
}

function getAppServerPatch(patches, bindingKey) {
  if (!patches.has(bindingKey)) {
    patches.set(bindingKey, {
      eventCount: 0,
      categories: new Set(),
      lines: new Map(),
      planText: null,
      latestTimestamp: null,
      sawDiff: false,
    });
  }
  return patches.get(bindingKey);
}

function appServerLineKey(event) {
  return [event?.category || "other", event?.itemId || event?.method || "event"].join(":");
}

async function syncAppServerStreamProgress({ config, state, stream }) {
  if (!stream || config.appServerStreamEnabled === false) {
    return { changed: false, applied: 0, events: 0 };
  }
  const events = stream.drainEvents();
  if (!events.length) {
    return { changed: false, applied: 0, events: 0 };
  }

  const activeEntries = Object.entries(state.bindings ?? {}).filter(([, binding]) => {
    return isOutboundMirrorBindingEligible(binding) && binding?.currentTurn;
  });
  const bindingByThreadId = new Map(activeEntries.map(([bindingKey, binding]) => [String(binding.threadId), [bindingKey, binding]]));
  const patches = new Map();

  for (const event of events) {
    const threadId = normalizeText(event?.threadId);
    if (!threadId || !bindingByThreadId.has(threadId)) {
      continue;
    }
    const [bindingKey, binding] = bindingByThreadId.get(threadId);
    const currentTurn = binding.currentTurn || {};
    if (event.turnId && currentTurn.appServerTurnId && currentTurn.appServerTurnId !== event.turnId) {
      continue;
    }
    if (event.turnId && !currentTurn.appServerTurnId) {
      currentTurn.appServerTurnId = event.turnId;
    }
    binding.currentTurn = currentTurn;

    const patch = getAppServerPatch(patches, bindingKey);
    patch.eventCount += 1;
    patch.categories.add(event.category);
    patch.latestTimestamp = event.ts || patch.latestTimestamp || new Date().toISOString();
    if (event.planText) {
      patch.planText = event.planText;
    }
    if (event.category === "diff") {
      patch.sawDiff = true;
    }
    const bufferText = appendAppServerStreamBuffer(currentTurn, event);
    const line = formatAppServerStreamProgressLine(event, { bufferText });
    if (line) {
      patch.lines.set(appServerLineKey(event), line);
    }
  }

  if (!patches.size) {
    return { changed: false, applied: 0, events: events.length };
  }

  const threads = await getThreadsByIds(
    config.threadsDbPath,
    [...patches.keys()].map((bindingKey) => state.bindings[bindingKey]?.threadId).filter(Boolean),
  );
  const threadsById = new Map(threads.map((thread) => [String(thread.id), thread]));
  const changedFilesCache = new Map();
  let changed = false;
  let applied = 0;

  for (const [bindingKey, patch] of patches.entries()) {
    const binding = state.bindings[bindingKey];
    if (!binding?.currentTurn) {
      continue;
    }
    const target = {
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId ?? null,
    };
    const thread = threadsById.get(String(binding.threadId));
    const changedFilesText =
      thread && (patch.sawDiff || patch.planText || patch.lines.size)
        ? await loadChangedFilesTextForThread({
            config,
            thread,
            binding,
            cache: changedFilesCache,
          })
        : null;
    const progressText = [...patch.lines.values()].slice(-4).join("\n");
    const message = progressText
      ? {
          role: "assistant",
          phase: "commentary",
          text: progressText,
          timestamp: patch.latestTimestamp || new Date().toISOString(),
        }
      : patch.planText
        ? {
            role: "plan",
            phase: "update_plan",
            text: patch.planText,
            timestamp: patch.latestTimestamp || new Date().toISOString(),
          }
        : null;
    if (!message) {
      continue;
    }
    if (patch.planText && message.role !== "plan") {
      binding.currentTurn.planText = patch.planText;
      binding.currentTurn.planUpdatedAt = patch.latestTimestamp || new Date().toISOString();
    }
    try {
      const sent = await upsertOutboundProgressMessage({
        config,
        binding,
        target,
        replyToMessageId: binding.lastInboundMessageId || binding.lastMirroredUserMessageId || null,
        message,
        changedFilesText,
      });
      rememberOutbound(binding, sent);
      binding.updatedAt = new Date().toISOString();
      binding.lastAppServerStreamAt = patch.latestTimestamp || binding.updatedAt;
      state.bindings[bindingKey] = binding;
      logBridgeEvent("app_server_stream_progress", {
        bindingKey,
        threadId: binding.threadId,
        eventCount: patch.eventCount,
        categories: [...patch.categories].sort(),
      });
      changed = true;
      applied += 1;
    } catch (error) {
      logBridgeEvent("app_server_stream_progress_error", {
        bindingKey,
        threadId: binding.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { changed, applied, events: events.length };
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
  const eventLogPath = config.eventLogPath || config.bridgeLogPath;
  const recentEvents = await readRecentBridgeEvents(eventLogPath).catch((error) => [
    {
      type: "health_event_log_error",
      error: error instanceof Error ? error.message : String(error),
    },
  ]);
  const eventSummary = summarizeBridgeEvents(recentEvents);
  let stateDoctor = null;
  let stateDoctorError = null;
  try {
    stateDoctor = await inspectStateDoctor({ config, state, recentEvents });
  } catch (error) {
    stateDoctorError = error instanceof Error ? error.message : String(error);
  }
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
    `event log: \`${eventLogPath}\` (${eventSummary.total} sampled)`,
    `delivery: app-control ${eventSummary.appControlSends}, app-server fallback ${eventSummary.appServerFallbackSends}, native errors ${eventSummary.nativeSendErrors}, ops dm fallbacks ${eventSummary.opsDmFallbacks}`,
    stateDoctor
      ? `state doctor: ${stateDoctor.summary.findings} findings, ${stateDoctor.summary.repairable} safe repairs`
      : `state doctor: unavailable (${stateDoctorError || "unknown"})`,
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
    if (binding.appControlCooldownUntil && appControlCooldownUntilMs(binding) > Date.now()) {
      lines.push(`app-control cooldown until: \`${binding.appControlCooldownUntil}\``);
    }
    if (binding.lastTransportErrorAt) {
      lines.push(
        `last transport error: \`${binding.lastTransportErrorKind || "send_failed"}\` at \`${binding.lastTransportErrorAt}\``,
      );
    }
  } else {
    lines.push("binding: none");
  }

  if (stateDoctor?.summary?.repairable) {
    lines.push("state repair hint: run `npm run state:doctor -- --apply` locally. It only edits local state/index files.");
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

  const context = await buildSyncContextForProjectGroup(config, state, projectGroup, requestedLimit);

  return {
    projectGroup,
    diagnostics: context.diagnostics,
    plan: context.plan,
  };
}

async function buildSyncContextForProjectGroup(
  config,
  state,
  projectGroup,
  requestedLimit,
  { maxThreadAgeMs = 0, nowMs = Date.now(), threadScanLimit = null } = {},
) {
  const diagnostics = await collectChatBindingDiagnostics(config, state, projectGroup.chatId);
  const threads = await listProjectThreads(config.threadsDbPath, projectGroup.projectRoot, {
    limit: threadScanLimit || requestedLimit,
  });
  const plan = buildProjectSyncPlan({
    entries: diagnostics.entries,
    threads,
    requestedLimit,
    maxThreadAgeMs,
    nowMs,
  });

  return {
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

function countSyncPlanActions(plan) {
  return (
    (plan?.rename?.length || 0) +
    (plan?.reopen?.length || 0) +
    (plan?.create?.length || 0) +
    (plan?.park?.length || 0)
  );
}

function formatSyncApplyResult({ projectGroup, changed, plan }) {
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
      ...changed.parkPending.map((item) => ({
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
  return lines.join("\n");
}

async function applyProjectSyncPlan({
  config,
  state,
  chatId,
  projectGroup,
  plan,
  currentBindingKey = null,
  sendResponse = null,
}) {
  const now = new Date().toISOString();
  const parkCurrentTopic = new Set(
    plan.park
      .filter((item) => currentBindingKey && item.entry.bindingKey === currentBindingKey)
      .map((item) => item.entry.bindingKey),
  );
  const parkBeforeReply = plan.park.filter((item) => !parkCurrentTopic.has(item.entry.bindingKey));
  const parkAfterReply = plan.park.filter((item) => parkCurrentTopic.has(item.entry.bindingKey));
  const changed = {
    renamed: [],
    reopened: [],
    created: [],
    parked: [],
    parkPending: parkAfterReply,
  };

  for (const item of plan.rename) {
    const nextTitle = sanitizeTopicTitle(item.thread.title, item.thread.id);
    await editForumTopic(config.botToken, {
      chatId,
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
      chatId,
      messageThreadId: item.entry.binding.messageThreadId,
    });
    const nextTitle = sanitizeTopicTitle(item.thread.title, item.thread.id);
    if (item.renameNeeded) {
      await editForumTopic(config.botToken, {
        chatId,
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
    const topicTitle = sanitizeTopicTitle(thread.title, thread.id);
    const topic = await createForumTopic(config.botToken, {
      chatId,
      name: topicTitle,
    });
    const topicId = Number(topic?.message_thread_id);
    if (!Number.isInteger(topicId)) {
      throw new Error(`createForumTopic returned invalid message_thread_id for ${thread.id}`);
    }
    const topicBindingKey = makeBindingKey({
      chatId,
      messageThreadId: topicId,
    });
    setBinding(state, topicBindingKey, {
      ...buildBindingPayload({
        message: {
          chat: { id: chatId, title: projectGroup.groupTitle },
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
      title: topicTitle,
      threadId: String(thread.id),
    });
  }

  for (const item of parkBeforeReply) {
    await closeForumTopic(config.botToken, {
      chatId,
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

  if (sendResponse) {
    await sendResponse(formatSyncApplyResult({ projectGroup, changed, plan }));
  }

  for (const item of parkAfterReply) {
    try {
      await closeForumTopic(config.botToken, {
        chatId,
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
        chatId,
        messageThreadId: item.entry.binding.messageThreadId,
        threadId: item.entry.binding.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const actionCount = countSyncPlanActions(plan);
  return {
    changed: actionCount > 0,
    actionCount,
    details: changed,
  };
}

async function syncAutoProjectTopics({ config, state, nowMs = Date.now() } = {}) {
  if (config.topicAutoSyncEnabled !== true) {
    return { changed: false, checked: 0, actionCount: 0 };
  }

  const groups = await loadProjectIndex(config.projectIndexPath);
  const requestedLimit = clamp(parsePositiveInt(config.topicAutoSyncLimit, config.syncDefaultLimit), 1, 10);
  const maxActions = Math.max(1, Number(config.topicAutoSyncMaxActionsPerTick) || 1);
  let checked = 0;
  let actionCount = 0;
  let changed = false;

  for (const projectGroup of groups) {
    if (actionCount >= maxActions) {
      break;
    }
    if (!projectGroup.chatId || !projectGroup.projectRoot) {
      continue;
    }
    checked += 1;
    const { plan } = await buildSyncContextForProjectGroup(config, state, projectGroup, requestedLimit, {
      maxThreadAgeMs: config.topicAutoSyncMaxThreadAgeMs,
      nowMs,
      threadScanLimit: Math.min(50, Math.max(requestedLimit * 4, requestedLimit)),
    });
    const planActions = countSyncPlanActions(plan);
    if (planActions === 0) {
      continue;
    }
    if (actionCount + planActions > maxActions) {
      logBridgeEvent("topic_auto_sync_skipped_project", {
        chatId: projectGroup.chatId,
        projectRoot: projectGroup.projectRoot,
        actionCount: planActions,
        remainingActionBudget: maxActions - actionCount,
      });
      continue;
    }
    const result = await applyProjectSyncPlan({
      config,
      state,
      chatId: projectGroup.chatId,
      projectGroup,
      plan,
    });
    actionCount += result.actionCount;
    changed = changed || result.changed;
    logBridgeEvent("topic_auto_sync_project_applied", {
      chatId: projectGroup.chatId,
      projectRoot: projectGroup.projectRoot,
      desiredCount: plan.summary.desiredCount,
      renameCount: plan.summary.renameCount,
      reopenCount: plan.summary.reopenCount,
      createCount: plan.summary.createCount,
      parkCount: plan.summary.parkCount,
    });
  }

  return { changed, checked, actionCount };
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
      if (isThreadDbOptionalBinding(binding)) {
        logBridgeEvent("binding_thread_db_pending", {
          threadId: binding.threadId,
          chatId: binding.chatId,
          messageThreadId: binding.messageThreadId ?? null,
          createdBy: binding.createdBy || null,
          surface: binding.surface || null,
        });
        return { ok: true, thread: null };
      }
      return {
        ok: false,
        message: `This binding points to thread ${binding.threadId}, which is no longer in the local Codex DB. Use /detach and bind it again.`,
      };
    }
    if (Number(thread.archived) !== 0) {
      return {
        ok: false,
        thread,
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

function fileSizeOrZero(filePath) {
  if (!filePath) {
    return 0;
  }
  try {
    return Number(statSync(filePath).size) || 0;
  } catch {
    return 0;
  }
}

function prepareOutboundMirrorAtFileEnd(state, bindingKey, thread) {
  if (!thread?.rollout_path) {
    removeOutboundMirror(state, bindingKey);
    return;
  }
  setOutboundMirror(state, bindingKey, {
    initialized: true,
    threadId: String(thread.id),
    rolloutPath: thread.rollout_path,
    byteOffset: fileSizeOrZero(thread.rollout_path),
    partialLine: "",
    lastSignature: null,
    suppressions: [],
    pendingMessages: [],
    replyTargetMessageId: null,
  });
}

async function validateBindingForSendWithRescue({ config, state, bindingKey, binding }) {
  const result = await validateBindingForSend(config, binding);
  if (result.ok || !result.thread || Number(result.thread.archived) === 0) {
    return result;
  }

  let candidates = [];
  try {
    candidates = await findActiveThreadSuccessors(config.threadsDbPath, result.thread, { limit: 3 });
  } catch (error) {
    logBridgeEvent("binding_archived_rescue_lookup_error", {
      bindingKey,
      threadId: binding.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (candidates.length !== 1) {
    logBridgeEvent("binding_archived_rescue_ambiguous", {
      bindingKey,
      threadId: binding.threadId,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        cwd: candidate.cwd,
      })),
    });
    return {
      ...result,
      message:
        candidates.length > 1
          ? `This Telegram topic points to archived Codex thread ${binding.threadId}, and I found ${candidates.length} possible active replacements. Use /detach and /attach <thread-id> once.`
          : result.message,
    };
  }

  const successor = candidates[0];
  const now = new Date().toISOString();
  const nextBinding = setBinding(state, bindingKey, {
    ...binding,
    threadId: String(successor.id),
    threadTitle: successor.title || binding.threadTitle,
    reboundFromThreadId: binding.threadId,
    reboundAt: now,
    updatedAt: now,
  });
  prepareOutboundMirrorAtFileEnd(state, bindingKey, successor);
  logBridgeEvent("binding_archived_rescued", {
    bindingKey,
    fromThreadId: binding.threadId,
    toThreadId: successor.id,
    title: successor.title,
    cwd: successor.cwd,
  });
  return {
    ok: true,
    thread: successor,
    binding: nextBinding,
    notice: "Recovered the Telegram binding to the active Codex thread; continuing.",
  };
}

async function handleCommand({ config, state, message, bindingKey, binding, parsed }) {
  switch (parsed.command) {
    case "/help":
    case "/start":
      await sendCommandResponse({
        config,
        message,
        text: renderHelp(config),
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
        });
        return true;
      }

      await applyProjectSyncPlan({
        config,
        state,
        chatId: message.chat.id,
        projectGroup,
        plan,
        currentBindingKey: bindingKey,
        sendResponse: (text) =>
          sendCommandResponse({
            config,
            message,
            text,
          }),
      });
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

async function handlePlainText({
  config,
  state,
  message,
  bindingKey,
  binding,
  appServerStream = null,
  typingHeartbeats = null,
}) {
  const shouldAutoCreatePrivateTopic = shouldAutoCreatePrivateTopicBinding({ config, message, binding });
  if (!binding && !shouldAutoCreatePrivateTopic) {
    const hint = isPrivateTopicMessage(message)
      ? "No Codex Chat is bound here yet. Open an existing Codex Chat topic, or bind this one with /attach <thread-id>."
      : "No Codex thread is bound here. Open a topic or use /attach <thread-id>.";
    await reply(config.botToken, message, hint);
    return;
  }

  if (binding && (binding.transport || "native") !== "native") {
    await reply(config.botToken, message, "This v1 bridge only supports native transport.");
    return;
  }

  const rawText = getMessageIngressText(message);
  const promptText = normalizeInboundPrompt(rawText, {
    botUsername: config.botUsername,
  });
  const attachmentRefs = collectTelegramAttachments(message, {
    maxCount: config.attachmentMaxCount,
  });
  const voiceRefs = collectTelegramVoiceRefs(message, {
    maxCount: config.voiceTranscriptionMaxCount,
  });
  if (!promptText && !attachmentRefs.length && !voiceRefs.length) {
    await reply(config.botToken, message, "The text is empty. If you mention the bot, put the actual request after the mention.");
    return;
  }
  if (attachmentRefs.length && config.attachmentsEnabled === false) {
    await reply(config.botToken, message, "Attachments are disabled in this bridge config. Text still works.");
    return;
  }
  if (voiceRefs.length && config.voiceTranscriptionEnabled === false) {
    await reply(config.botToken, message, "Voice transcription is disabled in this bridge config. Text still works.");
    return;
  }
  if (voiceRefs.length && !chooseVoiceTranscriptionProvider(config)) {
    await reply(
      config.botToken,
      message,
      "Voice transcription is not configured yet. Set a Deepgram/OpenAI key or a local command, then restart the bridge.",
    );
    return;
  }

  const bindingValidation = binding
    ? await validateBindingForSendWithRescue({ config, state, bindingKey, binding })
    : { ok: true, thread: null, binding: null, notice: null };
  if (!bindingValidation.ok) {
    await reply(config.botToken, message, bindingValidation.message);
    return;
  }
  binding = bindingValidation.binding || binding;

  let savedAttachments = [];
  let voiceTranscripts = [];
  let prompt = promptText;
  let replyMessage = message;
  if (voiceRefs.length) {
    try {
      if (config.sendTyping) {
        await sendTyping(config.botToken, buildTargetFromMessage(message)).catch(() => null);
      }
      voiceTranscripts = await transcribeTelegramVoice({
        token: config.botToken,
        message,
        config,
        maxBytes: config.voiceTranscriptionMaxBytes,
        maxCount: config.voiceTranscriptionMaxCount,
        getFile,
        downloadFile: downloadTelegramFile,
      });
      const transcriptSent = await reply(config.botToken, message, formatVoiceTranscriptBubble(voiceTranscripts));
      const transcriptMessageId = transcriptSent[0]?.message_id ?? null;
      if (Number.isInteger(transcriptMessageId)) {
        replyMessage = { ...message, message_id: transcriptMessageId };
      }
      rememberOutbound(binding, transcriptSent);
      prompt = formatVoiceTranscriptPrompt({
        text: prompt,
        transcripts: voiceTranscripts,
      });
      logBridgeEvent("telegram_voice_transcribed", {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        messageId: message.message_id ?? null,
        count: voiceTranscripts.length,
        provider: voiceTranscripts[0]?.provider || null,
        model: voiceTranscripts[0]?.model || null,
        transcriptMessageId,
      });
    } catch (error) {
      logBridgeEvent("telegram_voice_transcription_error", {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        messageId: message.message_id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      await reply(
        config.botToken,
        message,
        "I could not transcribe that voice message. Try again, or send the text version if it is urgent.",
      );
      return;
    }
  }
  if (attachmentRefs.length) {
    try {
      savedAttachments = await saveTelegramAttachments({
        token: config.botToken,
        message,
        storageDir: config.attachmentStorageDir,
        maxBytes: config.attachmentMaxBytes,
        maxCount: config.attachmentMaxCount,
        getFile,
        downloadFile: downloadTelegramFile,
      });
      prompt = formatAttachmentPrompt({
        text: prompt,
        attachments: savedAttachments,
      });
      logBridgeEvent("telegram_attachments_saved", {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        messageId: message.message_id ?? null,
        mediaGroupId: message.media_group_id || null,
        mediaGroupMessageIds: message.mediaGroupMessageIds || null,
        count: savedAttachments.length,
        kinds: savedAttachments.map((item) => item.kind),
      });
    } catch (error) {
      logBridgeEvent("telegram_attachment_error", {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        messageId: message.message_id ?? null,
        mediaGroupId: message.media_group_id || null,
        mediaGroupMessageIds: message.mediaGroupMessageIds || null,
        error: error instanceof Error ? error.message : String(error),
      });
      await reply(
        config.botToken,
        replyMessage,
        "I could not download that attachment. Try a smaller image/file, or send the text part without media.",
      );
      return;
    }
  }

  if (shouldAutoCreatePrivateTopic) {
    const target = buildTargetFromMessage(replyMessage);
    const progressIntro = [
      voiceTranscripts.length ? formatVoiceTranscriptionReceipt(voiceTranscripts) : null,
      savedAttachments.length ? formatAttachmentReceipt(savedAttachments) : null,
    ].filter(Boolean);
    const initialProgressText = progressIntro.length
      ? `${progressIntro.join("\n")}\n${getInitialProgressText()}`
      : getInitialProgressText();
    const receipt = await replyPlain(config.botToken, replyMessage, initialProgressText);
    const receiptMessageId = receipt[0]?.message_id ?? null;
    const progressBubble = startProgressBubble({
      token: config.botToken,
      target,
      messageId: receiptMessageId,
      onError(error) {
        logBridgeEvent("progress_bubble_error", {
          bindingKey,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    try {
      binding = await autoCreatePrivateTopicBinding({
        config,
        state,
        message,
        bindingKey,
        promptText: prompt,
        sendPrompt: prompt,
      });
      if (!binding) {
        throw new Error("private topic chat auto-create returned no binding");
      }
      await progressBubble.stop();
      binding.lastInboundMessageId = replyMessage.message_id ?? message.message_id ?? null;
      binding.currentTurn = {
        source: "telegram",
        startedAt: new Date().toISOString(),
        promptPreview: makePromptPreview(prompt),
        codexProgressMessageId: Number.isInteger(receiptMessageId) ? receiptMessageId : undefined,
        sendOnly: true,
        transportPath: binding.lastTransportPath || "app-server-thread-start",
      };
      binding.updatedAt = new Date().toISOString();
      state.bindings[bindingKey] = binding;
      rememberOutbound(binding, receipt);
      rememberOutboundMirrorSuppression(state, bindingKey, prompt, {
        role: "user",
        phase: null,
      });
      await refreshStatusBars({ config, state, onlyBindingKey: bindingKey });
      await saveState(config.statePath, state);
      await subscribeAppServerStream({ config, stream: appServerStream, bindingKey, binding });
      syncTypingHeartbeats({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
      logBridgeEvent("private_topic_initial_turn_started", {
        threadId: binding.threadId,
        bindingKey,
        receiptMessageId,
        transportPath: binding.lastTransportPath,
      });
      return;
    } catch (error) {
      await progressBubble.stop();
      logBridgeEvent("private_topic_initial_turn_error", {
        bindingKey,
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        attempts: Array.isArray(error?.attempts) ? error.attempts : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      const errorText = renderNativeSendError(error);
      if (receiptMessageId) {
        await editThenSendRichTextChunks(config.botToken, target, receiptMessageId, errorText);
      } else {
        await reply(config.botToken, message, errorText);
      }
      return;
    }
  }

  const worktreeBaseline = await captureWorktreeBaseline(bindingValidation.thread);
  binding.lastInboundMessageId = replyMessage.message_id ?? message.message_id ?? null;
  binding.currentTurn = {
    source: "telegram",
    startedAt: new Date().toISOString(),
    promptPreview: makePromptPreview(prompt),
    worktreeBaseHead: worktreeBaseline.head,
    worktreeBaseSummary: worktreeBaseline.summary,
  };
  binding.updatedAt = new Date().toISOString();
  state.bindings[bindingKey] = binding;
  rememberOutboundMirrorSuppression(state, bindingKey, prompt, {
    role: "user",
    phase: null,
  });
  await refreshStatusBars({ config, state, onlyBindingKey: bindingKey });
  await saveState(config.statePath, state);

  if (config.sendTyping && config.typingHeartbeatEnabled !== false && typingHeartbeats) {
    syncTypingHeartbeats({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
  } else if (config.sendTyping) {
    await sendTyping(config.botToken, buildTargetFromMessage(message)).catch(() => null);
  }
  await subscribeAppServerStream({ config, stream: appServerStream, bindingKey, binding });

  const target = buildTargetFromMessage(replyMessage);
  const progressIntro = [
    bindingValidation.notice || null,
    voiceTranscripts.length ? formatVoiceTranscriptionReceipt(voiceTranscripts) : null,
    savedAttachments.length ? formatAttachmentReceipt(savedAttachments) : null,
  ].filter(Boolean);
  const initialProgressText = progressIntro.length
    ? `${progressIntro.join("\n")}\n${getInitialProgressText()}`
    : getInitialProgressText();
  const receipt = await replyPlain(config.botToken, replyMessage, initialProgressText);
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

  let preferAppServer = false;
  try {
    preferAppServer = shouldPreferAppServer(binding, config);
    if (preferAppServer) {
      logBridgeEvent("native_send_circuit_breaker", {
        threadId: binding.threadId,
        bindingKey,
        mode: config.nativeIngressTransport === "app-server" ? "app-server-first" : "cooldown",
        appControlCooldownUntil: binding.appControlCooldownUntil,
      });
    }
    const result = await sendNativeTurn({
      helperPath: config.nativeHelperPath,
      fallbackHelperPath: config.nativeFallbackHelperPath,
      threadId: binding.threadId,
      prompt,
      timeoutMs: config.nativeTimeoutMs,
      debugBaseUrl: config.nativeDebugBaseUrl,
      appServerUrl: config.appServerUrl,
      pollIntervalMs: config.nativePollIntervalMs,
      waitForReply: config.nativeWaitForReply,
      appControlShowThread: config.appControlShowThread,
      preferAppServer,
      appControlSkipReason: preferAppServer
        ? config.nativeIngressTransport === "app-server"
          ? "configured app-server-first ingress"
          : `app-control cooldown active until ${binding.appControlCooldownUntil}`
        : null,
    });
    binding.updatedAt = new Date().toISOString();
    binding.lastTransportPath = result.transportPath || null;
    if (result.transportPath === "app-control") {
      binding.currentTurn = null;
      delete binding.lastTransportErrorAt;
      delete binding.lastTransportErrorKind;
      delete binding.appControlCooldownUntil;
    } else if (result.primaryError && !preferAppServer) {
      markAppControlCooldown(binding, config, { kind: "app_control_unavailable" });
    }
    logBridgeEvent("native_send_success", {
      threadId: binding.threadId,
      bindingKey,
      transportPath: binding.lastTransportPath,
      primaryError: result.primaryError || null,
      mode: result.mode || null,
    });
    if (config.nativeWaitForReply === false) {
      await progressBubble.stop();
      binding.currentTurn = {
        ...(binding.currentTurn || {
          source: "telegram",
          startedAt: new Date().toISOString(),
          promptPreview: makePromptPreview(prompt),
        }),
        codexProgressMessageId: Number.isInteger(receiptMessageId) ? receiptMessageId : undefined,
        sendOnly: true,
        transportPath: result.transportPath || null,
      };
      state.bindings[bindingKey] = binding;
      syncTypingHeartbeats({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
      logBridgeEvent("native_send_deferred_reply", {
        threadId: binding.threadId,
        bindingKey,
        transportPath: binding.lastTransportPath,
        receiptMessageId,
      });
      return;
    }
    binding.currentTurn = null;
    state.bindings[bindingKey] = binding;
    syncTypingHeartbeats({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
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
    binding.currentTurn = null;
    binding.updatedAt = new Date().toISOString();
    const appControlCooldownUntil = preferAppServer ? null : markAppControlCooldown(binding, config, error);
    if (!appControlCooldownUntil) {
      markTransportError(binding, error);
    }
    state.bindings[bindingKey] = binding;
    syncTypingHeartbeats({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
    logBridgeEvent("native_send_error", {
      threadId: binding.threadId,
      bindingKey,
      kind: binding.lastTransportErrorKind,
      appControlCooldownUntil,
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

async function processMessage({ config, state, message, appServerStream = null, typingHeartbeats = null }) {
  if (!message?.chat?.id) {
    return false;
  }
  if (message?.from?.is_bot) {
    return false;
  }
  if (!isAuthorized(config, message)) {
    return false;
  }
  const rememberedPrivateTopicTitle = rememberPrivateTopicTitle(state, message);
  if (isTelegramServiceMessage(message)) {
    logBridgeEvent("skip_service_message", {
      chatId: message.chat.id,
      messageId: message.message_id ?? null,
      messageThreadId: message.message_thread_id ?? null,
      rememberedPrivateTopicTitle,
      serviceKeys: TELEGRAM_SERVICE_MESSAGE_KEYS.filter((key) => key in message),
    });
    return false;
  }
  const ingressText = getMessageIngressText(message);
  const attachmentRefs = collectTelegramAttachments(message, {
    maxCount: config.attachmentMaxCount,
  });
  const voiceRefs = collectTelegramVoiceRefs(message, {
    maxCount: config.voiceTranscriptionMaxCount,
  });
  if (!ingressText.trim() && !attachmentRefs.length && !voiceRefs.length) {
    await reply(
      config.botToken,
      message,
      hasUnsupportedTelegramMedia(message)
        ? "I can handle text, images, files and voice now. Video/stickers are still next."
        : "I can handle text, images and files now. Send a caption if the attachment needs instructions.",
    );
    return true;
  }

  const bindingKey = makeBindingKey({
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id ?? null,
  });
  const binding = getBinding(state, bindingKey);
  const parsed = ingressText.trim() ? parseCommand(ingressText) : null;
  try {
    if (parsed) {
      return await handleCommand({ config, state, message, bindingKey, binding, parsed });
    }
    let effectiveMessage = message;
    let effectiveBindingKey = bindingKey;
    let effectiveBinding = binding;
    if (!effectiveBinding) {
      const promptText = normalizeInboundPrompt(ingressText, { botUsername: config.botUsername });
      if (!shouldAutoCreatePrivateTopicBinding({ config, message, binding: effectiveBinding })) {
        const rerouted = await rerouteUnboundGroupMessageToFallbackTopic({
          config,
          state,
          message,
          promptText,
          attachmentRefs,
          voiceRefs,
        });
        if (rerouted) {
          effectiveMessage = rerouted.message;
          effectiveBindingKey = rerouted.bindingKey;
          effectiveBinding = rerouted.binding;
        }
      }
    }
    return await handlePlainText({
      config,
      state,
      message: effectiveMessage,
      bindingKey: effectiveBindingKey,
      binding: effectiveBinding,
      appServerStream,
      typingHeartbeats,
    });
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
  const changedFilesCache = new Map();

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
            binding.currentTurn = null;
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
        const isPlan = isPlanMirrorMessage(message);
        const changedFilesText =
          isCommentaryAssistant || isPlan || isFinalAssistant
            ? await loadChangedFilesTextForThread({
                config,
                thread,
                binding,
                cache: changedFilesCache,
              })
            : null;
        let sent = [];
        if (message.role === "user") {
          sent = await sendRichTextChunks(config.botToken, target, formatOutboundUserMirrorText(message.text, config));
        } else if (isCommentaryAssistant || isPlan) {
          sent = await upsertOutboundProgressMessage({
            config,
            binding,
            target,
            replyToMessageId: replyTargetMessageId,
            message,
            changedFilesText,
          });
        } else {
          sent = await sendRichTextChunks(config.botToken, target, formatOutboundAssistantMirrorText(message), replyTargetMessageId);
          if (isFinalAssistant) {
            await completeOutboundProgressMessage({ config, binding, target, changedFilesText });
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
          const worktreeBaseline = await captureWorktreeBaseline(thread);
          binding.currentTurn = {
            source: "codex",
            startedAt: message.timestamp || new Date().toISOString(),
            promptPreview: makePromptPreview(message.text),
            worktreeBaseHead: worktreeBaseline.head,
            worktreeBaseSummary: worktreeBaseline.summary,
          };
        } else if (isFinalAssistant) {
          replyTargetMessageId = null;
          binding.currentTurn = null;
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

async function reserveStatusBarMessage({ config, bindingKey, binding, message }) {
  const sent = await sendMessage(config.botToken, {
    chatId: binding.chatId,
    messageThreadId: binding.messageThreadId,
    text: message.text,
    entities: message.entities,
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

    const message = buildStatusBarMessage({
      binding,
      thread,
      runtime,
      config,
    });
    const hash = makeStatusBarHash(JSON.stringify(message));
    if (binding.statusBarMessageId && binding.statusBarTextHash === hash) {
      continue;
    }

    try {
      if (!binding.statusBarMessageId) {
        await reserveStatusBarMessage({ config, bindingKey, binding, message });
      } else {
        try {
          await editMessageText(config.botToken, {
            chatId: binding.chatId,
            messageId: binding.statusBarMessageId,
            text: message.text,
            entities: message.entities,
          });
        } catch (error) {
          if (!isMissingStatusBarMessageError(error)) {
            throw error;
          }
          delete binding.statusBarMessageId;
          await reserveStatusBarMessage({ config, bindingKey, binding, message });
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
  configureBridgeEventLog(config);
  const state = await loadState(config.statePath);
  const appServerStream = makeAppServerLiveStream(config);
  const typingHeartbeats = new Map();
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
  let lastTopicAutoSyncAt = 0;
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

    for (const item of groupTelegramMediaGroupUpdates(updates)) {
      if (item?.message) {
        let allAlreadyProcessed = true;
        for (const update of item.updates) {
          const checkpoint = await checkpointMessage(config.statePath, state, update);
          if (!checkpoint.alreadyProcessed) {
            allAlreadyProcessed = false;
          }
        }
        if (allAlreadyProcessed) {
          continue;
        }
        await processMessage({ config, state, message: item.message, appServerStream, typingHeartbeats });
        await saveState(config.statePath, state);
      } else {
        const update = item.updates[0];
        state.lastUpdateId = Number.isInteger(update.update_id) ? update.update_id : state.lastUpdateId;
        await saveState(config.statePath, state);
      }
    }

    let topicAutoSyncResult = { changed: false };
    if (
      config.topicAutoSyncEnabled === true &&
      Date.now() - lastTopicAutoSyncAt >= config.topicAutoSyncPollIntervalMs
    ) {
      lastTopicAutoSyncAt = Date.now();
      try {
        topicAutoSyncResult = await syncAutoProjectTopics({ config, state, nowMs: lastTopicAutoSyncAt });
      } catch (error) {
        logBridgeEvent("topic_auto_sync_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let appServerStreamResult = { changed: false };
    try {
      await syncAppServerStreamSubscriptions({ config, state, stream: appServerStream });
      appServerStreamResult = await syncAppServerStreamProgress({ config, state, stream: appServerStream });
    } catch (error) {
      logBridgeEvent("app_server_stream_error", {
        error: error instanceof Error ? error.message : String(error),
      });
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

    try {
      syncTypingHeartbeats({ config, state, heartbeats: typingHeartbeats });
    } catch (error) {
      logBridgeEvent("typing_heartbeat_sync_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (topicAutoSyncResult.changed || appServerStreamResult.changed || syncResult.changed || statusBarResult.changed) {
      await saveState(config.statePath, state);
    }

    if (args.once) {
      stopTypingHeartbeats(typingHeartbeats);
      break;
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
