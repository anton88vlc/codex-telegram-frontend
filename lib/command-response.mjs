import { logBridgeEvent } from "./bridge-events.mjs";
import { normalizeText } from "./message-routing.mjs";
import { sendRichTextChunks } from "./telegram.mjs";
import { isTopicMessage, reply } from "./telegram-targets.mjs";

export function buildOpsDmIntro(message) {
  const chatTitle = normalizeText(message.chat.title || message.chat.username || message.chat.first_name || "chat");
  const topic = message.message_thread_id != null ? `, topic ${message.message_thread_id}` : "";
  return `**Ops details** from **${chatTitle}**${topic}\n\n`;
}

export async function sendCommandResponse({
  config,
  message,
  text,
  quietInTopic = false,
  topicSummary = null,
  sendRichTextChunksFn = sendRichTextChunks,
  replyFn = reply,
  logEventFn = logBridgeEvent,
}) {
  if (quietInTopic && isTopicMessage(message) && Number.isInteger(message.from?.id)) {
    try {
      await sendRichTextChunksFn(
        config.botToken,
        {
          chatId: message.from.id,
          messageThreadId: null,
        },
        `${buildOpsDmIntro(message)}${text}`,
      );
      return replyFn(
        config.botToken,
        message,
        topicSummary || "Done. I sent the details to your direct chat with the bot to keep this topic clean.",
      );
    } catch (error) {
      logEventFn("ops_direct_chat_fallback", {
        chatId: message.chat.id,
        messageId: message.message_id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return replyFn(config.botToken, message, text);
}
