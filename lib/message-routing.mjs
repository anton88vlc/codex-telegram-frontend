export function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeBotUsername(botUsername) {
  return normalizeText(botUsername).replace(/^@+/, "").toLowerCase();
}

export function stripCommandTarget(text) {
  const [head, ...rest] = normalizeText(text).split(/\s+/);
  const cleanedHead = head.replace(/@[^ ]+$/, "");
  return [cleanedHead, ...rest].join(" ").trim();
}

export function parseCommand(text) {
  const stripped = stripCommandTarget(text);
  if (!stripped.startsWith("/")) {
    return null;
  }
  const [command, ...args] = stripped.split(/\s+/);
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
