import test from "node:test";
import assert from "node:assert/strict";

import {
  completeOutboundProgressMessage,
  upsertOutboundProgressMessage,
} from "../lib/outbound-progress-message.mjs";

const config = { botToken: "token" };
const target = { chatId: -1001, messageThreadId: 42 };

test("upsertOutboundProgressMessage sends a new progress bubble and stores its message id", async () => {
  const binding = {};
  const calls = [];
  const sent = await upsertOutboundProgressMessage({
    config,
    binding,
    target,
    replyToMessageId: 7,
    message: {
      role: "assistant",
      phase: "commentary",
      text: "Running checks",
      timestamp: "2026-04-19T10:00:00.000Z",
    },
    sendRichTextChunksFn: async (...args) => {
      calls.push(args);
      return [{ message_id: 99 }];
    },
  });

  assert.deepEqual(sent, [{ message_id: 99 }]);
  assert.equal(binding.currentTurn.codexProgressMessageId, 99);
  assert.equal(binding.currentTurn.progressItems[0].text, "Running checks");
  assert.equal(calls[0][0], "token");
  assert.deepEqual(calls[0][1], target);
  assert.match(calls[0][2], /> Running checks/);
  assert.equal(calls[0][3], 7);
});

test("upsertOutboundProgressMessage edits an existing progress bubble", async () => {
  const binding = {
    currentTurn: {
      codexProgressMessageId: 99,
      progressItems: [{ text: "Old step", timestamp: "2026-04-19T09:59:00.000Z" }],
    },
  };
  const calls = [];
  const sent = await upsertOutboundProgressMessage({
    config,
    binding,
    target,
    message: {
      role: "plan",
      phase: "update_plan",
      text: "Todo 1/2",
      timestamp: "2026-04-19T10:01:00.000Z",
    },
    changedFilesText: "**Changed files**\n1 file changed +1 -0",
    editThenSendRichTextChunksFn: async (...args) => {
      calls.push(args);
      return [];
    },
  });

  assert.deepEqual(sent, [{ message_id: 99 }]);
  assert.equal(binding.currentTurn.planText, "Todo 1/2");
  assert.match(binding.currentTurn.changedFilesText, /Changed files/);
  assert.equal(calls[0][2], 99);
  assert.match(calls[0][3], /Todo 1\/2/);
});

test("completeOutboundProgressMessage edits progress into final state", async () => {
  const binding = {
    currentTurn: {
      codexProgressMessageId: 99,
      progressItems: [{ text: "Committed changes", timestamp: "2026-04-19T10:02:00.000Z" }],
      changedFilesText: "stale",
    },
  };
  const calls = [];
  const sent = await completeOutboundProgressMessage({
    config,
    binding,
    target,
    editThenSendRichTextChunksFn: async (...args) => {
      calls.push(args);
      return [{ message_id: 99 }];
    },
  });

  assert.deepEqual(sent, [{ message_id: 99 }]);
  assert.equal(binding.currentTurn.changedFilesText, undefined);
  assert.equal(calls[0][2], 99);
  assert.match(calls[0][3], /\*\*Done\*\*/);
  assert.match(calls[0][3], /> Committed changes/);
});

test("completeOutboundProgressMessage is a no-op without reserved progress message", async () => {
  assert.deepEqual(await completeOutboundProgressMessage({ config, binding: {}, target }), []);
});
