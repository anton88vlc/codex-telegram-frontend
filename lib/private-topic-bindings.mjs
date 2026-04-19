import { createNativeChat } from "./codex-native.mjs";
import {
  CODEX_CHATS_SURFACE,
  PRIVATE_TOPIC_AUTO_CREATE_CREATOR,
} from "./binding-classification.mjs";
import { logBridgeEvent } from "./bridge-events.mjs";
import { normalizeText } from "./message-routing.mjs";
import { sanitizeTopicTitle } from "./project-sync.mjs";
import { makeBindingKey, removeOutboundMirror, setBinding } from "./state.mjs";
import { editForumTopic } from "./telegram.mjs";
import { isPrivateTopicMessage } from "./telegram-targets.mjs";

const GENERIC_PRIVATE_TOPIC_TITLES = new Set([
  "new thread",
  "new topic",
  "new chat",
  "новая тема",
  "новый тред",
  "nuevo tema",
]);

export function getPrivateTopicTitleStore(state) {
  if (!state.privateTopicTitles || typeof state.privateTopicTitles !== "object") {
    state.privateTopicTitles = {};
  }
  return state.privateTopicTitles;
}

export function isGenericPrivateTopicTitle(title) {
  const normalized = normalizeText(title).toLowerCase();
  return GENERIC_PRIVATE_TOPIC_TITLES.has(normalized);
}

export function rememberPrivateTopicTitle(state, message) {
  if (!isPrivateTopicMessage(message)) {
    return false;
  }
  const topicTitle = normalizeText(message?.forum_topic_created?.name);
  if (!topicTitle) {
    return false;
  }
  const bindingKey = makeBindingKey({
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id,
  });
  getPrivateTopicTitleStore(state)[bindingKey] = {
    title: sanitizeTopicTitle(topicTitle, "New Codex Chat"),
    updatedAt: new Date().toISOString(),
    messageId: message.message_id ?? null,
  };
  return true;
}

export function makePrivateTopicChatTitle({ state, bindingKey, message }) {
  const remembered = normalizeText(getPrivateTopicTitleStore(state)?.[bindingKey]?.title);
  if (remembered && !isGenericPrivateTopicTitle(remembered)) {
    return sanitizeTopicTitle(remembered, "New Codex Chat");
  }

  const serviceTitle = normalizeText(message?.reply_to_message?.forum_topic_created?.name);
  if (serviceTitle && !isGenericPrivateTopicTitle(serviceTitle)) {
    return sanitizeTopicTitle(serviceTitle, "New Codex Chat");
  }

  return "New Codex Chat";
}

export function shouldAutoCreatePrivateTopicBinding({ config, message, binding }) {
  return !binding && config.privateTopicAutoCreateChats !== false && isPrivateTopicMessage(message);
}

export async function maybeRenamePrivateTopic({ config, message, title }) {
  if (!isPrivateTopicMessage(message) || !normalizeText(title)) {
    return;
  }
  try {
    await editForumTopic(config.botToken, {
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      name: title,
    });
  } catch (error) {
    logBridgeEvent("private_topic_rename_error", {
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id ?? null,
      title,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function autoCreatePrivateTopicBinding({ config, state, message, bindingKey, promptText, sendPrompt = null }) {
  if (config.privateTopicAutoCreateChats === false || !isPrivateTopicMessage(message)) {
    return null;
  }

  const title = makePrivateTopicChatTitle({ state, bindingKey, message, promptText });
  const result = await createNativeChat({
    helperPath: config.nativeChatStartHelperPath,
    title,
    cwd: config.nativeChatStartCwd,
    prompt: sendPrompt,
    timeoutMs: config.nativeChatStartTimeoutMs,
    appServerUrl: config.appServerUrl,
  });
  const threadId = normalizeText(result.threadId || result.thread?.id);
  if (!threadId) {
    throw new Error("Codex app-server created a chat without returning a thread id");
  }

  removeOutboundMirror(state, bindingKey);
  const now = new Date().toISOString();
  const binding = setBinding(state, bindingKey, {
    threadId,
    transport: "native",
    chatId: String(message.chat.id),
    messageThreadId: message.message_thread_id ?? null,
    chatTitle: normalizeText(message.chat.title || message.chat.username || message.chat.first_name || "Codex Chats"),
    threadTitle: title,
    createdAt: now,
    updatedAt: now,
    createdBy: PRIVATE_TOPIC_AUTO_CREATE_CREATOR,
    surface: CODEX_CHATS_SURFACE,
    lastTransportPath: result.transportPath || "app-server-thread-start",
    lastNativeMode: result.mode || null,
  });
  await maybeRenamePrivateTopic({ config, message, title });

  logBridgeEvent("private_topic_chat_created", {
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id ?? null,
    messageId: message.message_id ?? null,
    bindingKey,
    threadId,
    title,
    cwd: config.nativeChatStartCwd,
    sentInitialPrompt: Boolean(sendPrompt),
  });

  return binding;
}
