import { logBridgeEvent } from "./bridge-events.mjs";
import { normalizeText } from "./message-routing.mjs";
import { answerCallbackQuery, editMessageText, sendMessage } from "./telegram.mjs";

const CALLBACK_PREFIX = "approval";
const TELEGRAM_TEXT_LIMIT = 3_700;

function clip(value, limit) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}...` : text;
}

function ensurePendingApprovals(binding) {
  if (!binding.currentTurn || typeof binding.currentTurn !== "object") {
    binding.currentTurn = {
      source: "codex",
      startedAt: new Date().toISOString(),
      promptPreview: "Approval requested",
    };
  }
  if (!binding.currentTurn.pendingApprovals || typeof binding.currentTurn.pendingApprovals !== "object") {
    binding.currentTurn.pendingApprovals = {};
  }
  return binding.currentTurn.pendingApprovals;
}

export function buildApprovalCallbackData(requestId, action) {
  return `${CALLBACK_PREFIX}:${String(requestId)}:${String(action)}`;
}

export function parseApprovalCallbackData(data) {
  const parts = String(data || "").split(":");
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) {
    return null;
  }
  const requestId = normalizeText(parts[1]);
  const action = normalizeText(parts[2]);
  if (!requestId || !["accept", "accept_session", "accept_prefix", "decline"].includes(action)) {
    return null;
  }
  return { requestId, action };
}

export function buildApprovalDecision({ action, requestKind = "command", proposedExecpolicyAmendment = null } = {}) {
  if (action === "decline") {
    return "decline";
  }
  if (action === "accept") {
    return "accept";
  }
  if (requestKind === "command" && action === "accept_prefix" && proposedExecpolicyAmendment) {
    return {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: proposedExecpolicyAmendment,
      },
    };
  }
  return "acceptForSession";
}

export function formatApprovalRequestText(event) {
  const lines = [event.requestKind === "file" ? "Approval needed: file change" : "Approval needed: command"];
  if (event.approvalReason) {
    lines.push(`Reason: ${event.approvalReason}`);
  }
  if (event.commandText) {
    lines.push("", "Command:", clip(event.commandText, 1_200));
  } else if (event.grantRoot) {
    lines.push("", `Path: ${event.grantRoot}`);
  }
  lines.push("", "Approve it here, or handle it in Codex Desktop.");
  return clip(lines.join("\n"), TELEGRAM_TEXT_LIMIT);
}

export function buildApprovalReplyMarkup(event) {
  const requestId = event.requestId;
  const secondAction =
    event.requestKind === "command" && event.proposedExecpolicyAmendment ? "accept_prefix" : "accept_session";
  const secondLabel =
    event.requestKind === "command" && event.proposedExecpolicyAmendment ? "Approve prefix" : "Approve session";
  return {
    inline_keyboard: [
      [
        { text: "Approve once", callback_data: buildApprovalCallbackData(requestId, "accept") },
        { text: secondLabel, callback_data: buildApprovalCallbackData(requestId, secondAction) },
      ],
      [{ text: "Deny", callback_data: buildApprovalCallbackData(requestId, "decline") }],
    ],
  };
}

export async function sendApprovalRequestToTelegram({
  config,
  binding,
  bindingKey,
  event,
  replyToMessageId = null,
  sendMessageFn = sendMessage,
  logEventFn = logBridgeEvent,
}) {
  const pending = ensurePendingApprovals(binding);
  const existing = pending[event.requestId];
  if (existing?.telegramMessageId) {
    return { sent: null, duplicate: true };
  }

  const sent = await sendMessageFn(config.botToken, {
    chatId: binding.chatId,
    messageThreadId: binding.messageThreadId ?? null,
    text: formatApprovalRequestText(event),
    replyToMessageId,
    replyMarkup: buildApprovalReplyMarkup(event),
  });

  pending[event.requestId] = {
    requestId: event.requestId,
    requestKind: event.requestKind,
    method: event.method,
    threadId: event.threadId,
    turnId: event.turnId,
    commandText: event.commandText || null,
    proposedExecpolicyAmendment: event.proposedExecpolicyAmendment || null,
    telegramMessageId: sent?.message_id ?? null,
    createdAt: event.ts || new Date().toISOString(),
  };
  binding.updatedAt = new Date().toISOString();
  logEventFn("app_server_approval_request_sent", {
    bindingKey,
    threadId: binding.threadId,
    requestId: event.requestId,
    requestKind: event.requestKind,
  });
  return { sent, duplicate: false };
}

export function findPendingApproval(state, requestId) {
  const normalizedRequestId = String(requestId);
  for (const [bindingKey, binding] of Object.entries(state.bindings ?? {})) {
    const pending = binding?.currentTurn?.pendingApprovals;
    if (pending && typeof pending === "object" && pending[normalizedRequestId]) {
      return {
        bindingKey,
        binding,
        approval: pending[normalizedRequestId],
      };
    }
  }
  return null;
}

export async function handleApprovalCallbackQuery({
  config,
  state,
  callbackQuery,
  appServerStream,
  answerCallbackQueryFn = answerCallbackQuery,
  editMessageTextFn = editMessageText,
  logEventFn = logBridgeEvent,
}) {
  const parsed = parseApprovalCallbackData(callbackQuery?.data);
  if (!parsed) {
    return false;
  }

  const message = callbackQuery.message;
  const pending = findPendingApproval(state, parsed.requestId);
  if (!appServerStream?.hasServerRequest?.(parsed.requestId)) {
    await answerCallbackQueryFn(config.botToken, {
      callbackQueryId: callbackQuery.id,
      text: "This approval expired. Use Codex Desktop for this one.",
      showAlert: true,
    });
    return true;
  }

  const decision = buildApprovalDecision({
    action: parsed.action,
    requestKind: pending?.approval?.requestKind || "command",
    proposedExecpolicyAmendment: pending?.approval?.proposedExecpolicyAmendment || null,
  });
  const sent = appServerStream.respondToServerRequest(parsed.requestId, { decision });
  if (!sent) {
    await answerCallbackQueryFn(config.botToken, {
      callbackQueryId: callbackQuery.id,
      text: "Codex no longer waits for this approval.",
      showAlert: true,
    });
    return true;
  }

  const approved = parsed.action !== "decline";
  if (pending?.binding?.currentTurn?.pendingApprovals) {
    delete pending.binding.currentTurn.pendingApprovals[parsed.requestId];
  }
  if (pending?.bindingKey) {
    pending.binding.updatedAt = new Date().toISOString();
    state.bindings[pending.bindingKey] = pending.binding;
  }

  await answerCallbackQueryFn(config.botToken, {
    callbackQueryId: callbackQuery.id,
    text: approved ? "Approved." : "Denied.",
  });
  if (message?.chat?.id && message?.message_id) {
    const baseText = normalizeText(message.text || message.caption || "Approval request");
    await editMessageTextFn(config.botToken, {
      chatId: message.chat.id,
      messageId: message.message_id,
      text: clip(`${baseText}\n\n${approved ? "Approved from Telegram." : "Denied from Telegram."}`, TELEGRAM_TEXT_LIMIT),
      replyMarkup: { inline_keyboard: [] },
    });
  }
  logEventFn("app_server_approval_callback", {
    requestId: parsed.requestId,
    action: parsed.action,
    approved,
    bindingKey: pending?.bindingKey || null,
  });
  return true;
}
