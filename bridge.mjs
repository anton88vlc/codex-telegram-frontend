#!/usr/bin/env node

import process from "node:process";

import { validateBindingForSendWithRescue } from "./lib/binding-send-validation.mjs";
import { sendNativeTurn } from "./lib/codex-native.mjs";
import { handleCommand } from "./lib/command-handlers.mjs";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./lib/config.mjs";
import {
  makeAppServerLiveStream,
  syncAppServerStreamProgress,
  syncAppServerStreamSubscriptions,
} from "./lib/app-server-stream-runner.mjs";
import {
  configureBridgeEventLog,
  logBridgeEvent,
} from "./lib/bridge-events.mjs";
import { isAuthorized } from "./lib/bridge-bindings.mjs";
import { normalizeInboundPrompt, normalizeText, parseCommand } from "./lib/message-routing.mjs";
import { appendTransportNotice, renderNativeSendError } from "./lib/native-ux.mjs";
import {
  markAppControlCooldown,
  markTransportError,
  shouldPreferAppServer,
} from "./lib/native-transport-state.mjs";
import { makePromptPreview } from "./lib/outbound-mirror-messages.mjs";
import {
  rememberOutbound,
  rememberOutboundMirrorSuppressionForText,
} from "./lib/outbound-memory.mjs";
import { syncOutboundMirrors } from "./lib/outbound-mirror-runner.mjs";
import { getInitialProgressText, startProgressBubble } from "./lib/progress-bubble.mjs";
import { syncAutoProjectTopics } from "./lib/project-sync-runner.mjs";
import {
  autoCreatePrivateTopicBinding,
  rememberPrivateTopicTitle,
  shouldAutoCreatePrivateTopicBinding,
} from "./lib/private-topic-bindings.mjs";
import { buildSelfCheckReport, formatSelfCheckReport } from "./lib/runtime-health.mjs";
import { refreshStatusBars } from "./lib/status-bar-runner.mjs";
import {
  getBinding,
  hasProcessedMessage,
  loadState,
  makeBindingKey,
  makeMessageKey,
  markProcessedMessage,
  saveStateMerged as saveState,
} from "./lib/state.mjs";
import { clamp } from "./lib/thread-db.mjs";
import {
  normalizeTypingHeartbeatIntervalMs,
  stopTypingHeartbeats,
} from "./lib/typing-heartbeat.mjs";
import { syncTypingHeartbeats } from "./lib/typing-heartbeat-runner.mjs";
import {
  buildTargetFromMessage,
  isPrivateTopicMessage,
  isTopicMessage,
  reply,
  replyPlain,
} from "./lib/telegram-targets.mjs";
import { rerouteUnboundGroupMessageToFallbackTopic } from "./lib/unbound-group-rescue.mjs";
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
import { captureWorktreeBaseline, loadChangedFilesTextForThread } from "./lib/worktree-summary.mjs";
import {
  editThenSendRichTextChunks,
  getMe,
  getUpdates,
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

function isTelegramServiceMessage(message) {
  return TELEGRAM_SERVICE_MESSAGE_KEYS.some((key) => key in (message || {}));
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
      rememberOutboundMirrorSuppressionForText(state, bindingKey, prompt, {
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
  rememberOutboundMirrorSuppressionForText(state, bindingKey, prompt, {
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
    rememberOutboundMirrorSuppressionForText(state, bindingKey, replyText, {
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
      return await handleCommand({
        config,
        state,
        message,
        bindingKey,
        binding,
        parsed,
        rememberOutboundFn: rememberOutbound,
      });
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
          rememberOutboundFn: rememberOutbound,
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
      appServerStreamResult = await syncAppServerStreamProgress({
        config,
        state,
        stream: appServerStream,
        loadChangedFilesTextForThreadFn: loadChangedFilesTextForThread,
        rememberOutboundFn: rememberOutbound,
      });
    } catch (error) {
      logBridgeEvent("app_server_stream_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let syncResult = { changed: false };
    try {
      syncResult = await syncOutboundMirrors({
        config,
        state,
        loadChangedFilesTextForThreadFn: loadChangedFilesTextForThread,
        captureWorktreeBaselineFn: captureWorktreeBaseline,
        rememberOutboundFn: rememberOutbound,
      });
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
