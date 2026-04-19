import { logBridgeEvent } from "./bridge-events.mjs";
import { normalizeText } from "./message-routing.mjs";
import { isOutboundMirrorBindingEligible } from "./outbound-binding-eligibility.mjs";
import {
  formatOutboundAssistantMirrorText,
  formatOutboundUserMirrorText,
  isCommentaryAssistantMirrorMessage,
  isFinalAssistantMirrorMessage,
  isPlanMirrorMessage,
  makePromptPreview,
} from "./outbound-mirror-messages.mjs";
import {
  completeOutboundProgressMessage,
  upsertOutboundProgressMessage,
} from "./outbound-progress-message.mjs";
import {
  consumeOutboundSuppression,
  getOutboundMirror,
  setOutboundMirror,
} from "./state.mjs";
import { sendRichTextChunks } from "./telegram.mjs";
import { getThreadsByIds } from "./thread-db.mjs";
import { readThreadMirrorDelta } from "./thread-rollout.mjs";

export async function syncOutboundMirrors({
  config,
  state,
  getThreadsByIdsFn = getThreadsByIds,
  getOutboundMirrorFn = getOutboundMirror,
  setOutboundMirrorFn = setOutboundMirror,
  consumeOutboundSuppressionFn = consumeOutboundSuppression,
  readThreadMirrorDeltaFn = readThreadMirrorDelta,
  loadChangedFilesTextForThreadFn = async () => null,
  captureWorktreeBaselineFn = async () => ({ head: null, summary: null }),
  rememberOutboundFn = () => null,
  sendRichTextChunksFn = sendRichTextChunks,
  upsertOutboundProgressMessageFn = upsertOutboundProgressMessage,
  completeOutboundProgressMessageFn = completeOutboundProgressMessage,
  logEventFn = logBridgeEvent,
} = {}) {
  if (config.outboundSyncEnabled === false) {
    return { delivered: 0, suppressed: 0, changed: false };
  }

  const bindingEntries = Object.entries(state.bindings ?? {}).filter(([, binding]) =>
    isOutboundMirrorBindingEligible(binding),
  );
  if (bindingEntries.length === 0) {
    return { delivered: 0, suppressed: 0, changed: false };
  }

  const threads = await getThreadsByIdsFn(
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

    const previousMirror = getOutboundMirrorFn(state, bindingKey);
    let delta;
    try {
      delta = await readThreadMirrorDeltaFn({
        rolloutPath: thread.rollout_path,
        mirrorState: previousMirror,
        threadId: binding.threadId,
        phases: config.outboundMirrorPhases,
      });
    } catch (error) {
      logEventFn("outbound_mirror_scan_error", {
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

      if (consumeOutboundSuppressionFn(state, bindingKey, message.signature)) {
        lastSignature = message.signature;
        if (message.role === "user") {
          replyTargetMessageId = Number.isInteger(binding.lastInboundMessageId) ? binding.lastInboundMessageId : null;
        } else if (message.role === "assistant" && isFinalAssistantMirrorMessage(message)) {
          replyTargetMessageId = null;
          binding.currentTurn = null;
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
            ? await loadChangedFilesTextForThreadFn({
                config,
                thread,
                binding,
                cache: changedFilesCache,
              })
            : null;
        let sent = [];
        if (message.role === "user") {
          sent = await sendRichTextChunksFn(config.botToken, target, formatOutboundUserMirrorText(message.text, config));
        } else if (isCommentaryAssistant || isPlan) {
          sent = await upsertOutboundProgressMessageFn({
            config,
            binding,
            target,
            replyToMessageId: replyTargetMessageId,
            message,
            changedFilesText,
          });
        } else {
          sent = await sendRichTextChunksFn(
            config.botToken,
            target,
            formatOutboundAssistantMirrorText(message),
            replyTargetMessageId,
          );
          if (isFinalAssistant) {
            await completeOutboundProgressMessageFn({ config, binding, target, changedFilesText });
          }
        }
        rememberOutboundFn(binding, sent);
        binding.updatedAt = new Date().toISOString();
        binding.lastMirroredAt = message.timestamp || binding.updatedAt;
        binding.lastMirroredPhase = message.phase || message.role;
        binding.lastMirroredRole = message.role;
        state.bindings[bindingKey] = binding;
        if (message.role === "user") {
          replyTargetMessageId = sent[0]?.message_id ?? replyTargetMessageId;
          binding.lastMirroredUserMessageId = replyTargetMessageId;
          const worktreeBaseline = await captureWorktreeBaselineFn(thread);
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
        logEventFn("outbound_mirror_delivery_error", {
          bindingKey,
          threadId: binding.threadId,
          rolloutPath: thread.rollout_path,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    const liveMirror = getOutboundMirrorFn(state, bindingKey);
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
      setOutboundMirrorFn(state, bindingKey, nextMirror);
      changed = true;
    }
  }

  return { delivered, suppressed, changed };
}
