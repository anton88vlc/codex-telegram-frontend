import fs from "node:fs/promises";

import { normalizeText } from "./message-routing.mjs";
import { renderTelegramChunks } from "./telegram-format.mjs";
import { sendMessage } from "./telegram.mjs";
import { parseThreadMirrorChunk } from "./thread-rollout.mjs";

export const DEFAULT_HISTORY_BACKFILL_MAX_MESSAGES = 10;
export const DEFAULT_HISTORY_BACKFILL_ASSISTANT_PHASES = ["final_answer"];
export const DEFAULT_HISTORY_BACKFILL_USER_LABEL = "User";
export const DEFAULT_HISTORY_BACKFILL_ASSISTANT_LABEL = "Codex";

export function limitHistoryMessages(
  messages,
  {
    maxHistoryMessages = DEFAULT_HISTORY_BACKFILL_MAX_MESSAGES,
    maxUserPrompts = null,
  } = {},
) {
  let limited = Array.isArray(messages) ? [...messages] : [];
  const promptLimit = Number(maxUserPrompts);
  if (Number.isFinite(promptLimit) && promptLimit > 0) {
    const tail = [];
    let userPrompts = 0;
    for (let index = limited.length - 1; index >= 0; index -= 1) {
      const item = limited[index];
      if (item?.role === "user") {
        if (userPrompts >= promptLimit) {
          break;
        }
        userPrompts += 1;
      }
      tail.push(item);
    }
    limited = tail.reverse();
  }

  const messageLimit = Number(maxHistoryMessages);
  if (Number.isFinite(messageLimit) && messageLimit > 0) {
    limited = limited.slice(-messageLimit);
    const firstUserIndex = limited.findIndex((item) => item?.role === "user");
    if (firstUserIndex > 0) {
      limited = limited.slice(firstUserIndex);
    }
  }
  return limited;
}

export async function loadCleanThreadHistoryFromRollout(
  rolloutPath,
  {
    assistantPhases = DEFAULT_HISTORY_BACKFILL_ASSISTANT_PHASES,
    maxHistoryMessages = DEFAULT_HISTORY_BACKFILL_MAX_MESSAGES,
    maxUserPrompts = null,
  } = {},
) {
  const normalizedPath = normalizeText(rolloutPath);
  if (!normalizedPath) {
    return [];
  }
  const raw = await fs.readFile(normalizedPath, "utf8");
  const { messages } = parseThreadMirrorChunk(`${raw}\n`, {
    phases: assistantPhases,
  });
  return limitHistoryMessages(
    messages.filter((item) => item?.role === "user" || item?.role === "assistant"),
    {
      maxHistoryMessages,
      maxUserPrompts,
    },
  );
}

export function formatLabeledHistoryText(
  item,
  {
    userLabel = DEFAULT_HISTORY_BACKFILL_USER_LABEL,
    assistantLabel = DEFAULT_HISTORY_BACKFILL_ASSISTANT_LABEL,
  } = {},
) {
  const label = item?.role === "user" ? userLabel : assistantLabel;
  return `**${label}:**\n${normalizeText(item?.text)}`.trim();
}

export function buildHistoryBackfillTransmissions(
  messages,
  {
    userLabel = DEFAULT_HISTORY_BACKFILL_USER_LABEL,
    assistantLabel = DEFAULT_HISTORY_BACKFILL_ASSISTANT_LABEL,
  } = {},
) {
  const transmissions = [];
  for (const item of Array.isArray(messages) ? messages : []) {
    const text = formatLabeledHistoryText(item, { userLabel, assistantLabel });
    for (const chunk of renderTelegramChunks(text)) {
      const plain = normalizeText(chunk.plain);
      const html = normalizeText(chunk.html);
      if (!plain && !html) {
        continue;
      }
      transmissions.push({
        role: item.role,
        text: plain || text,
        html: html || null,
      });
    }
  }
  return transmissions;
}

export async function sendHistoryBackfill({
  config,
  thread,
  chatId,
  messageThreadId,
  maxHistoryMessages = DEFAULT_HISTORY_BACKFILL_MAX_MESSAGES,
  maxUserPrompts = null,
  assistantPhases = DEFAULT_HISTORY_BACKFILL_ASSISTANT_PHASES,
  userLabel = DEFAULT_HISTORY_BACKFILL_USER_LABEL,
  assistantLabel = DEFAULT_HISTORY_BACKFILL_ASSISTANT_LABEL,
  sendMessageFn = sendMessage,
} = {}) {
  const normalizedChatId = normalizeText(chatId);
  const topicId = Number(messageThreadId);
  const rolloutPath = normalizeText(thread?.rollout_path);
  if (!config?.botToken || !normalizedChatId || !Number.isInteger(topicId) || !rolloutPath) {
    return {
      status: "skipped",
      reason: "missing backfill target",
      sent: 0,
      messages: 0,
    };
  }

  const messages = await loadCleanThreadHistoryFromRollout(rolloutPath, {
    assistantPhases,
    maxHistoryMessages,
    maxUserPrompts,
  });
  if (!messages.length) {
    return {
      status: "skipped",
      reason: "no clean history messages found",
      sent: 0,
      messages: 0,
      rolloutPath,
    };
  }

  const transmissions = buildHistoryBackfillTransmissions(messages, {
    userLabel,
    assistantLabel,
  });
  let sent = 0;
  for (const transmission of transmissions) {
    await sendMessageFn(config.botToken, {
      chatId: normalizedChatId,
      messageThreadId: topicId,
      text: transmission.html || transmission.text,
      parseMode: transmission.html ? "HTML" : null,
    });
    sent += 1;
  }
  return {
    status: "ok",
    sent,
    messages: messages.length,
    userMessages: messages.filter((item) => item.role === "user").length,
    assistantMessages: messages.filter((item) => item.role === "assistant").length,
    transmissions: transmissions.length,
    rolloutPath,
  };
}
