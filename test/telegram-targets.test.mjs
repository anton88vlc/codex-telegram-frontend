import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTargetFromBinding,
  buildTargetFromMessage,
  formatTelegramSenderName,
  formatUnboundGroupFallbackBubble,
  isPrivateTopicMessage,
  isTopicMessage,
  truncatePreview,
} from "../lib/telegram-targets.mjs";

test("buildTarget helpers keep chat and topic ids stable", () => {
  assert.deepEqual(
    buildTargetFromMessage({
      chat: { id: -1001 },
      message_thread_id: 42,
    }),
    { chatId: -1001, messageThreadId: 42 },
  );
  assert.deepEqual(
    buildTargetFromBinding({
      chatId: "-1001",
      messageThreadId: 42,
    }),
    { chatId: "-1001", messageThreadId: 42 },
  );
});

test("formatTelegramSenderName prefers human names then username fallback", () => {
  assert.equal(
    formatTelegramSenderName({
      from: { first_name: "Anton", last_name: "Naumov", username: "anton" },
    }),
    "Anton Naumov",
  );
  assert.equal(
    formatTelegramSenderName({
      from: { username: "anton" },
    }),
    "@anton",
  );
});

test("topic classifiers distinguish group topics from private bot topics", () => {
  assert.equal(isTopicMessage({ chat: { type: "supergroup" }, message_thread_id: 10 }), true);
  assert.equal(isTopicMessage({ chat: { type: "private" }, message_thread_id: 10 }), false);
  assert.equal(isPrivateTopicMessage({ chat: { type: "private" }, message_thread_id: 10 }), true);
});

test("formatUnboundGroupFallbackBubble quotes prompt and mentions moved media", () => {
  assert.equal(
    formatUnboundGroupFallbackBubble({
      message: {
        chat: { type: "supergroup" },
        message_thread_id: 1,
        from: { first_name: "Anton" },
      },
      promptText: "проверь\nстатус",
      attachmentRefs: [{}],
      voiceRefs: [{}, {}],
    }),
    [
      "**Anton via General / unbound topic**",
      "",
      "> проверь",
      "> статус",
      "",
      "_1 attachment moved with this prompt._",
      "",
      "_2 voice notes moved with this prompt._",
    ].join("\n"),
  );
});

test("truncatePreview keeps compact previews bounded", () => {
  assert.equal(truncatePreview("abcdef", 4), "a...");
});
