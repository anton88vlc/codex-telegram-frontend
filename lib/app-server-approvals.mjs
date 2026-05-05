import { logBridgeEvent } from "./bridge-events.mjs";
import { normalizeText } from "./message-routing.mjs";
import { answerCallbackQuery, editMessageText, sendMessage } from "./telegram.mjs";

const CALLBACK_PREFIX = "approval";
const INPUT_CALLBACK_PREFIX = "input";
const ELICITATION_CALLBACK_PREFIX = "elicitation";
const TELEGRAM_TEXT_LIMIT = 3_700;

function clip(value, limit) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}...` : text;
}

function ensurePendingApprovals(binding) {
  const currentTurn = ensureCurrentTurn(binding, "Approval requested");
  if (!currentTurn.pendingApprovals || typeof currentTurn.pendingApprovals !== "object") {
    currentTurn.pendingApprovals = {};
  }
  return currentTurn.pendingApprovals;
}

function ensureCurrentTurn(binding, promptPreview) {
  if (!binding.currentTurn || typeof binding.currentTurn !== "object") {
    binding.currentTurn = {
      source: "codex",
      startedAt: new Date().toISOString(),
      promptPreview,
    };
  }
  return binding.currentTurn;
}

function ensurePendingInputs(binding) {
  const currentTurn = ensureCurrentTurn(binding, "Input requested");
  if (!currentTurn.pendingInputs || typeof currentTurn.pendingInputs !== "object") {
    currentTurn.pendingInputs = {};
  }
  return currentTurn.pendingInputs;
}

function ensurePendingElicitations(binding) {
  const currentTurn = ensureCurrentTurn(binding, "Codex request");
  if (!currentTurn.pendingElicitations || typeof currentTurn.pendingElicitations !== "object") {
    currentTurn.pendingElicitations = {};
  }
  return currentTurn.pendingElicitations;
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

export function buildInputCallbackData(requestId, action) {
  return `${INPUT_CALLBACK_PREFIX}:${String(requestId)}:${String(action)}`;
}

export function parseInputCallbackData(data) {
  const parts = String(data || "").split(":");
  if (parts.length !== 3 || parts[0] !== INPUT_CALLBACK_PREFIX) {
    return null;
  }
  const requestId = normalizeText(parts[1]);
  const action = normalizeText(parts[2]);
  if (!requestId || !["skip"].includes(action)) {
    return null;
  }
  return { requestId, action };
}

export function buildElicitationCallbackData(requestId, action) {
  return `${ELICITATION_CALLBACK_PREFIX}:${String(requestId)}:${String(action)}`;
}

export function parseElicitationCallbackData(data) {
  const parts = String(data || "").split(":");
  if (parts.length !== 3 || parts[0] !== ELICITATION_CALLBACK_PREFIX) {
    return null;
  }
  const requestId = normalizeText(parts[1]);
  const action = normalizeText(parts[2]);
  if (!requestId || !["accept", "decline"].includes(action)) {
    return null;
  }
  return { requestId, action };
}

export function buildApprovalDecision({ action, requestKind = "command", proposedExecpolicyAmendment = null } = {}) {
  if (requestKind === "permissions") {
    return {
      permissions: action === "decline" ? {} : proposedExecpolicyAmendment || {},
      scope: action === "accept_session" ? "session" : "turn",
    };
  }
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
  const title =
    event.requestKind === "file"
      ? "Approval needed: file change"
      : event.requestKind === "permissions"
        ? "Approval needed: extra access"
        : "Approval needed: command";
  const lines = [title];
  if (event.approvalReason) {
    lines.push(`Reason: ${event.approvalReason}`);
  }
  if (event.commandText) {
    lines.push("", "Command:", clip(event.commandText, 1_200));
  } else if (event.grantRoot) {
    lines.push("", `Path: ${event.grantRoot}`);
  } else if (event.permissions) {
    lines.push("", "Requested:", clip(JSON.stringify(event.permissions, null, 2), 1_200));
  }
  lines.push("", "Approve it here, or handle it in Codex Desktop.");
  return clip(lines.join("\n"), TELEGRAM_TEXT_LIMIT);
}

export function buildApprovalReplyMarkup(event) {
  const requestId = event.requestId;
  if (event.requestKind === "permissions") {
    return {
      inline_keyboard: [
        [
          { text: "Approve turn", callback_data: buildApprovalCallbackData(requestId, "accept") },
          { text: "Approve session", callback_data: buildApprovalCallbackData(requestId, "accept_session") },
        ],
        [{ text: "Deny", callback_data: buildApprovalCallbackData(requestId, "decline") }],
      ],
    };
  }
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
    permissions: event.permissions || null,
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

function formatQuestion(question, index) {
  const lines = [];
  const label = question.header ? `${index + 1}. ${question.header}` : `${index + 1}.`;
  lines.push(`${label} ${question.question}`.trim());
  for (const option of question.options || []) {
    lines.push(`- ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  }
  return lines.join("\n");
}

