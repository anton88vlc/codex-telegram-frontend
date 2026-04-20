import { subscribeAppServerStream } from "./app-server-stream-runner.mjs";
import { validateBindingForSendWithRescue } from "./binding-send-validation.mjs";
import { logBridgeEvent } from "./bridge-events.mjs";
import { sendNativeTurn } from "./codex-native.mjs";
import { normalizeInboundPrompt, normalizeText } from "./message-routing.mjs";
import { appendTransportNotice, renderNativeSendError } from "./native-ux.mjs";
import {
  markAppControlCooldown,
  markTransportError,
  shouldPreferAppServer,
} from "./native-transport-state.mjs";
import { makePromptPreview } from "./outbound-mirror-messages.mjs";
import {
  rememberOutbound,
  rememberOutboundMirrorSuppressionForText,
} from "./outbound-memory.mjs";
import { getInitialProgressText, startProgressBubble } from "./progress-bubble.mjs";
import {
  autoCreatePrivateTopicBinding,
  shouldAutoCreatePrivateTopicBinding,
} from "./private-topic-bindings.mjs";
import { refreshStatusBars } from "./status-bar-runner.mjs";
import { saveStateMerged as saveState } from "./state.mjs";
import {
  collectTelegramAttachments,
  formatAttachmentPrompt,
  formatAttachmentReceipt,
  getMessageIngressText,
  saveTelegramAttachments,
} from "./telegram-attachments.mjs";
import {
  buildTargetFromMessage,
  isPrivateTopicMessage,
  reply,
  replyPlain,
} from "./telegram-targets.mjs";
import {
  downloadTelegramFile,
  editThenSendRichTextChunks,
  getFile,
  sendTyping,
} from "./telegram.mjs";
import { syncTypingHeartbeats } from "./typing-heartbeat-runner.mjs";
import {
  chooseVoiceTranscriptionProvider,
  collectTelegramVoiceRefs,
  formatVoiceTranscriptBubble,
  formatVoiceTranscriptPrompt,
  formatVoiceTranscriptionReceipt,
  transcribeTelegramVoice,
} from "./voice-transcription.mjs";
import {
  enqueueTurn,
  formatQueueFull,
  formatQueuedTurnReceipt,
  makeTurnQueueItem,
  setQueuedTurnReceipt,
} from "./turn-queue.mjs";
import { captureWorktreeBaseline } from "./worktree-summary.mjs";

