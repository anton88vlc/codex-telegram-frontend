import test from "node:test";
import assert from "node:assert/strict";

import {
  buildApprovalCallbackData,
  buildApprovalDecision,
  buildApprovalReplyMarkup,
  buildMcpElicitationResponse,
  buildUserInputResponse,
  formatApprovalRequestText,
  formatMcpElicitationRequestText,
  formatUserInputRequestText,
  handleAppServerRequestCallbackQuery,
  handleApprovalCallbackQuery,
  handlePendingUserInputReply,
  parseApprovalCallbackData,
  parseElicitationCallbackData,
  parseInputCallbackData,
  sendApprovalRequestToTelegram,
  sendMcpElicitationRequestToTelegram,
  sendUserInputRequestToTelegram,
} from "../lib/app-server-approvals.mjs";

test("approval callback data round-trips compactly", () => {
  const data = buildApprovalCallbackData(77, "accept_prefix");

  assert.equal(data, "approval:77:accept_prefix");
  assert.deepEqual(parseApprovalCallbackData(data), {
    requestId: "77",
    action: "accept_prefix",
  });
});

test("approval decision maps Codex command choices", () => {
  assert.equal(buildApprovalDecision({ action: "accept" }), "accept");
  assert.equal(buildApprovalDecision({ action: "accept_session" }), "acceptForSession");
  assert.equal(buildApprovalDecision({ action: "decline" }), "decline");
  assert.deepEqual(
    buildApprovalDecision({
      action: "accept_prefix",
      requestKind: "command",
      proposedExecpolicyAmendment: ["ps"],
    }),
    {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["ps"],
      },
    },
  );
});

test("approval decision maps permissions choices", () => {
  assert.deepEqual(
    buildApprovalDecision({
      action: "accept_session",
      requestKind: "permissions",
      proposedExecpolicyAmendment: { network: { enabled: true } },
    }),
    {
      permissions: { network: { enabled: true } },
      scope: "session",
    },
  );
  assert.deepEqual(buildApprovalDecision({ action: "decline", requestKind: "permissions" }), {
    permissions: {},
    scope: "turn",
  });
});

test("approval message shows command and useful buttons", () => {
  const event = {
    requestId: "77",
    requestKind: "command",
    approvalReason: "Need a read-only process check.",
    commandText: "ps -ax",
    proposedExecpolicyAmendment: ["ps"],
  };

  assert.match(formatApprovalRequestText(event), /Approval needed: command/);
  assert.match(formatApprovalRequestText(event), /ps -ax/);
  assert.deepEqual(buildApprovalReplyMarkup(event).inline_keyboard[0], [
    { text: "Approve once", callback_data: "approval:77:accept" },
    { text: "Approve prefix", callback_data: "approval:77:accept_prefix" },
  ]);
});

test("sendApprovalRequestToTelegram stores pending request on current turn", async () => {
  const binding = {
    chatId: "-100",
    messageThreadId: 12,
    threadId: "thread-1",
    currentTurn: {},
  };
  const sentCalls = [];

  const result = await sendApprovalRequestToTelegram({
    config: { botToken: "token" },
    binding,
    bindingKey: "group:-100:topic:12",
    event: {
      requestId: "77",
      requestKind: "command",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      commandText: "ps -ax",
      proposedExecpolicyAmendment: ["ps"],
    },
    sendMessageFn: async (token, payload) => {
      sentCalls.push({ token, payload });
      return { message_id: 123 };
    },
    logEventFn: () => {},
  });

  assert.equal(result.sent.message_id, 123);
  assert.equal(sentCalls[0].payload.replyMarkup.inline_keyboard[0][0].text, "Approve once");
  assert.equal(binding.currentTurn.pendingApprovals["77"].telegramMessageId, 123);
});

test("user input request can be answered by replying in Telegram", async () => {
  const state = {
    bindings: {
      "group:-100:topic:12": {
        chatId: "-100",
        messageThreadId: 12,
        threadId: "thread-1",
        currentTurn: {
          pendingInputs: {
            79: {
              requestId: "79",
              questions: [{ id: "direction", question: "What should I do?" }],
              telegramMessageId: 555,
            },
          },
        },
      },
    },
  };
  const responses = [];
  const replies = [];

  const handled = await handlePendingUserInputReply({
    config: { botToken: "token", statePath: "/tmp/state.json" },
    state,
    message: {
      chat: { id: -100 },
      message_id: 556,
      message_thread_id: 12,
      reply_to_message: { message_id: 555 },
    },
    responseText: "Use the safe route.",
    appServerStream: {
      hasServerRequest: (requestId) => requestId === "79",
      respondToServerRequest(requestId, result) {
        responses.push({ requestId, result });
        return true;
      },
    },
    replyFn: async (token, message, text) => replies.push({ token, message, text }),
    saveStateFn: async () => {},
    logEventFn: () => {},
  });

  assert.equal(handled, true);
  assert.deepEqual(responses[0].result, {
    answers: { direction: { answers: ["Use the safe route."] } },
  });
  assert.equal(replies[0].text, "Sent to Codex.");
  assert.equal(state.bindings["group:-100:topic:12"].currentTurn.pendingInputs["79"], undefined);
});

