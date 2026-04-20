import { subscribeAppServerStream } from "./app-server-stream-runner.mjs";
import { validateBindingForSendWithRescue } from "./binding-send-validation.mjs";
import { logBridgeEvent } from "./bridge-events.mjs";
import { sendNativeTurn } from "./codex-native.mjs";
import { normalizeText } from "./message-routing.mjs";
import { appendTransportNotice, renderNativeSendError } from "./native-ux.mjs";
import {
  markAppControlCooldown,
  markTransportError,
  shouldPreferAppServer,
} from "./native-transport-state.mjs";
import {
  rememberOutbound,
  rememberOutboundMirrorSuppressionForText,
} from "./outbound-memory.mjs";
import { getInitialProgressText, startProgressBubble } from "./progress-bubble.mjs";
import { refreshStatusBars } from "./status-bar-runner.mjs";
import { saveStateMerged as saveState } from "./state.mjs";
import { buildTargetFromBinding } from "./telegram-targets.mjs";
import {
  editThenSendRichTextChunks,
  sendRichTextChunks,
  sendTyping,
} from "./telegram.mjs";
import { syncTypingHeartbeats } from "./typing-heartbeat-runner.mjs";
import {
  dequeueNextTurn,
  restoreQueuedTurnFront,
} from "./turn-queue.mjs";
import { captureWorktreeBaseline } from "./worktree-summary.mjs";

async function upsertQueueProgressMessage({
  config,
  target,
  queueItem,
  text,
  editThenSendRichTextChunksFn,
  sendRichTextChunksFn,
}) {
  if (Number.isInteger(queueItem?.queueMessageId)) {
    const edited = await editThenSendRichTextChunksFn(config.botToken, target, queueItem.queueMessageId, text);
    return edited.length ? edited : [{ message_id: queueItem.queueMessageId }];
  }
  return sendRichTextChunksFn(config.botToken, target, text, queueItem?.replyToMessageId ?? null);
}

