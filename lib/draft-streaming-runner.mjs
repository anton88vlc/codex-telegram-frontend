import { CODEX_CHATS_SURFACE } from "./binding-classification.mjs";
import { logBridgeEvent } from "./bridge-events.mjs";
import { normalizeText } from "./message-routing.mjs";
import { isOutboundMirrorBindingEligible } from "./outbound-binding-eligibility.mjs";
import { sendMessageDraft } from "./telegram.mjs";

export const DEFAULT_DRAFT_STREAMING_MAX_CHARS = 1200;
export const DEFAULT_DRAFT_STREAMING_ERROR_COOLDOWN_MS = 10 * 60 * 1000;

function compactDraftText(text, { limit = DEFAULT_DRAFT_STREAMING_MAX_CHARS } = {}) {
  const normalized = normalizeText(text).replace(/\r\n/g, "\n");
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(4096, Number(limit))) : DEFAULT_DRAFT_STREAMING_MAX_CHARS;
  if (normalized.length <= safeLimit) {
    return normalized;
  }
  return `${normalized.slice(0, safeLimit - 1).trimEnd()}…`;
}

function normalizeDraftStreamState(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isPositivePrivateChatId(chatId) {
  const text = normalizeText(chatId);
  return Boolean(text && !text.startsWith("-") && /^[1-9]\d*$/.test(text));
}

export function isDraftStreamingBindingEligible(config, binding) {
  return (
    config?.draftStreamingEnabled !== false &&
    isOutboundMirrorBindingEligible(binding) &&
    normalizeText(binding?.surface) === CODEX_CHATS_SURFACE &&
    isPositivePrivateChatId(binding?.chatId) &&
    binding?.messageThreadId != null &&
    Boolean(binding?.currentTurn)
  );
}

export function makeDraftId(bindingKey, currentTurn = {}) {
  const input = `${bindingKey}|${currentTurn?.startedAt || ""}|${currentTurn?.promptPreview || ""}`;
  let hash = 0x811c9dc5;
  for (let idx = 0; idx < input.length; idx += 1) {
    hash ^= input.charCodeAt(idx);
    hash = Math.imul(hash, 0x01000193);
  }
  const draftId = (hash >>> 0) & 0x7fffffff;
  return draftId || 1;
}

export function formatDraftStreamingText(binding, config = {}) {
  const currentTurn = binding?.currentTurn || {};
  const progressItems = Array.isArray(currentTurn.progressItems) ? currentTurn.progressItems : [];
  const latestProgress = normalizeText(progressItems.at(-1)?.text);
  const planText = normalizeText(currentTurn.planText);
  const promptPreview = normalizeText(currentTurn.promptPreview);
  const detail = latestProgress || planText || (promptPreview ? `Working on: ${promptPreview}` : "Codex is working...");
  return compactDraftText(`Working...\n${detail}`, {
    limit: config.draftStreamingMaxChars,
  });
}

function isInCooldown(draftStream, nowMs) {
  const untilMs = Date.parse(draftStream?.disabledUntil || "");
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

export async function syncDraftStreams({
  config,
  state,
  nowMs = Date.now(),
  onlyBindingKey = null,
  sendMessageDraftFn = sendMessageDraft,
  logEventFn = logBridgeEvent,
} = {}) {
  if (config?.draftStreamingEnabled === false) {
    return { changed: false, sent: 0, skipped: 0, errors: 0 };
  }

  let changed = false;
  let sent = 0;
  let skipped = 0;
  let errors = 0;
  const now = new Date(nowMs).toISOString();
  const errorCooldownMs = Number.isFinite(config?.draftStreamingErrorCooldownMs)
    ? Math.max(0, Number(config.draftStreamingErrorCooldownMs))
    : DEFAULT_DRAFT_STREAMING_ERROR_COOLDOWN_MS;

  for (const [bindingKey, binding] of Object.entries(state?.bindings ?? {})) {
    if (onlyBindingKey && bindingKey !== onlyBindingKey) {
      continue;
    }
    if (!isDraftStreamingBindingEligible(config, binding)) {
      skipped += 1;
      continue;
    }

    const currentTurn = binding.currentTurn || {};
    const draftStream = normalizeDraftStreamState(currentTurn.draftStream);
    if (isInCooldown(draftStream, nowMs)) {
      skipped += 1;
      continue;
    }

    const text = formatDraftStreamingText(binding, config);
    if (!text || draftStream.lastText === text) {
      skipped += 1;
      continue;
    }

    const draftId = Number.isInteger(draftStream.draftId) && draftStream.draftId !== 0
      ? draftStream.draftId
      : makeDraftId(bindingKey, currentTurn);

    try {
      await sendMessageDraftFn(config.botToken, {
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        draftId,
        text,
      });
      binding.currentTurn = {
        ...currentTurn,
        draftStream: {
          draftId,
          lastText: text,
          lastSentAt: now,
        },
      };
      binding.updatedAt = now;
      state.bindings[bindingKey] = binding;
      logEventFn("draft_stream_sent", {
        bindingKey,
        threadId: binding.threadId,
        draftId,
        textLength: text.length,
      });
      changed = true;
      sent += 1;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      binding.currentTurn = {
        ...currentTurn,
        draftStream: {
          ...draftStream,
          draftId,
          disabledUntil: new Date(nowMs + errorCooldownMs).toISOString(),
          lastError: errorMessage,
          lastErrorAt: now,
        },
      };
      binding.updatedAt = now;
      state.bindings[bindingKey] = binding;
      logEventFn("draft_stream_error", {
        bindingKey,
        threadId: binding.threadId,
        draftId,
        disabledUntil: binding.currentTurn.draftStream.disabledUntil,
        error: errorMessage,
      });
      changed = true;
      errors += 1;
    }
  }

  return { changed, sent, skipped, errors };
}
