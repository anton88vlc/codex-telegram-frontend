export function normalizeText(value) {
  return String(value ?? "").trim();
}

export const DEFAULT_UNBOUND_GROUP_FALLBACK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeBotUsername(botUsername) {
  return normalizeText(botUsername).replace(/^@+/, "").toLowerCase();
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isGroupChat(message) {
  return message?.chat?.type === "group" || message?.chat?.type === "supergroup";
}

function latestProgressItemMs(binding) {
  const items = Array.isArray(binding?.currentTurn?.progressItems) ? binding.currentTurn.progressItems : [];
  return items.reduce((latest, item) => Math.max(latest, timestampMs(item?.timestamp)), 0);
}

export function getTopicBindingActivityMs(binding) {
  if (!binding || typeof binding !== "object") {
    return 0;
  }
  return Math.max(
    latestProgressItemMs(binding),
    timestampMs(binding.currentTurn?.startedAt),
    timestampMs(binding.currentTurn?.planUpdatedAt),
    timestampMs(binding.lastMirroredAt),
    timestampMs(binding.updatedAt),
    timestampMs(binding.createdAt),
  );
}

export function findFallbackTopicBindingForUnboundGroupMessage(
  state,
  message,
  { nowMs = Date.now(), maxAgeMs = DEFAULT_UNBOUND_GROUP_FALLBACK_MAX_AGE_MS } = {},
) {
  if (!state?.bindings || !isGroupChat(message)) {
    return null;
  }

  const chatId = String(message.chat.id);
  const currentThreadId = message.message_thread_id == null ? null : Number(message.message_thread_id);
  const normalizedMaxAgeMs = Number(maxAgeMs);
  const candidates = [];

  for (const [bindingKey, binding] of Object.entries(state.bindings)) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    if (String(binding.chatId) !== chatId) {
      continue;
    }
    if (binding.messageThreadId == null) {
      continue;
    }
    if (currentThreadId != null && Number(binding.messageThreadId) === currentThreadId) {
      continue;
    }
    if (!normalizeText(binding.threadId) || binding.detached || binding.parked) {
      continue;
    }

    const activityMs = getTopicBindingActivityMs(binding);
    if (
      Number.isFinite(normalizedMaxAgeMs) &&
      normalizedMaxAgeMs > 0 &&
      activityMs > 0 &&
      Number(nowMs) - activityMs > normalizedMaxAgeMs
    ) {
      continue;
    }

    candidates.push({ bindingKey, binding, activityMs });
  }

  candidates.sort((left, right) => {
    const activityDelta = right.activityMs - left.activityMs;
    if (activityDelta !== 0) {
      return activityDelta;
    }
    return Number(right.binding.messageThreadId) - Number(left.binding.messageThreadId);
  });

  return candidates[0] || null;
}

export function stripCommandTarget(text) {
  const [head, ...rest] = normalizeText(text).split(/\s+/);
  const cleanedHead = head.replace(/@[^ ]+$/, "");
  return [cleanedHead, ...rest].join(" ").trim();
}

const COMMAND_ALIASES = new Map([
  ["/attach_latest", { command: "/attach-latest" }],
  ["/project_status", { command: "/project-status" }],
  ["/sync_project", { command: "/sync-project" }],
  ["/mode_native", { command: "/mode", prependArgs: ["native"] }],
]);

export function parseCommand(text) {
  const stripped = stripCommandTarget(text);
  if (!stripped.startsWith("/")) {
    return null;
  }
  const [command, ...args] = stripped.split(/\s+/);
  const alias = COMMAND_ALIASES.get(command.toLowerCase());
  if (alias) {
    return {
      command: alias.command,
      args: [...(alias.prependArgs ?? []), ...args],
    };
  }
  return {
    command: command.toLowerCase(),
    args,
  };
}

export function stripLeadingBotMention(text, botUsername = null) {
  const normalizedBotUsername = normalizeBotUsername(botUsername);
  if (!normalizedBotUsername) {
    return normalizeText(text);
  }

  const trimmed = normalizeText(text);
  if (!trimmed) {
    return "";
  }

  const mentionPattern = new RegExp(`^@${normalizedBotUsername}(?:\\b|\\s|[:,.-])`, "i");
  if (!mentionPattern.test(trimmed)) {
    return trimmed;
  }

  return trimmed.replace(mentionPattern, "").trim();
}

export function normalizeInboundPrompt(text, { botUsername = null } = {}) {
  const withoutMention = stripLeadingBotMention(text, botUsername);
  return normalizeText(withoutMention);
}
