import { logBridgeEvent } from "./bridge-events.mjs";
import { findFallbackTopicBindingForUnboundGroupMessage } from "./message-routing.mjs";
import {
  buildTargetFromBinding,
  formatUnboundGroupFallbackBubble,
} from "./telegram-targets.mjs";
import { sendRichTextChunks } from "./telegram.mjs";

export async function rerouteUnboundGroupMessageToFallbackTopic({
  config,
  state,
  message,
  promptText,
  attachmentRefs = [],
  voiceRefs = [],
  buildTargetFromBindingFn = buildTargetFromBinding,
  findFallbackTopicBindingForUnboundGroupMessageFn = findFallbackTopicBindingForUnboundGroupMessage,
  formatUnboundGroupFallbackBubbleFn = formatUnboundGroupFallbackBubble,
  logEventFn = logBridgeEvent,
  nowFn = () => new Date().toISOString(),
  rememberOutboundFn = () => {},
  sendRichTextChunksFn = sendRichTextChunks,
} = {}) {
  if (config.unboundGroupFallbackEnabled === false) {
    return null;
  }
  const fallback = findFallbackTopicBindingForUnboundGroupMessageFn(state, message, {
    maxAgeMs: config.unboundGroupFallbackMaxAgeMs,
  });
  if (!fallback?.binding) {
    return null;
  }

  const sent = await sendRichTextChunksFn(
    config.botToken,
    buildTargetFromBindingFn(fallback.binding),
    formatUnboundGroupFallbackBubbleFn({
      message,
      promptText,
      attachmentRefs,
      voiceRefs,
    }),
  );
  const routedMessageId = sent[0]?.message_id;
  const routedMessage = {
    ...message,
    message_id: Number.isInteger(routedMessageId) ? routedMessageId : message.message_id,
    message_thread_id: fallback.binding.messageThreadId ?? message.message_thread_id ?? null,
    routedFromMessage: {
      chatId: String(message.chat.id),
      messageThreadId: message.message_thread_id ?? null,
      messageId: message.message_id ?? null,
    },
  };
  fallback.binding.lastUnboundFallbackAt = nowFn();
  fallback.binding.lastUnboundFallbackFrom = routedMessage.routedFromMessage;
  fallback.binding.updatedAt = fallback.binding.lastUnboundFallbackAt;
  state.bindings[fallback.bindingKey] = fallback.binding;
  rememberOutboundFn(fallback.binding, sent);
  logEventFn("unbound_group_message_rerouted", {
    chatId: message.chat.id,
    fromMessageThreadId: message.message_thread_id ?? null,
    fromMessageId: message.message_id ?? null,
    toMessageThreadId: fallback.binding.messageThreadId ?? null,
    toMessageId: Number.isInteger(routedMessageId) ? routedMessageId : null,
    bindingKey: fallback.bindingKey,
    threadId: fallback.binding.threadId,
    activityMs: fallback.activityMs,
  });
  return {
    bindingKey: fallback.bindingKey,
    binding: fallback.binding,
    message: routedMessage,
  };
}
