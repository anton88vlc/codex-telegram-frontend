import { renderTelegramChunks } from "./telegram-format.mjs";

function cleanText(value) {
  return String(value ?? "").trim();
}

export async function callTelegramApi(token, method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.ok) {
    throw new Error(`telegram ${method} failed: ${result?.description ?? response.status}`);
  }
  return result.result;
}

export async function getUpdates(token, { offset = 0, timeoutSeconds = 30, limit = 50 } = {}) {
  return callTelegramApi(token, "getUpdates", {
    offset,
    timeout: timeoutSeconds,
    limit,
    allowed_updates: ["message"],
  });
}

export async function getMe(token) {
  return callTelegramApi(token, "getMe");
}

export async function sendTyping(token, { chatId, messageThreadId = null }) {
  return callTelegramApi(token, "sendChatAction", {
    chat_id: chatId,
    message_thread_id: messageThreadId ?? undefined,
    action: "typing",
  });
}

function isBenignEditError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /message is not modified/i.test(message);
}

function isFormattingError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /can't parse entities|unsupported start tag|entity bounds are invalid|must be encoded/i.test(message);
}

export async function sendMessage(
  token,
  { chatId, messageThreadId = null, text, replyToMessageId = null, parseMode = null, replyMarkup = null },
) {
  return callTelegramApi(token, "sendMessage", {
    chat_id: chatId,
    message_thread_id: messageThreadId ?? undefined,
    text,
    parse_mode: parseMode || undefined,
    // Telegram clients are annoyingly inconsistent here; send both the legacy
    // and the newer reply shape so the bot message shows up as an actual reply.
    reply_to_message_id: replyToMessageId ?? undefined,
    reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
    allow_sending_without_reply: true,
    disable_web_page_preview: true,
    reply_markup: replyMarkup || undefined,
  });
}

export async function editMessageText(token, { chatId, messageId, text, parseMode = null, replyMarkup = null }) {
  try {
    return await callTelegramApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode || undefined,
      disable_web_page_preview: true,
      reply_markup: replyMarkup || undefined,
    });
  } catch (error) {
    if (isBenignEditError(error)) {
      return null;
    }
    throw error;
  }
}

export async function pinChatMessage(token, { chatId, messageId, disableNotification = true }) {
  return callTelegramApi(token, "pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: disableNotification,
  });
}

export async function createForumTopic(token, { chatId, name }) {
  return callTelegramApi(token, "createForumTopic", {
    chat_id: chatId,
    name,
  });
}

export async function editForumTopic(token, { chatId, messageThreadId, name }) {
  return callTelegramApi(token, "editForumTopic", {
    chat_id: chatId,
    message_thread_id: messageThreadId,
    name: cleanText(name) || undefined,
  });
}

export async function closeForumTopic(token, { chatId, messageThreadId }) {
  return callTelegramApi(token, "closeForumTopic", {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  });
}

export async function reopenForumTopic(token, { chatId, messageThreadId }) {
  return callTelegramApi(token, "reopenForumTopic", {
    chat_id: chatId,
    message_thread_id: messageThreadId,
  });
}

export async function sendMessageDraft(
  token,
  { chatId, messageThreadId = null, draftId, text, parseMode = null, entities = null },
) {
  return callTelegramApi(token, "sendMessageDraft", {
    chat_id: chatId,
    message_thread_id: messageThreadId ?? undefined,
    draft_id: draftId,
    text,
    parse_mode: parseMode || undefined,
    entities: entities || undefined,
  });
}

function normalizeMessageIds(messageIds) {
  return [...new Set(Array.isArray(messageIds) ? messageIds : [])]
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

export async function deleteMessages(token, { chatId, messageIds }) {
  const ids = normalizeMessageIds(messageIds);
  const batches = [];
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    batches.push(
      await callTelegramApi(token, "deleteMessages", {
        chat_id: chatId,
        message_ids: batch,
      }),
    );
  }
  return {
    requested: ids.length,
    batches: batches.length,
    ok: batches.every(Boolean),
  };
}

export async function setMyDefaultAdministratorRights(token, { rights, forChannels = false }) {
  return callTelegramApi(token, "setMyDefaultAdministratorRights", {
    rights,
    for_channels: forChannels,
  });
}

export async function setMyCommands(token, { commands, scope = null, languageCode = null }) {
  return callTelegramApi(token, "setMyCommands", {
    commands,
    scope: scope || undefined,
    language_code: languageCode || undefined,
  });
}

