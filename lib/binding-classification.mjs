export const PRIVATE_TOPIC_AUTO_CREATE_CREATOR = "private-topic-auto-create";
export const CODEX_CHATS_SURFACE = "codex-chats";

function cleanText(value) {
  return String(value ?? "").trim();
}

export function isPrivateTopicAutoCreatedBinding(binding) {
  return (
    cleanText(binding?.createdBy) === PRIVATE_TOPIC_AUTO_CREATE_CREATOR &&
    cleanText(binding?.surface) === CODEX_CHATS_SURFACE &&
    cleanText(binding?.threadId) &&
    cleanText(binding?.chatId) &&
    binding?.messageThreadId != null
  );
}

export function isThreadDbOptionalBinding(binding) {
  return Boolean(isPrivateTopicAutoCreatedBinding(binding));
}
