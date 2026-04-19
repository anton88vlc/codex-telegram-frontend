export function normalizeBotPrivateTopicReadiness(profile = {}) {
  const hasTopicsEnabled = profile?.has_topics_enabled === true;
  const allowsUsersToCreateTopics = profile?.allows_users_to_create_topics === true;
  const username = String(profile?.username ?? "").trim();

  return {
    ok: hasTopicsEnabled,
    botId: profile?.id ?? null,
    username,
    hasTopicsEnabled,
    allowsUsersToCreateTopics,
    detail: hasTopicsEnabled
      ? "private chat topic mode is enabled"
      : "private chat topic mode is not enabled for this bot",
  };
}

export function isPrivateTopicModeMissingError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /chat is not a forum|forum.*not.*enabled|topics.*not.*enabled|message thread not found/i.test(message);
}

export function privateTopicRecoverySteps({ username = "" } = {}) {
  const botLabel = username ? `@${String(username).replace(/^@+/, "")}` : "your bot";
  return [
    `Open @BotFather and select ${botLabel}.`,
    "Open the BotFather Mini App / bot settings and enable forum/topic mode in private chats.",
    "Run `npm run bot:topics` again; it should show private topics as enabled.",
    "Rerun `npm run onboard:quickstart -- --apply` so Codex Chats can become bot-private topics.",
  ];
}

export function formatBotPrivateTopicReadiness(readiness) {
  const lines = [
    "Bot private topics",
    `bot: ${readiness.username ? `@${readiness.username}` : readiness.botId || "unknown"}`,
    `private topics: ${readiness.hasTopicsEnabled ? "on" : "off"}`,
    `user-created topics: ${readiness.allowsUsersToCreateTopics ? "allowed" : "bot-managed"}`,
  ];

  if (!readiness.hasTopicsEnabled) {
    lines.push("");
    lines.push("Recovery:");
    for (const step of privateTopicRecoverySteps({ username: readiness.username })) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}