export function formatUserInputRequestText(event) {
  const questions = Array.isArray(event.questions) ? event.questions : [];
  const lines = ["Codex needs your input"];
  if (questions.length) {
    lines.push("", ...questions.map(formatQuestion));
  } else {
    lines.push("", "Codex asked for input, but did not include a readable question.");
  }
  lines.push("", "Reply to this message with the answer, or tap Skip.");
  return clip(lines.join("\n"), TELEGRAM_TEXT_LIMIT);
}

export function buildUserInputReplyMarkup(event) {
  return {
    inline_keyboard: [[{ text: "Skip", callback_data: buildInputCallbackData(event.requestId, "skip") }]],
  };
}

export function buildUserInputResponse({ questions = [], text = "" } = {}) {
  const answerText = normalizeText(text);
  if (!answerText) {
    return { answers: {} };
  }
  const normalizedQuestions = Array.isArray(questions) ? questions.filter((question) => question?.id) : [];
  if (!normalizedQuestions.length) {
    return { answers: { answer: { answers: [answerText] } } };
  }
  const answers = {};
  const byIndex = new Map(normalizedQuestions.map((question, index) => [String(index + 1), question.id]));
  const byId = new Map(normalizedQuestions.map((question) => [String(question.id), question.id]));
  for (const line of answerText.split(/\n+/)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+|\d+)\s*[:.)-]\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const questionId = byIndex.get(match[1]) || byId.get(match[1]);
    if (questionId) {
      answers[questionId] = { answers: [match[2].trim()] };
    }
  }
  if (!Object.keys(answers).length) {
    answers[normalizedQuestions[0].id] = { answers: [answerText] };
  }
  return { answers };
}

export async function sendUserInputRequestToTelegram({
  config,
  binding,
  bindingKey,
  event,
  replyToMessageId = null,
  sendMessageFn = sendMessage,
  logEventFn = logBridgeEvent,
}) {
  const pending = ensurePendingInputs(binding);
  const existing = pending[event.requestId];
  if (existing?.telegramMessageId) {
    return { sent: null, duplicate: true };
  }

  const sent = await sendMessageFn(config.botToken, {
    chatId: binding.chatId,
    messageThreadId: binding.messageThreadId ?? null,
    text: formatUserInputRequestText(event),
    replyToMessageId,
    replyMarkup: buildUserInputReplyMarkup(event),
  });

  pending[event.requestId] = {
    requestId: event.requestId,
    requestKind: event.requestKind,
    method: event.method,
    threadId: event.threadId,
    turnId: event.turnId,
    questions: event.questions || [],
    telegramMessageId: sent?.message_id ?? null,
    createdAt: event.ts || new Date().toISOString(),
  };
  binding.updatedAt = new Date().toISOString();
  logEventFn("app_server_user_input_request_sent", {
    bindingKey,
    threadId: binding.threadId,
    requestId: event.requestId,
    questionCount: event.questions?.length ?? 0,
  });
  return { sent, duplicate: false };
}

export function formatMcpElicitationRequestText(event) {
  const title =
    event.kind === "tool_suggestion"
      ? `Codex wants to ${event.suggestType || "use"} ${event.toolName || "a tool"}`
      : event.kind === "mcp_tool_call"
        ? `Codex wants to call ${event.toolName || "an MCP tool"}`
        : "Codex needs a decision";
  const lines = [title];
  if (event.riskLevel) {
    lines.push(`Risk: ${event.riskLevel}`);
  }
  if (event.subtitle) {
    lines.push(`Note: ${event.subtitle}`);
  }
  if (event.message) {
    lines.push("", event.message);
  }
  if (event.suggestReason) {
    lines.push("", `Reason: ${event.suggestReason}`);
  }
  if (event.toolParams) {
    lines.push("", "Tool params:", clip(JSON.stringify(event.toolParams, null, 2), 1_200));
  }
  lines.push("", "Approve it here, or handle it in Codex Desktop.");
  return clip(lines.join("\n"), TELEGRAM_TEXT_LIMIT);
}

export function buildMcpElicitationReplyMarkup(event) {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: buildElicitationCallbackData(event.requestId, "accept") },
        { text: "Deny", callback_data: buildElicitationCallbackData(event.requestId, "decline") },
      ],
    ],
  };
}

