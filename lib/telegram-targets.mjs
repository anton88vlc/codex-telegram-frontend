import { normalizeText } from "./message-routing.mjs";
import { sendRichTextChunks, sendTextChunks } from "./telegram.mjs";

export function buildTargetFromMessage(message) {
  return {
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id ?? null,
  };
}

export function buildTargetFromBinding(binding) {
  return {
    chatId: binding.chatId,
    messageThreadId: binding.messageThreadId ?? null,
  };
}

export function formatTelegramSenderName(message) {
  const firstName = normalizeText(message?.from?.first_name);
  const lastName = normalizeText(message?.from?.last_name);
  const fullName = normalizeText([firstName, lastName].filter(Boolean).join(" "));
  if (fullName) {
    return fullName;
  }
  const username = normalizeText(message?.from?.username).replace(/^@+/, "");
  return username ? `@${username}` : "Telegram user";
}

export function truncatePreview(text, limit = 1200) {
  const normalized = normalizeText(text).replace(/\r\n/g, "\n");
  if (normalized.length <= limit) {
    return normalized;
  }
  const suffix = "...";
  if (limit <= suffix.length) {
    return suffix.slice(0, Math.max(0, limit));
  }
  return `${normalized.slice(0, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}`;
}

export function quoteMarkdownBlock(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function formatUnboundGroupFallbackBubble({ message, promptText, attachmentRefs = [], voiceRefs = [] }) {
  const sender = formatTelegramSenderName(message);
  const source = message?.message_thread_id != null ? "General" : "All";
  const lines = [`**${sender} via ${source}**`];
  const preview = truncatePreview(promptText);
  if (preview) {
    lines.push("", quoteMarkdownBlock(preview));
  }
  if (attachmentRefs.length) {
    lines.push("", `_${attachmentRefs.length} attachment${attachmentRefs.length === 1 ? "" : "s"} moved._`);
  }
  if (voiceRefs.length) {
    lines.push("", `_${voiceRefs.length === 1 ? "voice" : `${voiceRefs.length} voices`} moved._`);
  }
  if (!preview && !attachmentRefs.length && !voiceRefs.length) {
    lines.push("", "_Moved from an unbound group surface._");
  }
  return lines.join("\n");
}

export async function reply(token, message, text) {
  return sendRichTextChunks(token, buildTargetFromMessage(message), text, message.message_id);
}

export async function replyPlain(token, message, text) {
  return sendTextChunks(token, buildTargetFromMessage(message), text, message.message_id);
}

export function isTopicMessage(message) {
  return message.message_thread_id != null && (message.chat.type === "group" || message.chat.type === "supergroup");
}

export function isPrivateTopicMessage(message) {
  return message?.message_thread_id != null && message?.chat?.type === "private";
}