test("user input request formatting and callbacks stay compact", () => {
  const event = {
    requestId: "79",
    questions: [
      {
        id: "direction",
        header: "Direction",
        question: "Which route should I take?",
        options: [{ label: "Safe", description: "Avoid risky writes." }],
      },
    ],
  };

  assert.match(formatUserInputRequestText(event), /Codex needs your input/);
  assert.match(formatUserInputRequestText(event), /Safe/);
  assert.deepEqual(parseInputCallbackData("input:79:skip"), { requestId: "79", action: "skip" });
  assert.deepEqual(buildUserInputResponse({ questions: event.questions, text: "1: Safe" }), {
    answers: { direction: { answers: ["Safe"] } },
  });
});

test("sendUserInputRequestToTelegram stores pending input", async () => {
  const binding = {
    chatId: "-100",
    messageThreadId: 12,
    threadId: "thread-1",
    currentTurn: {},
  };
  const sent = await sendUserInputRequestToTelegram({
    config: { botToken: "token" },
    binding,
    bindingKey: "group:-100:topic:12",
    event: {
      requestId: "79",
      requestKind: "user_input",
      method: "item/tool/requestUserInput",
      threadId: "thread-1",
      questions: [{ id: "direction", question: "What now?" }],
    },
    sendMessageFn: async () => ({ message_id: 555 }),
    logEventFn: () => {},
  });

  assert.equal(sent.sent.message_id, 555);
  assert.equal(binding.currentTurn.pendingInputs["79"].telegramMessageId, 555);
});

test("MCP elicitation request uses accept/decline callback responses", async () => {
  const binding = {
    chatId: "-100",
    messageThreadId: 12,
    threadId: "thread-1",
    currentTurn: {},
  };
  await sendMcpElicitationRequestToTelegram({
    config: { botToken: "token" },
    binding,
    bindingKey: "group:-100:topic:12",
    event: {
      requestId: "80",
      requestKind: "mcp_elicitation",
      method: "mcpServer/elicitation/request",
      threadId: "thread-1",
      kind: "tool_suggestion",
      toolName: "Linear",
      suggestType: "install",
      suggestReason: "Track work.",
    },
    sendMessageFn: async (token, payload) => {
      assert.match(payload.text, /Linear/);
      return { message_id: 556 };
    },
    logEventFn: () => {},
  });

  assert.equal(binding.currentTurn.pendingElicitations["80"].telegramMessageId, 556);
  assert.deepEqual(parseElicitationCallbackData("elicitation:80:decline"), {
    requestId: "80",
    action: "decline",
  });
  assert.deepEqual(buildMcpElicitationResponse("accept"), {
    action: "accept",
    content: {},
    _meta: null,
  });
  assert.match(formatMcpElicitationRequestText({ kind: "generic", message: "Allow it?", requestId: "80" }), /Allow it/);
});

test("handleApprovalCallbackQuery responds to app-server and edits Telegram message", async () => {
  const state = {
    bindings: {
      "group:-100:topic:12": {
        chatId: "-100",
        messageThreadId: 12,
        threadId: "thread-1",
        currentTurn: {
          pendingApprovals: {
            77: {
              requestKind: "command",
              proposedExecpolicyAmendment: ["ps"],
            },
          },
        },
      },
    },
  };
  const decisions = [];
  const answers = [];
  const edits = [];

  const handled = await handleApprovalCallbackQuery({
    config: { botToken: "token" },
    state,
    callbackQuery: {
      id: "callback-1",
      data: "approval:77:accept_prefix",
      message: {
        chat: { id: -100 },
        message_id: 123,
        text: "Approval needed: command",
      },
    },
    appServerStream: {
      hasServerRequest(requestId) {
        return requestId === "77";
      },
      respondToServerRequest(requestId, result) {
        decisions.push({ requestId, result });
        return true;
      },
    },
    answerCallbackQueryFn: async (token, payload) => answers.push({ token, payload }),
    editMessageTextFn: async (token, payload) => edits.push({ token, payload }),
    logEventFn: () => {},
  });

  assert.equal(handled, true);
  assert.deepEqual(decisions[0].result, {
    decision: {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["ps"],
      },
    },
  });
  assert.equal(answers[0].payload.text, "Approved.");
  assert.match(edits[0].payload.text, /Approved from Telegram/);
  assert.equal(state.bindings["group:-100:topic:12"].currentTurn.pendingApprovals["77"], undefined);
});