export function buildMcpElicitationResponse(action) {
  return action === "accept"
    ? { action: "accept", content: {}, _meta: null }
    : { action: "decline", content: null, _meta: null };
}

export async function sendMcpElicitationRequestToTelegram({
  config,
  binding,
  bindingKey,
  event,
  replyToMessageId = null,
  sendMessageFn = sendMessage,
  logEventFn = logBridgeEvent,
}) {
  const pending = ensurePendingElicitations(binding);
  const existing = pending[event.requestId];
  if (existing?.telegramMessageId) {
    return { sent: null, duplicate: true };
  }

  const sent = await sendMessageFn(config.botToken, {
    chatId: binding.chatId,
    messageThreadId: binding.messageThreadId ?? null,
    text: formatMcpElicitationRequestText(event),
    replyToMessageId,
    replyMarkup: buildMcpElicitationReplyMarkup(event),
  });

  pending[event.requestId] = {
    requestId: event.requestId,
    requestKind: event.requestKind,
    method: event.method,
    threadId: event.threadId,
    turnId: event.turnId,
    kind: event.kind || "generic",
    telegramMessageId: sent?.message_id ?? null,
    createdAt: event.ts || new Date().toISOString(),
  };
  binding.updatedAt = new Date().toISOString();
  logEventFn("app_server_elicitation_request_sent", {
    bindingKey,
    threadId: binding.threadId,
    requestId: event.requestId,
    kind: event.kind || "generic",
  });
  return { sent, duplicate: false };
}

export function findPendingInputByTelegramReply(state, message) {
  const replyToMessageId = message?.reply_to_message?.message_id;
  if (!Number.isInteger(replyToMessageId)) {
    return null;
  }
  const chatId = message?.chat?.id == null ? null : String(message.chat.id);
  const topicId = message?.message_thread_id ?? null;
  for (const [bindingKey, binding] of Object.entries(state.bindings ?? {})) {
    if (chatId && String(binding?.chatId) !== chatId) {
      continue;
    }
    if ((binding?.messageThreadId ?? null) !== topicId) {
      continue;
    }
    const pending = binding?.currentTurn?.pendingInputs;
    if (!pending || typeof pending !== "object") {
      continue;
    }
    for (const [requestId, input] of Object.entries(pending)) {
      if (input?.telegramMessageId === replyToMessageId) {
        return { bindingKey, binding, requestId, input };
      }
    }
  }
  return null;
}