export async function startQueuedTurn({
  config,
  state,
  bindingKey,
  binding,
  queueItem,
  appServerStream = null,
  typingHeartbeats = null,
  appendTransportNoticeFn = appendTransportNotice,
  buildTargetFromBindingFn = buildTargetFromBinding,
  captureWorktreeBaselineFn = captureWorktreeBaseline,
  editThenSendRichTextChunksFn = editThenSendRichTextChunks,
  getInitialProgressTextFn = getInitialProgressText,
  logEventFn = logBridgeEvent,
  markAppControlCooldownFn = markAppControlCooldown,
  markTransportErrorFn = markTransportError,
  refreshStatusBarsFn = refreshStatusBars,
  rememberOutboundFn = rememberOutbound,
  rememberOutboundMirrorSuppressionFn = rememberOutboundMirrorSuppressionForText,
  renderNativeSendErrorFn = renderNativeSendError,
  saveStateFn = saveState,
  sendNativeTurnFn = sendNativeTurn,
  sendRichTextChunksFn = sendRichTextChunks,
  sendTypingFn = sendTyping,
  shouldPreferAppServerFn = shouldPreferAppServer,
  startProgressBubbleFn = startProgressBubble,
  subscribeAppServerStreamFn = subscribeAppServerStream,
  syncTypingHeartbeatsFn = syncTypingHeartbeats,
  validateBindingForSendWithRescueFn = validateBindingForSendWithRescue,
}) {
  const bindingValidation = await validateBindingForSendWithRescueFn({ config, state, bindingKey, binding });
  if (!bindingValidation.ok) {
    restoreQueuedTurnFront(binding, queueItem);
    binding.queuePaused = true;
    binding.queueLastError = bindingValidation.message;
    binding.queueLastErrorAt = new Date().toISOString();
    state.bindings[bindingKey] = binding;
    await saveStateFn(config.statePath, state);
    logEventFn("turn_queue_paused", {
      bindingKey,
      threadId: binding.threadId,
      reason: bindingValidation.message,
    });
    return { started: false, paused: true };
  }

  binding = bindingValidation.binding || binding;
  const thread = bindingValidation.thread;
  const worktreeBaseline = await captureWorktreeBaselineFn(thread);
  const now = new Date().toISOString();
  binding.lastInboundMessageId = queueItem.replyToMessageId ?? queueItem.sourceMessageId ?? null;
  binding.currentTurn = {
    source: "telegram",
    startedAt: now,
    promptPreview: queueItem.promptPreview || queueItem.prompt.slice(0, 120),
    worktreeBaseHead: worktreeBaseline.head,
    worktreeBaseSummary: worktreeBaseline.summary,
    queuedTurnId: queueItem.id,
  };
  binding.updatedAt = now;
  delete binding.queueLastError;
  delete binding.queueLastErrorAt;
  state.bindings[bindingKey] = binding;
  rememberOutboundMirrorSuppressionFn(state, bindingKey, queueItem.prompt, {
    role: "user",
    phase: null,
  });
  await refreshStatusBarsFn({ config, state, onlyBindingKey: bindingKey });
  await saveStateFn(config.statePath, state);

  if (config.sendTyping && config.typingHeartbeatEnabled !== false && typingHeartbeats) {
    syncTypingHeartbeatsFn({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
  } else if (config.sendTyping) {
    await sendTypingFn(config.botToken, buildTargetFromBindingFn(binding)).catch(() => null);
  }
  await subscribeAppServerStreamFn({ config, stream: appServerStream, bindingKey, binding });

  const target = buildTargetFromBindingFn(binding);
  const sent = await upsertQueueProgressMessage({
    config,
    target,
    queueItem,
    text: getInitialProgressTextFn(),
    editThenSendRichTextChunksFn,
    sendRichTextChunksFn,
  });
  const receiptMessageId = sent[0]?.message_id ?? queueItem.queueMessageId ?? null;
  rememberOutboundFn(binding, sent);
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
    const result = await sendNativeTurnFn({
      helperPath: config.nativeHelperPath,
      fallbackHelperPath: config.nativeFallbackHelperPath,
      threadId: binding.threadId,
      prompt: queueItem.prompt,
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
      delete binding.lastTransportErrorAt;
      delete binding.lastTransportErrorKind;
      delete binding.appControlCooldownUntil;
    } else if (result.primaryError && !preferAppServer) {
      markAppControlCooldownFn(binding, config, { kind: "app_control_unavailable" });
    }
    logEventFn("queued_turn_started", {
      threadId: binding.threadId,
      bindingKey,
      queueItemId: queueItem.id,
      transportPath: binding.lastTransportPath,
      remainingQueue: Array.isArray(binding.turnQueue) ? binding.turnQueue.length : 0,
    });
    if (config.nativeWaitForReply === false) {
      await progressBubble.stop();
      binding.currentTurn = {
        ...(binding.currentTurn || {
          source: "telegram",
          startedAt: new Date().toISOString(),
          promptPreview: queueItem.promptPreview || queueItem.prompt.slice(0, 120),
        }),
        codexProgressMessageId: Number.isInteger(receiptMessageId) ? receiptMessageId : undefined,
        sendOnly: true,
        transportPath: result.transportPath || null,
      };
      state.bindings[bindingKey] = binding;
      syncTypingHeartbeatsFn({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
      await saveStateFn(config.statePath, state);
      return { started: true };
    }

    binding.currentTurn = null;
    state.bindings[bindingKey] = binding;
    syncTypingHeartbeatsFn({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
    await progressBubble.stop();
    const replyText = normalizeText(result?.reply?.text) || "(empty reply)";
    const deliveredReplyText = appendTransportNoticeFn(replyText, result);
    const replySent = Number.isInteger(receiptMessageId)
      ? await editThenSendRichTextChunksFn(config.botToken, target, receiptMessageId, deliveredReplyText)
      : await sendRichTextChunksFn(config.botToken, target, deliveredReplyText, queueItem.replyToMessageId ?? null);
    rememberOutboundFn(binding, replySent);
    rememberOutboundMirrorSuppressionFn(state, bindingKey, replyText, {
      role: "assistant",
      phase: "final_answer",
    });
    await saveStateFn(config.statePath, state);
    return { started: true, completed: true };
  } catch (error) {
    await progressBubble.stop();
    binding.currentTurn = null;
    binding.updatedAt = new Date().toISOString();
    restoreQueuedTurnFront(binding, queueItem);
    binding.queuePaused = true;
    binding.queueLastError = error instanceof Error ? error.message : String(error);
    binding.queueLastErrorAt = new Date().toISOString();
    const appControlCooldownUntil = preferAppServer ? null : markAppControlCooldownFn(binding, config, error);
    if (!appControlCooldownUntil) {
      markTransportErrorFn(binding, error);
    }
    state.bindings[bindingKey] = binding;
    syncTypingHeartbeatsFn({ config, state, heartbeats: typingHeartbeats, onlyBindingKey: bindingKey });
    const errorText = `${renderNativeSendErrorFn(error)}\n\nQueue paused. Fix Codex, then run /resume.`;
    await upsertQueueProgressMessage({
      config,
      target,
      queueItem,
      text: errorText,
      editThenSendRichTextChunksFn,
      sendRichTextChunksFn,
    });
    await saveStateFn(config.statePath, state);
    logEventFn("queued_turn_error", {
      threadId: binding.threadId,
      bindingKey,
      queueItemId: queueItem.id,
      kind: binding.lastTransportErrorKind,
      error: error instanceof Error ? error.message : String(error),
    });
    return { started: false, paused: true };
  }
}

export async function drainTurnQueues({
  config,
  state,
  appServerStream = null,
  typingHeartbeats = null,
  startQueuedTurnFn = startQueuedTurn,
  logEventFn = logBridgeEvent,
  ...deps
} = {}) {
  if (config.turnQueueEnabled === false) {
    return { started: 0, changed: false };
  }
  let started = 0;
  let changed = false;
  for (const [bindingKey, binding] of Object.entries(state.bindings || {})) {
    if (!binding || binding.currentTurn || binding.queuePaused || !Array.isArray(binding.turnQueue) || !binding.turnQueue.length) {
      continue;
    }
    const queueItem = dequeueNextTurn(binding);
    if (!queueItem) {
      continue;
    }
    state.bindings[bindingKey] = binding;
    try {
      const result = await startQueuedTurnFn({
        config,
        state,
        bindingKey,
        binding,
        queueItem,
        appServerStream,
        typingHeartbeats,
        logEventFn,
        ...deps,
      });
      if (result?.started) {
        started += 1;
      }
      changed = true;
    } catch (error) {
      restoreQueuedTurnFront(binding, queueItem);
      binding.queuePaused = true;
      binding.queueLastError = error instanceof Error ? error.message : String(error);
      binding.queueLastErrorAt = new Date().toISOString();
      state.bindings[bindingKey] = binding;
      changed = true;
      logEventFn("turn_queue_drain_error", {
        bindingKey,
        threadId: binding.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { started, changed };
}