export async function handlePlainText({
  config,
  state,
  message,
  bindingKey,
  binding,
  appServerStream = null,
  typingHeartbeats = null,
  appendTransportNoticeFn = appendTransportNotice,
  autoCreatePrivateTopicBindingFn = autoCreatePrivateTopicBinding,
  buildTargetFromMessageFn = buildTargetFromMessage,
  captureWorktreeBaselineFn = captureWorktreeBaseline,
  chooseVoiceTranscriptionProviderFn = chooseVoiceTranscriptionProvider,
  collectTelegramAttachmentsFn = collectTelegramAttachments,
  collectTelegramVoiceRefsFn = collectTelegramVoiceRefs,
  downloadTelegramFileFn = downloadTelegramFile,
  editThenSendRichTextChunksFn = editThenSendRichTextChunks,
  formatAttachmentPromptFn = formatAttachmentPrompt,
  formatAttachmentReceiptFn = formatAttachmentReceipt,
  formatVoiceTranscriptBubbleFn = formatVoiceTranscriptBubble,
  formatVoiceTranscriptPromptFn = formatVoiceTranscriptPrompt,
  formatVoiceTranscriptionReceiptFn = formatVoiceTranscriptionReceipt,
  getFileFn = getFile,
  getInitialProgressTextFn = getInitialProgressText,
  getMessageIngressTextFn = getMessageIngressText,
  isPrivateTopicMessageFn = isPrivateTopicMessage,
  logEventFn = logBridgeEvent,
  makePromptPreviewFn = makePromptPreview,
  markAppControlCooldownFn = markAppControlCooldown,
  markTransportErrorFn = markTransportError,
  normalizeInboundPromptFn = normalizeInboundPrompt,
  normalizeTextFn = normalizeText,
  refreshStatusBarsFn = refreshStatusBars,
  rememberOutboundFn = rememberOutbound,
  rememberOutboundMirrorSuppressionFn = rememberOutboundMirrorSuppressionForText,
  renderNativeSendErrorFn = renderNativeSendError,
  replyFn = reply,
  replyPlainFn = replyPlain,
  saveStateFn = saveState,
  saveTelegramAttachmentsFn = saveTelegramAttachments,
  sendNativeTurnFn = sendNativeTurn,
  sendTypingFn = sendTyping,
  shouldAutoCreatePrivateTopicBindingFn = shouldAutoCreatePrivateTopicBinding,
  shouldPreferAppServerFn = shouldPreferAppServer,
  startProgressBubbleFn = startProgressBubble,
  subscribeAppServerStreamFn = subscribeAppServerStream,
  syncTypingHeartbeatsFn = syncTypingHeartbeats,
  transcribeTelegramVoiceFn = transcribeTelegramVoice,
  validateBindingForSendWithRescueFn = validateBindingForSendWithRescue,
}) {
  const shouldAutoCreatePrivateTopic = shouldAutoCreatePrivateTopicBindingFn({ config, message, binding });
  if (!binding && !shouldAutoCreatePrivateTopic) {
    const hint = isPrivateTopicMessageFn(message)
      ? "No Codex Chat is bound here yet. Open an existing Codex Chat topic, or bind this one with /attach <thread-id>."
      : "No Codex thread is bound here. Open a topic or use /attach <thread-id>.";
    await replyFn(config.botToken, message, hint);
    return;
  }

  if (binding && (binding.transport || "native") !== "native") {
    await replyFn(config.botToken, message, "This v1 bridge only supports native transport.");
    return;
  }

  const rawText = getMessageIngressTextFn(message);
  const promptText = normalizeInboundPromptFn(rawText, {
    botUsername: config.botUsername,
  });
  const attachmentRefs = collectTelegramAttachmentsFn(message, {
    maxCount: config.attachmentMaxCount,
  });
  const voiceRefs = collectTelegramVoiceRefsFn(message, {
    maxCount: config.voiceTranscriptionMaxCount,
  });
  if (!promptText && !attachmentRefs.length && !voiceRefs.length) {
    await replyFn(config.botToken, message, "The text is empty. If you mention the bot, put the actual request after the mention.");
    return;
  }
  if (attachmentRefs.length && config.attachmentsEnabled === false) {
    await replyFn(config.botToken, message, "Attachments are disabled in this bridge config. Text still works.");
    return;
  }
  if (voiceRefs.length && config.voiceTranscriptionEnabled === false) {
    await replyFn(config.botToken, message, "Voice transcription is disabled in this bridge config. Text still works.");
    return;
  }
  if (voiceRefs.length && !chooseVoiceTranscriptionProviderFn(config)) {
    await replyFn(
      config.botToken,
      message,
      "Voice transcription is not configured yet. Set a Deepgram/OpenAI key or a local command, then restart the bridge.",
    );
    return;
  }

  const bindingValidation = binding
    ? await validateBindingForSendWithRescueFn({ config, state, bindingKey, binding })
    : { ok: true, thread: null, binding: null, notice: null };
  if (!bindingValidation.ok) {
    await replyFn(config.botToken, message, bindingValidation.message);
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
        await sendTypingFn(config.botToken, buildTargetFromMessageFn(message)).catch(() => null);
      }
      voiceTranscripts = await transcribeTelegramVoiceFn({
        token: config.botToken,
        message,
        config,
        maxBytes: config.voiceTranscriptionMaxBytes,
        maxCount: config.voiceTranscriptionMaxCount,
        getFile: getFileFn,
        downloadFile: downloadTelegramFileFn,
      });
      const transcriptSent = await replyFn(config.botToken, message, formatVoiceTranscriptBubbleFn(voiceTranscripts));
      const transcriptMessageId = transcriptSent[0]?.message_id ?? null;
      if (Number.isInteger(transcriptMessageId)) {
        replyMessage = { ...message, message_id: transcriptMessageId };
      }
      rememberOutboundFn(binding, transcriptSent);
      prompt = formatVoiceTranscriptPromptFn({
        text: prompt,
        transcripts: voiceTranscripts,
      });
      logEventFn("telegram_voice_transcribed", {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        messageId: message.message_id ?? null,
        count: voiceTranscripts.length,
        provider: voiceTranscripts[0]?.provider || null,
        model: voiceTranscripts[0]?.model || null,
        transcriptMessageId,
      });
    } catch (error) {
      logEventFn("telegram_voice_transcription_error", {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        messageId: message.message_id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      await replyFn(
        config.botToken,
        message,
        "I could not transcribe that voice message. Try again, or send the text version if it is urgent.",
      );
      return;
    }
  }
  if (attachmentRefs.length) {
    try {
      savedAttachments = await saveTelegramAttachmentsFn({
        token: config.botToken,
        message,
        storageDir: config.attachmentStorageDir,
        maxBytes: config.attachmentMaxBytes,
        maxCount: config.attachmentMaxCount,
        getFile: getFileFn,
        downloadFile: downloadTelegramFileFn,
      });
      prompt = formatAttachmentPromptFn({
        text: prompt,
        attachments: savedAttachments,
      });
      logEventFn("telegram_attachments_saved", {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        messageId: message.message_id ?? null,
        mediaGroupId: message.media_group_id || null,
        mediaGroupMessageIds: message.mediaGroupMessageIds || null,
        count: savedAttachments.length,
        kinds: savedAttachments.map((item) => item.kind),
      });
    } catch (error) {
      logEventFn("telegram_attachment_error", {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        messageId: message.message_id ?? null,
        mediaGroupId: message.media_group_id || null,
        mediaGroupMessageIds: message.mediaGroupMessageIds || null,
        error: error instanceof Error ? error.message : String(error),
      });
      await replyFn(
        config.botToken,
        replyMessage,
        "I could not download that attachment. Try a smaller image/file, or send the text part without media.",
      );
      return;
    }
  }

  if (shouldAutoCreatePrivateTopic) {
    const target = buildTargetFromMessageFn(replyMessage);
    const progressIntro = [
      voiceTranscripts.length ? formatVoiceTranscriptionReceiptFn(voiceTranscripts) : null,
      savedAttachments.length ? formatAttachmentReceiptFn(savedAttachments) : null,
    ].filter(Boolean);
    const initialProgressText = progressIntro.length
      ? `${progressIntro.join("\n")}\n${getInitialProgressTextFn()}`
      : getInitialProgressTextFn();
    const receipt = await replyPlainFn(config.botToken, replyMessage, initialProgressText);
    const receiptMessageId = receipt[0]?.message_id ?? null;
    const progressBubble = startProgressBubbleFn({
      token: config.botToken,
      target,
      messageId: receiptMessageId,
      onError(error) {
        logEventFn("progress_bubble_error", {
          bindingKey,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    try {
      binding = await autoCreatePrivateTopicBindingFn({
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
        promptPreview: makePromptPreviewFn(prompt),
        codexProgressMessageId: Number.isInteger(receiptMessageId) ? receiptMessageId : undefined,
        sendOnly: true,
        transportPath: binding.lastTransportPath || "app-server-thread-start",
      };
      binding.updatedAt = new Date().toISOString();
      state.bindings[bindingKey] = binding;
      rememberOutboundFn(binding, receipt);
      rememberOutboundMirrorSuppressionFn(state, bindingKey, prompt, {
        role: "user",
        phase: null,
      });
      await refreshStatusBarsFn({ config, state, onlyBindingKey: bindingKey });
      await saveStateFn(config.statePath, state);
      await subscribeAppServerStreamFn({ config, stream: appServerStream, bindingKey, binding });
      syncTypingHeartbeatsFn({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
      logEventFn("private_topic_initial_turn_started", {
        threadId: binding.threadId,
        bindingKey,
        receiptMessageId,
        transportPath: binding.lastTransportPath,
      });
      return;
    } catch (error) {
      await progressBubble.stop();
      logEventFn("private_topic_initial_turn_error", {
        bindingKey,
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
        attempts: Array.isArray(error?.attempts) ? error.attempts : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      const errorText = renderNativeSendErrorFn(error);
      if (receiptMessageId) {
        await editThenSendRichTextChunksFn(config.botToken, target, receiptMessageId, errorText);
      } else {
        await replyFn(config.botToken, message, errorText);
      }
      return;
    }
  }

  if (binding?.currentTurn && config.turnQueueEnabled !== false) {
    const queueItem = makeTurnQueueItem({
      prompt,
      message,
      replyMessage,
      promptPreview: makePromptPreviewFn(prompt),
    });
    const queued = enqueueTurn(binding, queueItem, { maxItems: config.turnQueueMaxItems });
    binding.updatedAt = new Date().toISOString();
    state.bindings[bindingKey] = binding;
    if (!queued.ok) {
      await replyFn(
        config.botToken,
        replyMessage,
        queued.reason === "full"
          ? formatQueueFull({ maxItems: queued.maxItems })
          : "I could not queue that prompt. Send it again once Codex finishes the current turn.",
      );
      await saveStateFn(config.statePath, state);
      return;
    }
    const sent = await replyPlainFn(
      config.botToken,
      replyMessage,
      formatQueuedTurnReceipt({ position: queued.position }),
    );
    const queueMessageId = sent[0]?.message_id ?? null;
    if (Number.isInteger(queueMessageId)) {
      setQueuedTurnReceipt(binding, queued.item.id, queueMessageId);
    }
    rememberOutboundFn(binding, sent);
    await refreshStatusBarsFn({ config, state, onlyBindingKey: bindingKey });
    await saveStateFn(config.statePath, state);
    logEventFn("turn_queued", {
      bindingKey,
      threadId: binding.threadId,
      position: queued.position,
      queueLength: queued.length,
      messageId: message.message_id ?? null,
      queueMessageId,
    });
    return;
  }

  const worktreeBaseline = await captureWorktreeBaselineFn(bindingValidation.thread);
  binding.lastInboundMessageId = replyMessage.message_id ?? message.message_id ?? null;
  binding.currentTurn = {
    source: "telegram",
    startedAt: new Date().toISOString(),
    promptPreview: makePromptPreviewFn(prompt),
    worktreeBaseHead: worktreeBaseline.head,
    worktreeBaseSummary: worktreeBaseline.summary,
  };
  binding.updatedAt = new Date().toISOString();
  state.bindings[bindingKey] = binding;
  rememberOutboundMirrorSuppressionFn(state, bindingKey, prompt, {
    role: "user",
    phase: null,
  });
  await refreshStatusBarsFn({ config, state, onlyBindingKey: bindingKey });
  await saveStateFn(config.statePath, state);

  if (config.sendTyping && config.typingHeartbeatEnabled !== false && typingHeartbeats) {
    syncTypingHeartbeatsFn({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
  } else if (config.sendTyping) {
    await sendTypingFn(config.botToken, buildTargetFromMessageFn(message)).catch(() => null);
  }
  await subscribeAppServerStreamFn({ config, stream: appServerStream, bindingKey, binding });

  const target = buildTargetFromMessageFn(replyMessage);
  const progressIntro = [
    bindingValidation.notice || null,
    voiceTranscripts.length ? formatVoiceTranscriptionReceiptFn(voiceTranscripts) : null,
    savedAttachments.length ? formatAttachmentReceiptFn(savedAttachments) : null,
  ].filter(Boolean);
  const initialProgressText = progressIntro.length
    ? `${progressIntro.join("\n")}\n${getInitialProgressTextFn()}`
    : getInitialProgressTextFn();
  const receipt = await replyPlainFn(config.botToken, replyMessage, initialProgressText);
  const receiptMessageId = receipt[0]?.message_id ?? null;
  rememberOutboundFn(binding, receipt);
  const progressBubble = startProgressBubbleFn({
    token: config.botToken,
    target,
    messageId: receiptMessageId,
    onError(error) {
      logEventFn("progress_bubble_error", {
        threadId: binding.threadId,
        bindingKey,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  let preferAppServer = false;
  try {
    preferAppServer = shouldPreferAppServerFn(binding, config);
    if (preferAppServer) {
      logEventFn("native_send_circuit_breaker", {
        threadId: binding.threadId,
        bindingKey,
        mode: config.nativeIngressTransport === "app-server" ? "app-server-first" : "cooldown",
        appControlCooldownUntil: binding.appControlCooldownUntil,
      });
    }
    const result = await sendNativeTurnFn({
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
      markAppControlCooldownFn(binding, config, { kind: "app_control_unavailable" });
    }
    logEventFn("native_send_success", {
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
          promptPreview: makePromptPreviewFn(prompt),
        }),
        codexProgressMessageId: Number.isInteger(receiptMessageId) ? receiptMessageId : undefined,
        sendOnly: true,
        transportPath: result.transportPath || null,
      };
      state.bindings[bindingKey] = binding;
      syncTypingHeartbeatsFn({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
      logEventFn("native_send_deferred_reply", {
        threadId: binding.threadId,
        bindingKey,
        transportPath: binding.lastTransportPath,
        receiptMessageId,
      });
      return;
    }
    binding.currentTurn = null;
    state.bindings[bindingKey] = binding;
    syncTypingHeartbeatsFn({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
    await progressBubble.stop();
    const replyText = normalizeTextFn(result?.reply?.text) || "(empty reply)";
    const deliveredReplyText = appendTransportNoticeFn(replyText, result);
    const sent = receiptMessageId
      ? await editThenSendRichTextChunksFn(config.botToken, target, receiptMessageId, deliveredReplyText)
      : await replyFn(config.botToken, message, deliveredReplyText);
    rememberOutboundFn(binding, sent);
    rememberOutboundMirrorSuppressionFn(state, bindingKey, replyText, {
      role: "assistant",
      phase: "final_answer",
    });
  } catch (error) {
    await progressBubble.stop();
    binding.currentTurn = null;
    binding.updatedAt = new Date().toISOString();
    const appControlCooldownUntil = preferAppServer ? null : markAppControlCooldownFn(binding, config, error);
    if (!appControlCooldownUntil) {
      markTransportErrorFn(binding, error);
    }
    state.bindings[bindingKey] = binding;
    syncTypingHeartbeatsFn({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
    logEventFn("native_send_error", {
      threadId: binding.threadId,
      bindingKey,
      kind: binding.lastTransportErrorKind,
      appControlCooldownUntil,
      attempts: Array.isArray(error?.attempts) ? error.attempts : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    const errorText = renderNativeSendErrorFn(error);
    const sent = receiptMessageId
      ? await editThenSendRichTextChunksFn(config.botToken, target, receiptMessageId, errorText)
      : await replyFn(config.botToken, message, errorText);
    rememberOutboundFn(binding, sent);
  }
}