export async function handlePendingUserInputReply({
  config,
  state,
  message,
  responseText,
  appServerStream,
  replyFn,
  saveStateFn = null,
  logEventFn = logBridgeEvent,
}) {
  const pending = findPendingInputByTelegramReply(state, message);
  if (!pending) {
    return false;
  }
  const requestId = pending.requestId;
  const text = normalizeText(responseText);
  if (!appServerStream?.hasServerRequest?.(requestId)) {
    delete pending.binding.currentTurn.pendingInputs[requestId];
    state.bindings[pending.bindingKey] = pending.binding;
    if (typeof saveStateFn === "function") {
      await saveStateFn(config.statePath, state);
    }
    await replyFn(config.botToken, message, "Codex no longer waits for this input. Handle this one in Codex Desktop.");
    return true;
  }
  const response = buildUserInputResponse({ questions: pending.input.questions || [], text });
  const sent = appServerStream.respondToServerRequest(requestId, response);
  if (!sent) {
    await replyFn(config.botToken, message, "Codex no longer waits for this input. Handle this one in Codex Desktop.");
    return true;
  }
  delete pending.binding.currentTurn.pendingInputs[requestId];
  pending.binding.updatedAt = new Date().toISOString();
  state.bindings[pending.bindingKey] = pending.binding;
  if (typeof saveStateFn === "function") {
    await saveStateFn(config.statePath, state);
  }
  await replyFn(config.botToken, message, text ? "Sent to Codex." : "Skipped.");
  logEventFn("app_server_user_input_reply", {
    requestId,
    bindingKey: pending.bindingKey,
    answered: Boolean(text),
  });
  return true;
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
    proposedExecpolicyAmendment:
      pending?.approval?.requestKind === "permissions"
        ? pending?.approval?.permissions || {}
        : pending?.approval?.proposedExecpolicyAmendment || null,
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

export async function handleAppServerRequestCallbackQuery(args) {
  const {
    config,
    state,
    callbackQuery,
    appServerStream,
    answerCallbackQueryFn = answerCallbackQuery,
    editMessageTextFn = editMessageText,
    logEventFn = logBridgeEvent,
  } = args;
  if (parseApprovalCallbackData(callbackQuery?.data)) {
    return handleApprovalCallbackQuery(args);
  }

  const input = parseInputCallbackData(callbackQuery?.data);
  if (input) {
    const pending = findPendingInput(state, input.requestId);
    if (!appServerStream?.hasServerRequest?.(input.requestId)) {
      await answerCallbackQueryFn(config.botToken, {
        callbackQueryId: callbackQuery.id,
        text: "This request expired. Use Codex Desktop for this one.",
        showAlert: true,
      });
      return true;
    }
    const sent = appServerStream.respondToServerRequest(input.requestId, { answers: {} });
    if (!sent) {
      await answerCallbackQueryFn(config.botToken, {
        callbackQueryId: callbackQuery.id,
        text: "Codex no longer waits for this input.",
        showAlert: true,
      });
      return true;
    }
    if (pending?.binding?.currentTurn?.pendingInputs) {
      delete pending.binding.currentTurn.pendingInputs[input.requestId];
    }
    if (pending?.bindingKey) {
      pending.binding.updatedAt = new Date().toISOString();
      state.bindings[pending.bindingKey] = pending.binding;
    }
    await answerCallbackQueryFn(config.botToken, { callbackQueryId: callbackQuery.id, text: "Skipped." });
    await clearInlineKeyboard({ config, callbackQuery, editMessageTextFn, suffix: "Skipped from Telegram." });
    logEventFn("app_server_user_input_callback", { requestId: input.requestId, action: input.action });
    return true;
  }

  const elicitation = parseElicitationCallbackData(callbackQuery?.data);
  if (!elicitation) {
    return false;
  }
  const pending = findPendingElicitation(state, elicitation.requestId);
  if (!appServerStream?.hasServerRequest?.(elicitation.requestId)) {
    await answerCallbackQueryFn(config.botToken, {
      callbackQueryId: callbackQuery.id,
      text: "This request expired. Use Codex Desktop for this one.",
      showAlert: true,
    });
    return true;
  }
  const sent = appServerStream.respondToServerRequest(
    elicitation.requestId,
    buildMcpElicitationResponse(elicitation.action),
  );
  if (!sent) {
    await answerCallbackQueryFn(config.botToken, {
      callbackQueryId: callbackQuery.id,
      text: "Codex no longer waits for this request.",
      showAlert: true,
    });
    return true;
  }
  if (pending?.binding?.currentTurn?.pendingElicitations) {
    delete pending.binding.currentTurn.pendingElicitations[elicitation.requestId];
  }
  if (pending?.bindingKey) {
    pending.binding.updatedAt = new Date().toISOString();
    state.bindings[pending.bindingKey] = pending.binding;
  }
  const approved = elicitation.action === "accept";
  await answerCallbackQueryFn(config.botToken, {
    callbackQueryId: callbackQuery.id,
    text: approved ? "Approved." : "Denied.",
  });
  await clearInlineKeyboard({
    config,
    callbackQuery,
    editMessageTextFn,
    suffix: approved ? "Approved from Telegram." : "Denied from Telegram.",
  });
  logEventFn("app_server_elicitation_callback", {
    requestId: elicitation.requestId,
    action: elicitation.action,
    approved,
    bindingKey: pending?.bindingKey || null,
  });
  return true;
}

function findPendingInput(state, requestId) {
  const normalizedRequestId = String(requestId);
  for (const [bindingKey, binding] of Object.entries(state.bindings ?? {})) {
    const pending = binding?.currentTurn?.pendingInputs;
    if (pending && typeof pending === "object" && pending[normalizedRequestId]) {
      return { bindingKey, binding, input: pending[normalizedRequestId] };
    }
  }
  return null;
}

function findPendingElicitation(state, requestId) {
  const normalizedRequestId = String(requestId);
  for (const [bindingKey, binding] of Object.entries(state.bindings ?? {})) {
    const pending = binding?.currentTurn?.pendingElicitations;
    if (pending && typeof pending === "object" && pending[normalizedRequestId]) {
      return { bindingKey, binding, elicitation: pending[normalizedRequestId] };
    }
  }
  return null;
}

async function clearInlineKeyboard({ config, callbackQuery, editMessageTextFn, suffix }) {
  const message = callbackQuery?.message;
  if (!message?.chat?.id || !message?.message_id) {
    return;
  }
  const baseText = normalizeText(message.text || message.caption || "Codex request");
  await editMessageTextFn(config.botToken, {
    chatId: message.chat.id,
    messageId: message.message_id,
    text: clip(`${baseText}\n\n${suffix}`, TELEGRAM_TEXT_LIMIT),
    replyMarkup: { inline_keyboard: [] },
  });
}
