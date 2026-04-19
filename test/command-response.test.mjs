import test from "node:test";
import assert from "node:assert/strict";

import { buildOpsDmIntro, sendCommandResponse } from "../lib/command-response.mjs";

const topicMessage = {
  chat: { id: -1001, type: "supergroup", title: "Codex Lab" },
  from: { id: 123 },
  message_id: 88,
  message_thread_id: 42,
};

test("buildOpsDmIntro names the source chat and topic", () => {
  assert.equal(buildOpsDmIntro(topicMessage), "**Ops details** from **Codex Lab**, topic 42\n\n");
});

test("sendCommandResponse sends quiet ops details to DM and leaves a topic summary", async () => {
  const calls = [];
  const result = await sendCommandResponse({
    config: { botToken: "token" },
    message: topicMessage,
    text: "health ok",
    quietInTopic: true,
    sendRichTextChunksFn: async (...args) => {
      calls.push(["dm", ...args]);
      return [{ message_id: 1 }];
    },
    replyFn: async (...args) => {
      calls.push(["reply", ...args]);
      return [{ message_id: 2 }];
    },
  });

  assert.deepEqual(result, [{ message_id: 2 }]);
  assert.equal(calls[0][0], "dm");
  assert.deepEqual(calls[0][2], { chatId: 123, messageThreadId: null });
  assert.match(calls[0][3], /health ok/);
  assert.equal(calls[1][0], "reply");
  assert.match(calls[1][3], /direct chat/);
});

test("sendCommandResponse falls back to the topic when DM delivery fails", async () => {
  const events = [];
  const calls = [];
  const result = await sendCommandResponse({
    config: { botToken: "token" },
    message: topicMessage,
    text: "health ok",
    quietInTopic: true,
    sendRichTextChunksFn: async () => {
      throw new Error("bot blocked");
    },
    replyFn: async (...args) => {
      calls.push(args);
      return [{ message_id: 3 }];
    },
    logEventFn: (type, payload) => events.push({ type, payload }),
  });

  assert.deepEqual(result, [{ message_id: 3 }]);
  assert.equal(calls[0][2], "health ok");
  assert.equal(events[0].type, "ops_direct_chat_fallback");
  assert.equal(events[0].payload.chatId, -1001);
});

test("sendCommandResponse replies in place for non-topic commands", async () => {
  const calls = [];
  await sendCommandResponse({
    config: { botToken: "token" },
    message: { chat: { id: 123, type: "private" }, from: { id: 123 }, message_id: 1 },
    text: "settings",
    quietInTopic: true,
    replyFn: async (...args) => calls.push(args),
  });
  assert.equal(calls[0][2], "settings");
});
