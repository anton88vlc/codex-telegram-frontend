import test from "node:test";
import assert from "node:assert/strict";

import {
  deleteForumTopic,
  deleteMessages,
  downloadTelegramFile,
  getFile,
  sendMessage,
  sendMessageDraft,
  setChatMenuButton,
  setMyDefaultAdministratorRights,
  setMyShortDescription,
  splitTelegramText,
} from "../lib/telegram.mjs";
import {
  formatBotPrivateTopicReadiness,
  isPrivateTopicModeMissingError,
  normalizeBotPrivateTopicReadiness,
} from "../lib/bot-private-topics.mjs";

async function withMockTelegramFetch(fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      body: JSON.parse(options.body),
    });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("splitTelegramText keeps short text in one chunk", () => {
  assert.deepEqual(splitTelegramText("короткий текст"), ["короткий текст"]);
});

test("splitTelegramText splits long paragraphs without losing content", () => {
  const text = `Первый абзац.\n\n${"x".repeat(4000)}\n\nФинал.`;
  const chunks = splitTelegramText(text);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
  assert.equal(chunks[0], "Первый абзац.");
  assert.ok(chunks.at(-1).endsWith("Финал."));
  const xCount = chunks.join("").split("").filter((char) => char === "x").length;
  assert.equal(xCount, 4000);
});

test("sendMessage can attach inline keyboard markup for ops actions", async () => {
  await withMockTelegramFetch(async (calls) => {
    await sendMessage("token", {
      chatId: 123,
      messageThreadId: 7,
      text: "Preview ready",
      replyMarkup: {
        inline_keyboard: [[{ text: "Apply", callback_data: "apply:1" }]],
      },
    });

    assert.equal(calls[0].url, "https://api.telegram.org/bottoken/sendMessage");
    assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[0][0], {
      text: "Apply",
      callback_data: "apply:1",
    });
    assert.equal(calls[0].body.message_thread_id, 7);
  });
});

test("sendMessage sends explicit entities instead of parse mode", async () => {
  await withMockTelegramFetch(async (calls) => {
    await sendMessage("token", {
      chatId: 123,
      text: "reset 23:58",
      parseMode: "HTML",
      entities: [{ type: "date_time", offset: 6, length: 5, unix_time: 1776549480, date_time_format: "t" }],
    });

    assert.equal(calls[0].body.parse_mode, undefined);
    assert.deepEqual(calls[0].body.entities, [
      { type: "date_time", offset: 6, length: 5, unix_time: 1776549480, date_time_format: "t" },
    ]);
  });
});

test("getFile asks Bot API for a file path", async () => {
  await withMockTelegramFetch(async (calls) => {
    await getFile("token", { fileId: "abc123" });

    assert.equal(calls[0].url, "https://api.telegram.org/bottoken/getFile");
    assert.equal(calls[0].body.file_id, "abc123");
  });
});

test("downloadTelegramFile fetches file bytes from Bot API file endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(Buffer.from("bytes"), { status: 200 });
  };
  try {
    const bytes = await downloadTelegramFile("token", { filePath: "photos/file 1.jpg" });
    assert.equal(calls[0], "https://api.telegram.org/file/bottoken/photos/file%201.jpg");
    assert.equal(bytes.toString("utf8"), "bytes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deleteMessages batches ids for Bot API cleanup", async () => {
  await withMockTelegramFetch(async (calls) => {
    const ids = Array.from({ length: 205 }, (_, index) => index + 1);
    const result = await deleteMessages("token", {
      chatId: -100,
      messageIds: [1, ...ids, 0, "nope"],
    });

    assert.deepEqual(result, { requested: 205, batches: 3, ok: true });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, "https://api.telegram.org/bottoken/deleteMessages");
    assert.equal(calls[0].body.message_ids.length, 100);
    assert.equal(calls[2].body.message_ids.length, 5);
  });
});

test("deleteForumTopic deletes temporary private topic smokes", async () => {
  await withMockTelegramFetch(async (calls) => {
    await deleteForumTopic("token", {
      chatId: 42,
      messageThreadId: 7,
    });

    assert.equal(calls[0].url, "https://api.telegram.org/bottoken/deleteForumTopic");
    assert.equal(calls[0].body.chat_id, 42);
    assert.equal(calls[0].body.message_thread_id, 7);
  });
});

test("sendMessageDraft exposes Telegram private-chat draft streaming", async () => {
  await withMockTelegramFetch(async (calls) => {
    await sendMessageDraft("token", {
      chatId: 42,
      messageThreadId: 3,
      draftId: 99,
      text: "working...",
      parseMode: "HTML",
    });

    assert.equal(calls[0].url, "https://api.telegram.org/bottoken/sendMessageDraft");
    assert.equal(calls[0].body.draft_id, 99);
    assert.equal(calls[0].body.message_thread_id, 3);
    assert.equal(calls[0].body.parse_mode, "HTML");
  });
});

test("bot private topic readiness explains disabled mode", () => {
  const readiness = normalizeBotPrivateTopicReadiness({
    id: 123,
    username: "codex_bot",
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  });

  assert.equal(readiness.ok, false);
  assert.equal(readiness.hasTopicsEnabled, false);
  assert.match(formatBotPrivateTopicReadiness(readiness), /private topics: off/);
  assert.match(formatBotPrivateTopicReadiness(readiness), /BotFather/);
  assert.equal(isPrivateTopicModeMissingError(new Error("Bad Request: the chat is not a forum")), true);
});

test("bot profile helpers cover onboarding polish calls", async () => {
  await withMockTelegramFetch(async (calls) => {
    await setMyDefaultAdministratorRights("token", {
      rights: {
        can_manage_topics: true,
        can_pin_messages: true,
        can_delete_messages: true,
      },
    });
    await setChatMenuButton("token", {
      menuButton: { type: "commands" },
    });
    await setMyShortDescription("token", {
      shortDescription: "Remote Codex surface for your Telegram working set.",
    });

    assert.equal(calls[0].url, "https://api.telegram.org/bottoken/setMyDefaultAdministratorRights");
    assert.equal(calls[0].body.rights.can_manage_topics, true);
    assert.equal(calls[1].url, "https://api.telegram.org/bottoken/setChatMenuButton");
    assert.equal(calls[1].body.menu_button.type, "commands");
    assert.equal(calls[2].url, "https://api.telegram.org/bottoken/setMyShortDescription");
  });
});
