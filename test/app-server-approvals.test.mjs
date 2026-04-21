import test from "node:test";
import assert from "node:assert/strict";

import {
  buildApprovalCallbackData,
  buildApprovalDecision,
  buildApprovalReplyMarkup,
  formatApprovalRequestText,
  handleApprovalCallbackQuery,
  parseApprovalCallbackData,
  sendApprovalRequestToTelegram,
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
