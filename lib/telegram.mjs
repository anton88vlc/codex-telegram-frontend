const TELEGRAM_CHUNK_LIMIT = 3500;

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

export async function sendTyping(token, { chatId, messageThreadId = null }) {
  return callTelegramApi(token, "sendChatAction", {
    chat_id: chatId,
    message_thread_id: messageThreadId ?? undefined,
    action: "typing",
  });
}

export async function sendMessage(token, { chatId, messageThreadId = null, text, replyToMessageId = null }) {
  return callTelegramApi(token, "sendMessage", {
    chat_id: chatId,
    message_thread_id: messageThreadId ?? undefined,
    text,
    // Telegram clients are annoyingly inconsistent here; send both the legacy
    // and the newer reply shape so the bot message shows up as an actual reply.
    reply_to_message_id: replyToMessageId ?? undefined,
    reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
    allow_sending_without_reply: true,
    disable_web_page_preview: true,
  });
}

export async function editMessageText(token, { chatId, messageId, text }) {
  return callTelegramApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  });
}

export async function createForumTopic(token, { chatId, name }) {
  return callTelegramApi(token, "createForumTopic", {
    chat_id: chatId,
    name,
  });
}

function splitLongParagraph(paragraph, limit) {
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

export function splitTelegramText(text, limit = TELEGRAM_CHUNK_LIMIT) {
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
