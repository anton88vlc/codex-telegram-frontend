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
