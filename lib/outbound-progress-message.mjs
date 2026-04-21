import { normalizeText } from "./message-routing.mjs";
import { isPlanMirrorMessage } from "./outbound-mirror-messages.mjs";
import { appendOutboundProgressItem, formatOutboundProgressMirrorText } from "./outbound-progress.mjs";
import { editThenSendRichTextChunks, sendRichTextChunks } from "./telegram.mjs";

export async function upsertOutboundProgressMessage({
  config,
  binding,
  target,
  replyToMessageId,
  message,
  changedFilesText = null,
  editThenSendRichTextChunksFn = editThenSendRichTextChunks,
  sendRichTextChunksFn = sendRichTextChunks,
}) {
  const baseTurn = {
    source: "codex",
    startedAt: message.timestamp || binding.currentTurn?.startedAt || new Date().toISOString(),
    promptPreview: binding.currentTurn?.promptPreview || "Codex progress",
    ...(binding.currentTurn || {}),
  };
  binding.currentTurn = isPlanMirrorMessage(message)
    ? {
        ...baseTurn,
        planText: normalizeText(message.text),
        planUpdatedAt: message.timestamp || new Date().toISOString(),
      }
    : {
        ...baseTurn,
        progressItems: appendOutboundProgressItem(binding.currentTurn, message),
      };
  if (changedFilesText) {
    binding.currentTurn.changedFilesText = changedFilesText;
  } else {
    delete binding.currentTurn.changedFilesText;
  }
  const text = formatOutboundProgressMirrorText({
    message,
    currentTurn: binding.currentTurn,
    config,
  });
  if (!text) {
    return [];
  }
  const messageId = binding.currentTurn?.codexProgressMessageId;
  if (Number.isInteger(messageId)) {
    const edited = await editThenSendRichTextChunksFn(config.botToken, target, messageId, text);
    return edited.length ? edited : [{ message_id: messageId }];
  }
  const sent = await sendRichTextChunksFn(config.botToken, target, text, replyToMessageId);
  const progressMessageId = sent[0]?.message_id;
  if (Number.isInteger(progressMessageId)) {
    binding.currentTurn = {
      ...(binding.currentTurn || {}),
      codexProgressMessageId: progressMessageId,
    };
  }
  return sent;
}

export async function completeOutboundProgressMessage({
  config,
  binding,
  target,
  changedFilesText = null,
  editThenSendRichTextChunksFn = editThenSendRichTextChunks,
}) {
  const messageId = binding.currentTurn?.codexProgressMessageId;
  if (!Number.isInteger(messageId)) {
    return [];
  }
  if (changedFilesText) {
    binding.currentTurn.changedFilesText = changedFilesText;
  } else if (binding.currentTurn) {
    delete binding.currentTurn.changedFilesText;
  }
  const text = formatOutboundProgressMirrorText({
    currentTurn: binding.currentTurn,
    config,
    completed: true,
  });
  const edited = await editThenSendRichTextChunksFn(
    config.botToken,
    target,
    messageId,
    text || "**Done**",
  );
  return edited.length ? edited : [{ message_id: messageId }];
}