export async function setChatMenuButton(token, { chatId = null, menuButton = null } = {}) {
  return callTelegramApi(token, "setChatMenuButton", {
    chat_id: chatId ?? undefined,
    menu_button: menuButton || undefined,
  });
}

export async function setMyName(token, { name, languageCode = null }) {
  return callTelegramApi(token, "setMyName", {
    name,
    language_code: languageCode || undefined,
  });
}

export async function setMyDescription(token, { description, languageCode = null }) {
  return callTelegramApi(token, "setMyDescription", {
    description,
    language_code: languageCode || undefined,
  });
}

export async function setMyShortDescription(token, { shortDescription, languageCode = null }) {
  return callTelegramApi(token, "setMyShortDescription", {
    short_description: shortDescription,
    language_code: languageCode || undefined,
  });
}

export function splitLongParagraph(paragraph, limit) {
  const chunks = [];
  let remaining = paragraph;
  while (remaining.length > limit) {
    let sliceAt = remaining.lastIndexOf("\n", limit);
    if (sliceAt < Math.floor(limit * 0.5)) sliceAt = remaining.lastIndexOf(" ", limit);
    if (sliceAt < Math.floor(limit * 0.5)) sliceAt = limit;
    chunks.push(remaining.slice(0, sliceAt).trim());
    remaining = remaining.slice(sliceAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function splitTelegramText(text, limit = 3500) {
  const paragraphs = cleanText(text)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!paragraphs.length) return [""];

  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const parts = paragraph.length > limit ? splitLongParagraph(paragraph, limit) : [paragraph];
    for (const part of parts) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length <= limit) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        current = part;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function sendTextChunks(token, target, text, replyToMessageId = null) {
  const chunks = splitTelegramText(text);
  const sent = [];
  for (let index = 0; index < chunks.length; index += 1) {
    sent.push(
      await sendMessage(token, {
        ...target,
        text: chunks[index],
        replyToMessageId: index === 0 ? replyToMessageId : null,
      }),
    );
  }
  return sent;
}

export async function editThenSendTextChunks(token, target, messageId, text) {
  const chunks = splitTelegramText(text);
  if (chunks.length === 0) {
    return [];
  }

  const sent = [];
  const edited = await editMessageText(token, {
    chatId: target.chatId,
    messageId,
    text: chunks[0],
  });
  sent.push(edited);

  for (let index = 1; index < chunks.length; index += 1) {
    sent.push(
      await sendMessage(token, {
        ...target,
        text: chunks[index],
      }),
    );
  }

  return sent;
}

export async function sendRichTextChunks(token, target, text, replyToMessageId = null) {
  const chunks = renderTelegramChunks(text);
  const sent = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    try {
      sent.push(
        await sendMessage(token, {
          ...target,
          text: chunk.html,
          parseMode: "HTML",
          replyToMessageId: index === 0 ? replyToMessageId : null,
        }),
      );
    } catch (error) {
      if (!isFormattingError(error)) {
        throw error;
      }
      sent.push(
        await sendMessage(token, {
          ...target,
          text: chunk.plain,
          replyToMessageId: index === 0 ? replyToMessageId : null,
        }),
      );
    }
  }
  return sent;
}

export async function editThenSendRichTextChunks(token, target, messageId, text) {
  const chunks = renderTelegramChunks(text);
  if (chunks.length === 0) {
    return [];
  }

  const sent = [];
  const first = chunks[0];
  try {
    const edited = await editMessageText(token, {
      chatId: target.chatId,
      messageId,
      text: first.html,
      parseMode: "HTML",
    });
    if (edited) {
      sent.push(edited);
    }
  } catch (error) {
    if (!isFormattingError(error)) {
      throw error;
    }
    const edited = await editMessageText(token, {
      chatId: target.chatId,
      messageId,
      text: first.plain,
    });
    if (edited) {
      sent.push(edited);
    }
  }

  for (let index = 1; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    try {
      sent.push(
        await sendMessage(token, {
          ...target,
          text: chunk.html,
          parseMode: "HTML",
        }),
      );
    } catch (error) {
      if (!isFormattingError(error)) {
        throw error;
      }
      sent.push(
        await sendMessage(token, {
          ...target,
          text: chunk.plain,
        }),
      );
    }
  }

  return sent;
}
