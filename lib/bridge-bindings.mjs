import { normalizeText } from "./message-routing.mjs";
import { sanitizeTopicTitle } from "./project-sync.mjs";

export function formatThreadBullet(thread) {
  return `- ${sanitizeTopicTitle(thread.title, thread.id)} (${thread.id})`;
}

export function buildBindingPayload({ message, thread, chatTitle }) {
  return {
    threadId: String(thread.id),
    transport: "native",
    chatId: String(message.chat.id),
    messageThreadId: message.message_thread_id ?? null,
    chatTitle: normalizeText(chatTitle || message.chat.title || message.chat.username || message.chat.first_name || ""),
    threadTitle: sanitizeTopicTitle(thread.title, thread.id),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function isAuthorized(config, message) {
  const userId = Number(message?.from?.id);
  const chatId = String(message?.chat?.id);
  if (config.allowedUserIds.length && !config.allowedUserIds.includes(userId)) {
    return false;
  }
  if (config.allowedChatIds.length && !config.allowedChatIds.includes(chatId)) {
    return false;
  }
  return true;
}
