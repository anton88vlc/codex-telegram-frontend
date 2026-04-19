import { normalizeText } from "./message-routing.mjs";

function formatOnOff(value) {
  return value === false ? "off" : "on";
}

function formatList(items, { empty = "none" } = {}) {
  const values = (Array.isArray(items) ? items : []).map((item) => normalizeText(item)).filter(Boolean);
  return values.length ? values.join(", ") : empty;
}

function formatCount(items, { empty = "any" } = {}) {
  return Array.isArray(items) && items.length ? String(items.length) : empty;
}

function formatDurationMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "n/a";
  }
  if (number >= 1000 && number % 1000 === 0) {
    return `${number / 1000}s`;
  }
  return `${number}ms`;
}

function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "n/a";
  }
  if (number >= 1024 * 1024) {
    return `${Math.round(number / (1024 * 1024))}mb`;
  }
  if (number >= 1024) {
    return `${Math.round(number / 1024)}kb`;
  }
  return `${number}b`;
}

function formatTokenSource(config = {}) {
  const source = normalizeText(config.botTokenSource);
  if (source === "env") {
    return `env ${config.botTokenEnv || "CODEX_TELEGRAM_BOT_TOKEN"}`;
  }
  if (source === "keychain") {
    return `Keychain ${config.botTokenKeychainService || "codex-telegram-bridge-bot-token"}`;
  }
  if (source === "config") {
    return "config.local.json botToken";
  }
  return source || "unknown";
}

export function buildSettingsReport({ config = {}, state = {}, bindingKey = null, binding = null } = {}) {
  const bindings = state?.bindings && typeof state.bindings === "object" ? state.bindings : {};
  const mirrors = state?.outboundMirrors && typeof state.outboundMirrors === "object" ? state.outboundMirrors : {};
  const lines = [
    "**Bridge settings**",
    "read-only view; edit local config, not Telegram",
    "",
    `bot: ${config.botUsername ? `@${config.botUsername}` : "unknown"}; token: ${formatTokenSource(config)}`,
    `access: users ${formatCount(config.allowedUserIds)}; chats ${formatCount(config.allowedChatIds)}`,
    `ingress: poll ${formatDurationMs(Number(config.pollTimeoutSeconds) * 1000)}; typing ${formatOnOff(config.sendTyping)}`,
    `transport: native; ingress ${config.nativeIngressTransport || "app-control"}; app-control \`${config.nativeDebugBaseUrl || "n/a"}\`; fallback \`${config.appServerUrl || "n/a"}\``,
    `timeouts: send ${formatDurationMs(config.nativeTimeoutMs)}; wait reply ${formatOnOff(config.nativeWaitForReply)}; native poll ${formatDurationMs(config.nativePollIntervalMs)}; app-control cooldown ${formatDurationMs(config.appControlCooldownMs)}`,
    `app-control: show thread ${formatOnOff(config.appControlShowThread)}`,
    `mirror: ${formatOnOff(config.outboundSyncEnabled)}; phases ${formatList(config.outboundMirrorPhases)}; progress ${config.outboundProgressMode || "updates"}; poll ${formatDurationMs(config.outboundPollIntervalMs)}`,
    `worktree: changed files ${formatOnOff(config.worktreeSummaryEnabled)}; max ${config.worktreeSummaryMaxFiles || 8}`,
    `history import: max messages ${config.historyMaxMessages || 40}; max user prompts ${config.historyMaxUserPrompts || "none"}; phases ${formatList(config.historyAssistantPhases, { empty: "final_answer" })}; heartbeats ${formatOnOff(config.historyIncludeHeartbeats)}`,
    `status bar: ${formatOnOff(config.statusBarEnabled)}; pin ${formatOnOff(config.statusBarPin)}; tail ${formatBytes(config.statusBarTailBytes)}`,
    `sync: default working set ${config.syncDefaultLimit || 3}; project index \`${config.projectIndexPath || "state/bootstrap-result.json"}\``,
    `paths: state \`${config.statePath || "state/state.json"}\`; event log \`${config.eventLogPath || "logs/bridge.events.ndjson"}\`; stderr \`${config.bridgeLogPath || "logs/bridge.stderr.log"}\`; threads DB \`${config.threadsDbPath || "~/.codex/state_5.sqlite"}\``,
    `runtime: bindings ${Object.keys(bindings).length}; mirrors ${Object.keys(mirrors).length}`,
  ];

  if (binding) {
    lines.push(
      `current binding: \`${bindingKey || "unknown"}\`; thread \`${binding.threadId || "missing"}\`; status bar ${
        binding.statusBarMessageId ? `\`${binding.statusBarMessageId}\`` : "none"
      }`,
    );
    if (binding.lastMirroredAt) {
      lines.push(`last mirror: \`${binding.lastMirroredAt}\` (${binding.lastMirroredPhase || "assistant"})`);
    }
  } else {
    lines.push("current binding: none");
  }

  lines.push("", "No secrets are shown here. If this looks wrong, fix `config.local.json` or env/Keychain, then restart the bridge.");
  return lines.join("\n");
}
