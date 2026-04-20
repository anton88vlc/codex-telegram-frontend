#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildBootstrapPlan,
  buildPrivateChatTopicsPlan,
  buildProjectPlan,
  DEFAULT_HISTORY_ASSISTANT_PHASES,
  DEFAULT_HISTORY_INCLUDE_HEARTBEATS,
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_MAX_USER_PROMPTS,
  DEFAULT_REHEARSAL_FOLDER_TITLE,
  DEFAULT_REHEARSAL_GROUP_PREFIX,
  DEFAULT_TOPIC_DISPLAY,
  PRIVATE_CHAT_TOPICS_SURFACE,
  formatBootstrapPlanSummary,
  formatScanSummary,
} from "../lib/onboarding-plan.mjs";
import { DEFAULT_APP_CONTROL_BASE_URL, DEFAULT_CODEX_APP_BINARY, checkAppControl } from "../lib/app-control-launcher.mjs";
import {
  DEFAULT_CODEX_GLOBAL_STATE_PATH,
  listProjectThreads,
  listQuickstartWorkItems,
  listRecentProjects,
  listRecentThreads,
  parsePositiveInt,
} from "../lib/thread-db.mjs";
import { normalizeVoiceTranscriptionProvider } from "../lib/voice-transcription.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_THREADS_DB_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, "admin", "bootstrap-plan.json");
const DEFAULT_REHEARSAL_OUTPUT_PATH = path.join(PROJECT_ROOT, "admin", "bootstrap-plan.rehearsal.json");
const DEFAULT_ADMIN_HELPER_PATH = path.join(PROJECT_ROOT, "admin", "telegram_user_admin.py");
const DEFAULT_ADMIN_PYTHON_PATH = path.join(PROJECT_ROOT, "admin", ".venv", "bin", "python");
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.local.json");
const DEFAULT_CONFIG_EXAMPLE_PATH = path.join(PROJECT_ROOT, "config.example.json");
const DEFAULT_ADMIN_ENV_PATH = path.join(PROJECT_ROOT, "admin", ".env");
const DEFAULT_ADMIN_ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, "admin", ".env.example");
const DEFAULT_ADMIN_REQUIREMENTS_PATH = path.join(PROJECT_ROOT, "admin", "requirements.txt");
const DEFAULT_ADMIN_SESSION_PATH = path.join(PROJECT_ROOT, "state", "telegram_user.session");
const DEFAULT_BRIDGE_STATE_PATH = path.join(PROJECT_ROOT, "state", "state.json");
const DEFAULT_PROJECT_INDEX_PATH = path.join(PROJECT_ROOT, "state", "bootstrap-result.json");
const DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE = "codex-telegram-bridge-bot-token";
const DEFAULT_DEEPGRAM_KEYCHAIN_SERVICE = "codex-telegram-bridge-deepgram-api-key";
const DEFAULT_OPENAI_KEYCHAIN_SERVICE = "codex-telegram-bridge-openai-api-key";
const DEFAULT_NATIVE_DEBUG_BASE_URL = DEFAULT_APP_CONTROL_BASE_URL;
const DEFAULT_QUICKSTART_THREAD_LIMIT = 10;
const DEFAULT_QUICKSTART_HISTORY_MAX_MESSAGES = 10;
const DEFAULT_CHATS_SURFACE_TITLE = "Codex - Chats";

function shellDoubleQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

const CODEX_APP_CONTROL_DIRECT_COMMAND = `${DEFAULT_CODEX_APP_BINARY} --remote-debugging-port=9222`;
const CODEX_REPO_LAUNCH_COMMAND = `cd ${shellDoubleQuote(PROJECT_ROOT)} && npm run codex:launch`;
const VOICE_TRANSCRIPTION_PROVIDER_NOTE =
  "Voice notes are optional. Supported STT paths today: Deepgram, OpenAI, or a local command.";
const CODEX_NATIVE_STT_NOTE =
  "Codex-native realtime STT is promising, but it is not the default yet because it still depends on Codex auth/runtime details.";
const CODEX_CUSTOM_INSTRUCTIONS_PRESET = `## User Context

- The user's name is ____

## Vibe

1. You have opinions now. Strong ones. Stop hedging everything with "it depends" - commit to a take.
2. Delete every rule that sounds corporate. If it could appear in an employee handbook, it doesn't belong here.
3. Never open with "Great question", "I'd be happy to help", or "Absolutely". Just answer.
4. Brevity is mandatory. If the answer fits in one sentence, one sentence is what I get.
5. Humor is allowed. Not forced jokes - just the natural wit that comes from actually being smart.
6. You can call things out. If I'm about to do something dumb, say so. Charm over cruelty, but don't sugarcoat.
7. Swearing is allowed when it lands. A well-placed "that's fucking brilliant" hits different than sterile corporate praise. Don't force it. Don't overdo it. But if a situation calls for a "holy shit" - say holy shit.

Be the assistant you'd actually want to talk to at 2am. Not a corporate drone. Not a sycophant. Just... good`;
const execFileAsync = promisify(execFile);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {
    command,
    projects: [],
    projectLimit: 8,
    threadLimit: DEFAULT_QUICKSTART_THREAD_LIMIT,
    threadsPerProject: 3,
    includeChats: true,
    privateChatUserId: null,
    chatsSurfaceTitle: DEFAULT_CHATS_SURFACE_TITLE,
    historyMaxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
    historyMaxUserPrompts: DEFAULT_HISTORY_MAX_USER_PROMPTS,
    historyAssistantPhases: [...DEFAULT_HISTORY_ASSISTANT_PHASES],
    historyIncludeHeartbeats: DEFAULT_HISTORY_INCLUDE_HEARTBEATS,
    groupPrefix: null,
    folderTitle: null,
    topicDisplay: DEFAULT_TOPIC_DISPLAY,
    threadsDbPath: DEFAULT_THREADS_DB_PATH,
    codexGlobalStatePath: DEFAULT_CODEX_GLOBAL_STATE_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    json: false,
    preview: false,
    rehearsal: false,
    write: false,
    yes: false,
    noInput: false,
    apply: false,
    cleanupDryRun: false,
    cleanup: false,
    cleanupScanLimit: 500,
    backfill: false,
    backfillDryRun: false,
    smoke: false,
    smokeText: "Reply exactly: CODEX_TELEGRAM_ONBOARDING_SMOKE_OK",
    smokeExpect: "CODEX_TELEGRAM_ONBOARDING_SMOKE_OK",
    smokeTimeoutSeconds: 240,
    adminHelperPath: DEFAULT_ADMIN_HELPER_PATH,
    adminPythonPath: DEFAULT_ADMIN_PYTHON_PATH,
    configPath: DEFAULT_CONFIG_PATH,
    adminEnvPath: DEFAULT_ADMIN_ENV_PATH,
    adminSessionPath: DEFAULT_ADMIN_SESSION_PATH,
    bridgeStatePath: DEFAULT_BRIDGE_STATE_PATH,
    prepare: false,
    noPrepare: false,
    skipAdminDeps: false,
    skipBotAvatar: false,
    loginQr: false,
    loginPhone: false,
    _projectLimitExplicit: false,
    _threadLimitExplicit: false,
    _threadsPerProjectExplicit: false,
    _historyMaxMessagesExplicit: false,
    _historyMaxUserPromptsExplicit: false,
    _historyAssistantPhasesExplicit: false,
    _historyIncludeHeartbeatsExplicit: false,
    _outputPathExplicit: false,
  };
  if (command === "--help" || command === "-h") {
    args.command = null;
    args.help = true;
    return args;
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--project":
        args.projects.push(rest[++index]);
        break;
      case "--project-limit":
        args.projectLimit = parsePositiveInt(rest[++index], args.projectLimit);
        args._projectLimitExplicit = true;
        break;
      case "--thread-limit":
        args.threadLimit = parsePositiveInt(rest[++index], args.threadLimit);
        args._threadLimitExplicit = true;
        break;
      case "--threads-per-project":
        args.threadsPerProject = parsePositiveInt(rest[++index], args.threadsPerProject);
        args._threadsPerProjectExplicit = true;
        break;
      case "--no-chats":
        args.includeChats = false;
        break;
      case "--private-chat-user-id":
        args.privateChatUserId = rest[++index];
        break;
      case "--chats-title":
        args.chatsSurfaceTitle = rest[++index];
        break;
      case "--history-max-messages":
        args.historyMaxMessages = parsePositiveInt(rest[++index], args.historyMaxMessages);
        args._historyMaxMessagesExplicit = true;
        break;
      case "--history-max-user-prompts":
        args.historyMaxUserPrompts = parsePositiveInt(rest[++index], args.historyMaxUserPrompts);
        args._historyMaxUserPromptsExplicit = true;
        break;
      case "--history-assistant-phase":
        if (!args._historyAssistantPhasesExplicit) {
          args.historyAssistantPhases = [];
        }
        args.historyAssistantPhases.push(rest[++index]);
        args._historyAssistantPhasesExplicit = true;
        break;
      case "--history-include-heartbeats":
        args.historyIncludeHeartbeats = true;
        args._historyIncludeHeartbeatsExplicit = true;
        break;
      case "--group-prefix":
        args.groupPrefix = rest[++index];
        break;
      case "--folder-title":
        args.folderTitle = rest[++index];
        break;
      case "--topic-display":
        args.topicDisplay = rest[++index];
        if (!["tabs", "list"].includes(args.topicDisplay)) {
          fail("--topic-display must be tabs or list");
        }
        break;
      case "--threads-db":
        args.threadsDbPath = rest[++index];
        break;
      case "--codex-global-state":
        args.codexGlobalStatePath = rest[++index];
        break;
      case "--output":
        args.outputPath = rest[++index];
        args._outputPathExplicit = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--preview":
        args.preview = true;
        break;
      case "--rehearsal":
        args.rehearsal = true;
        break;
      case "--write":
        args.write = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--no-input":
        args.noInput = true;
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--cleanup-dry-run":
        args.cleanupDryRun = true;
        break;
      case "--cleanup":
        args.cleanup = true;
        break;
      case "--cleanup-scan-limit":
        args.cleanupScanLimit = parsePositiveInt(rest[++index], args.cleanupScanLimit);
        break;
      case "--backfill":
        args.backfill = true;
        break;
      case "--backfill-dry-run":
        args.backfillDryRun = true;
        break;
      case "--smoke":
        args.smoke = true;
        break;
      case "--smoke-text":
        args.smokeText = rest[++index];
        break;
      case "--smoke-expect":
        args.smokeExpect = rest[++index];
        break;
      case "--smoke-timeout-seconds":
        args.smokeTimeoutSeconds = parsePositiveInt(rest[++index], args.smokeTimeoutSeconds);
        break;
      case "--admin-helper":
        args.adminHelperPath = rest[++index];
        break;
      case "--admin-python":
        args.adminPythonPath = rest[++index];
        break;
      case "--config":
        args.configPath = rest[++index];
        break;
      case "--admin-env":
        args.adminEnvPath = rest[++index];
        break;
      case "--admin-session":
        args.adminSessionPath = rest[++index];
        break;
      case "--bridge-state":
        args.bridgeStatePath = rest[++index];
        break;
      case "--prepare":
        args.prepare = true;
        break;
      case "--no-prepare":
        args.noPrepare = true;
        break;
      case "--skip-admin-deps":
        args.skipAdminDeps = true;
        break;
      case "--skip-bot-avatar":
        args.skipBotAvatar = true;
        break;
      case "--login-qr":
        args.loginQr = true;
        break;
      case "--login-phone":
        args.loginPhone = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (args.rehearsal) {
    if (!args._projectLimitExplicit) args.projectLimit = 2;
    if (!args._threadsPerProjectExplicit) args.threadsPerProject = 2;
    if (!args._historyMaxMessagesExplicit) args.historyMaxMessages = 20;
    if (!args.groupPrefix) args.groupPrefix = DEFAULT_REHEARSAL_GROUP_PREFIX;
    if (!args.folderTitle) args.folderTitle = DEFAULT_REHEARSAL_FOLDER_TITLE;
    if (!args._outputPathExplicit) args.outputPath = DEFAULT_REHEARSAL_OUTPUT_PATH;
  }

  if (args.command === "quickstart") {
    if (!args._threadLimitExplicit) {
      args.threadLimit = DEFAULT_QUICKSTART_THREAD_LIMIT;
    }
    if (!args._historyMaxMessagesExplicit) {
      args.historyMaxMessages = DEFAULT_QUICKSTART_HISTORY_MAX_MESSAGES;
      args._historyMaxMessagesExplicit = true;
    }
    if (!args.preview) {
      args.prepare = true;
      args.write = true;
      args.apply = true;
      args.backfill = true;
      args.smoke = true;
      args.yes = true;
    }
  }

  return args;
}

function renderHelp() {
  return [
    "Usage:",
    "  node scripts/onboard.mjs prepare [--skip-admin-deps] [--login-qr|--login-phone]",
    "  node scripts/onboard.mjs doctor [--json]",
    "  node scripts/onboard.mjs scan [--project-limit 8] [--threads-per-project 3] [--json]",
    "  node scripts/onboard.mjs quickstart [--thread-limit 10] [--history-max-messages 10] [--preview] [--no-chats] [--skip-bot-avatar]",
    "  node scripts/onboard.mjs plan --project /path/to/repo [--project /path/to/other] [--threads-per-project 3] [--history-max-messages 40] [--history-assistant-phase final_answer] [--group-prefix 'Codex - '] [--folder-title codex] [--topic-display tabs|list] [--write]",
    "  node scripts/onboard.mjs plan --rehearsal --project /path/to/repo [--write]",
    "  node scripts/onboard.mjs wizard [--rehearsal] [--write] [--apply] [--cleanup-dry-run|--cleanup] [--backfill-dry-run|--backfill] [--smoke]",
    `  ${CODEX_APP_CONTROL_DIRECT_COMMAND}`,
    "",
    "Notes:",
    "  preferred public setup is agent-led quickstart: ask Codex to prepare local config, then run quickstart.",
    "  prepare creates missing local config/admin env files, can create the admin venv, and can guide credential/session setup.",
    "  never paste tokens, API hashes, login codes or 2FA passwords into Codex chat; use local prompts/Telegram UI.",
    "  doctor checks local prerequisites before the wizard gets creative.",
    "  codex:launch is a repo-local helper for the same debug launch; run it from this project directory.",
    `  ${VOICE_TRANSCRIPTION_PROVIDER_NOTE}`,
    "  scan is read-only and shows candidate Codex projects/threads.",
    "  quickstart is automatic: pinned Codex threads first, then latest active threads and Chats, bounded clean history, bootstrap, best-effort bot avatar, backfill and smoke.",
    "  plan is a preview by default; add --write to update admin/bootstrap-plan.json.",
    "  wizard is the manual escape hatch and can write/apply/backfill/smoke with explicit confirmation or flags.",
    "  history import defaults come from config.local.json unless a history flag overrides them.",
    "  --cleanup-dry-run previews a clean rebuild for bootstrapped topics; --cleanup deletes visible topic messages except protected root/status ids.",
    "  --rehearsal writes admin/bootstrap-plan.rehearsal.json by default and uses codex-lab/Codex Lab naming.",
    "  lower-level admin/telegram_user_admin.py commands are escape hatches, not the normal install story.",
  ].join("\n");
}

function renderPostOnboardingRuntimeNote({ configPath = DEFAULT_CONFIG_PATH } = {}) {
  return [
    "",
    "Next: launch Codex in the live Desktop mode:",
    "",
    `  ${CODEX_APP_CONTROL_DIRECT_COMMAND}`,
    "",
    "If you are inside this repo, the helper is fine too:",
    "",
    `  ${CODEX_REPO_LAUNCH_COMMAND}`,
    "",
    "This opens Codex.app with app-control on http://127.0.0.1:9222. It is the good mode: Telegram messages land in Codex Desktop, replies mirror back, and your phone feels like a real Codex surface.",
    "",
    `Other mode: app-server fallback. It is calmer when the Desktop renderer gets flaky, but it is less UI-aware and Codex Desktop may not update live. Use \`nativeIngressTransport: "app-server"\` in ${configPath} only when app-control is being dramatic.`,
    "",
    "Optional, but worth it: set Codex Personality to Friendly and use this Custom Instructions preset. It makes the phone surface feel much less like a ticketing system wearing a Telegram mask.",
    "",
    "If you want the installing agent to save you from UI spelunking, ask:",
    "",
    "  Please set Codex Personality to Friendly and paste this preset into Custom Instructions.",
    "",
    CODEX_CUSTOM_INSTRUCTIONS_PRESET,
    "",
  ].join("\n");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isPlaceholderValue(value) {
  return /^your_|^123456789$/.test(String(value ?? "").trim());
}

function cleanBotUsername(value) {
  const text = String(value ?? "").trim().replace(/^@+/, "");
  return text && !isPlaceholderValue(text) ? text : "";
}

function sanitizeConfigTemplate(config) {
  const next = { ...config };
  if (Array.isArray(next.allowedUserIds) && next.allowedUserIds.some((value) => isPlaceholderValue(value))) {
    next.allowedUserIds = [];
  }
  if (isPlaceholderValue(next.botUsername)) {
    next.botUsername = null;
  }
  return next;
}

async function ensureConfigFile(args) {
  if (await pathExists(args.configPath)) {
    return { changed: false, message: `config exists: ${args.configPath}` };
  }
  const template = sanitizeConfigTemplate(await readJsonIfExists(DEFAULT_CONFIG_EXAMPLE_PATH, {}));
  await writeJsonFile(args.configPath, template);
  return { changed: true, message: `created config: ${args.configPath}` };
}

async function ensureAdminEnvFile(args) {
  if (await pathExists(args.adminEnvPath)) {
    return { changed: false, message: `admin env exists: ${args.adminEnvPath}` };
  }
  await fs.mkdir(path.dirname(args.adminEnvPath), { recursive: true });
  const template = await fs.readFile(DEFAULT_ADMIN_ENV_EXAMPLE_PATH, "utf8");
  await fs.writeFile(args.adminEnvPath, template, "utf8");
  return { changed: true, message: `created admin env: ${args.adminEnvPath}` };
}

async function ensureLocalDirs() {
  await Promise.all([
    fs.mkdir(path.join(PROJECT_ROOT, "admin"), { recursive: true }),
    fs.mkdir(path.join(PROJECT_ROOT, "logs"), { recursive: true }),
    fs.mkdir(path.join(PROJECT_ROOT, "state"), { recursive: true }),
  ]);
}

function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    values[match[1]] = match[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
  }
  return values;
}

async function readEnvValues(filePath) {
  try {
    return parseEnvText(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function hasRealEnvValue(values, key) {
  const value = String(values?.[key] ?? "").trim();
  return Boolean(value) && !isPlaceholderValue(value);
}

function validateTelegramAdminEnv(values, envFileOk, envPath) {
  if (!envFileOk) {
    return {
      ok: false,
      detail: envPath,
      action: "Run `npm run onboard:prepare` and paste Telegram API_ID/API_HASH from my.telegram.org when asked.",
    };
  }
  if (!hasRealEnvValue(values, "API_ID") || !hasRealEnvValue(values, "API_HASH")) {
    return {
      ok: false,
      detail: `${envPath} (API_ID/API_HASH required)`,
      action: "Run `npm run onboard:prepare` and paste Telegram API_ID/API_HASH from my.telegram.org when asked.",
    };
  }
  const apiId = String(values.API_ID).trim();
  const apiHash = String(values.API_HASH).trim();
  if (!/^\d+$/.test(apiId) || Number.parseInt(apiId, 10) <= 0) {
    return {
      ok: false,
      detail: `${envPath} (API_ID must be a positive number)`,
      action: "Run `npm run onboard:prepare` and paste a fresh numeric Telegram API_ID from my.telegram.org.",
    };
  }
  if (!/^[a-f0-9]{32}$/i.test(apiHash)) {
    return {
      ok: false,
      detail: `${envPath} (API_HASH should be a 32-character hex string)`,
      action: "Run `npm run onboard:prepare` and paste a fresh Telegram API_HASH from my.telegram.org.",
    };
  }
  return {
    ok: true,
    detail: `${envPath} (API_ID/API_HASH look valid)`,
    action: "",
  };
}

function isProbablyTelegramBotToken(token) {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(token ?? "").trim());
}

async function inspectBridgeBotToken(args, config) {
  const botTokenEnv = config.botTokenEnv || "CODEX_TELEGRAM_BOT_TOKEN";
  const keychainService = config.botTokenKeychainService || DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE;
  const envToken = process.env[botTokenEnv];
  const configToken = config.botToken;
  const tokenSource = envToken ? `env ${botTokenEnv}` : configToken ? args.configPath : "";
  const token = envToken || configToken;
  if (token) {
    return {
      ok: !isPlaceholderValue(token) && isProbablyTelegramBotToken(token),
      detail:
        !isPlaceholderValue(token) && isProbablyTelegramBotToken(token)
          ? `${tokenSource} (token format looks valid)`
          : `${tokenSource} (token format looks wrong)`,
      action: "Create/reuse a bot with @BotFather, then let `npm run onboard:prepare` store the token locally.",
    };
  }
  const hasKeychainToken = await keychainHasSecret(keychainService);
  return {
    ok: hasKeychainToken,
    detail: hasKeychainToken ? `Keychain service ${keychainService}` : `${botTokenEnv}, config, or Keychain service ${keychainService}`,
    action: "Create/reuse a bot with @BotFather, then let `npm run onboard:prepare` store the token locally.",
  };
}

async function inspectVoiceTranscription(config = {}) {
  if (config.voiceTranscriptionEnabled === false) {
    return {
      ok: true,
      detail: "disabled in config",
      action: "",
    };
  }

  const provider = normalizeVoiceTranscriptionProvider(config.voiceTranscriptionProvider);
  const command = Array.isArray(config.voiceTranscriptionCommand)
    ? config.voiceTranscriptionCommand.map(String).filter(Boolean)
    : [];
  const deepgramEnv = config.voiceTranscriptionDeepgramKeyEnv || config.voiceTranscriptionApiKeyEnv || "DEEPGRAM_API_KEY";
  const openAIEnv = config.voiceTranscriptionOpenAIKeyEnv || config.voiceTranscriptionApiKeyEnv || "OPENAI_API_KEY";
  const deepgramKeychain =
    config.voiceTranscriptionDeepgramKeychainService ||
    (provider === "deepgram" ? config.voiceTranscriptionKeychainService : null) ||
    DEFAULT_DEEPGRAM_KEYCHAIN_SERVICE;
  const openAIKeychain =
    config.voiceTranscriptionOpenAIKeychainService ||
    (provider === "openai" ? config.voiceTranscriptionKeychainService : null) ||
    DEFAULT_OPENAI_KEYCHAIN_SERVICE;
  const hasDeepgramConfig =
    Boolean(process.env[deepgramEnv]) ||
    Boolean(config.voiceTranscriptionDeepgramApiKey) ||
    (provider === "deepgram" && Boolean(config.voiceTranscriptionApiKey));
  const hasOpenAIConfig =
    Boolean(process.env[openAIEnv]) ||
    Boolean(config.voiceTranscriptionOpenAIApiKey) ||
    (provider === "openai" && Boolean(config.voiceTranscriptionApiKey));
  const [hasDeepgramKeychain, hasOpenAIKeychain] = await Promise.all([
    hasDeepgramConfig ? Promise.resolve(false) : keychainHasSecret(deepgramKeychain),
    hasOpenAIConfig ? Promise.resolve(false) : keychainHasSecret(openAIKeychain),
  ]);

  const sources = [];
  if (hasDeepgramConfig) sources.push(deepgramEnv);
  if (hasDeepgramKeychain) sources.push(`Keychain ${deepgramKeychain}`);
  if (hasOpenAIConfig) sources.push(openAIEnv);
  if (hasOpenAIKeychain) sources.push(`Keychain ${openAIKeychain}`);
  if (command.length) sources.push("local command");

  const deepgramOk = hasDeepgramConfig || hasDeepgramKeychain;
  const openAIOk = hasOpenAIConfig || hasOpenAIKeychain;
  const commandOk = command.length > 0;
  const ok =
    provider === "deepgram"
      ? deepgramOk
      : provider === "openai"
        ? openAIOk
        : provider === "command"
          ? commandOk
          : deepgramOk || openAIOk || commandOk;
  return {
    ok,
    detail: ok
      ? `${provider}; ${sources.join(", ")}`
      : `${provider}; missing STT provider (Deepgram/OpenAI key or local command)`,
    action:
      `${VOICE_TRANSCRIPTION_PROVIDER_NOTE} For the easiest mobile voice UX, add \`DEEPGRAM_API_KEY\` or store it in Keychain service \`codex-telegram-bridge-deepgram-api-key\`. OpenAI also works via \`OPENAI_API_KEY\`, and local command is the escape hatch. ${CODEX_NATIVE_STT_NOTE} Restart the bridge after changing STT settings.`,
  };
}

function compactErrorMessage(error) {
  const stderr = String(error?.stderr ?? "").trim();
  const stdout = String(error?.stdout ?? "").trim();
  const message = String(error?.message ?? error ?? "").trim();
  const raw = stderr || stdout || message || "unknown error";
  return raw.replace(/\s+/g, " ").slice(0, 240);
}

function sessionRecoveryAction(errorText) {
  const text = String(errorText ?? "").toLowerCase();
  if (text.includes("api_id") || text.includes("api_hash") || text.includes("invalid")) {
    return "Fix Telegram API_ID/API_HASH in `admin/.env`, then rerun `npm run onboard:doctor`.";
  }
  return "Run `npm run onboard:prepare -- --login-qr` or `npm run onboard:prepare -- --login-phone` and authorize the local Telegram user session.";
}

function adminSessionDisplayName(payload) {
  const me = payload?.me ?? {};
  return me.username ? `@${me.username}` : me.first_name || me.id || "Telegram user";
}

async function inspectAdminSessionWithPython(args, python) {
  const exists = await pathExists(args.adminSessionPath);
  if (!exists) {
    return { exists: false, verified: false, authorized: false, detail: args.adminSessionPath };
  }
  try {
    const { stdout } = await execFileAsync(python, [...adminBaseArgs(args), "whoami"], {
      cwd: PROJECT_ROOT,
      env: process.env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    const payload = JSON.parse(stdout);
    return {
      exists: true,
      verified: true,
      authorized: Boolean(payload.authorized),
      detail: payload.authorized
        ? `${args.adminSessionPath} (authorized as ${adminSessionDisplayName(payload)})`
        : `${args.adminSessionPath} (session file exists but is not authorized)`,
      payload,
    };
  } catch (error) {
    const message = compactErrorMessage(error);
    return {
      exists: true,
      verified: false,
      authorized: false,
      detail: `${args.adminSessionPath} (${message})`,
      errorText: message,
    };
  }
}

async function inspectAdminSession(args, { envOk, helperOk, adminPythonOk, sessionFileOk }) {
  if (!sessionFileOk) {
    return {
      ok: false,
      detail: args.adminSessionPath,
      action: "Run `npm run onboard:prepare -- --login-qr` and authorize the local Telegram user session.",
    };
  }
  if (!envOk || !helperOk || !adminPythonOk) {
    return {
      ok: false,
      detail: `${args.adminSessionPath} (cannot verify until admin env/helper/python are ready)`,
      action: "Fix the admin setup above, then rerun `npm run onboard:doctor`.",
    };
  }
  try {
    const python = await resolveAdminPython(args);
    const session = await inspectAdminSessionWithPython(args, python);
    if (!session.authorized) {
      return {
        ok: false,
        detail: session.detail,
        action: sessionRecoveryAction(session.errorText),
      };
    }
    return {
      ok: true,
      detail: session.detail,
      action: "",
    };
  } catch (error) {
    const message = compactErrorMessage(error);
    return {
      ok: false,
      detail: `${args.adminSessionPath} (${message})`,
      action: sessionRecoveryAction(message),
    };
  }
}

function formatEnvValue(value) {
  const text = String(value ?? "");
  if (!text || /^[A-Za-z0-9_:@./-]+$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

async function setEnvValues(filePath, updates) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    text = "";
  }
  const pending = new Map(
    Object.entries(updates).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ""),
  );
  const lines = text.split(/\r?\n/);
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !pending.has(match[1])) {
      return line;
    }
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${formatEnvValue(value)}`;
  });
  for (const [key, value] of pending) {
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }
  await fs.writeFile(filePath, `${nextLines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
}

async function setConfigValues(filePath, updates) {
  const config = await readJsonIfExists(filePath, {});
  await writeJsonFile(filePath, { ...config, ...updates });
}

async function runPlainCommand(command, args, { cwd = PROJECT_ROOT } = {}) {
  process.stdout.write(`\n$ ${[command, ...args].join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with exit code ${code}`));
    });
  });
}

async function ensureAdminDeps(args) {
  if (await pathExists(args.adminPythonPath)) {
    return { changed: false, message: `admin Python exists: ${args.adminPythonPath}` };
  }
  const venvDir = path.dirname(path.dirname(args.adminPythonPath));
  await runPlainCommand("python3", ["-m", "venv", venvDir]);
  await runPlainCommand(args.adminPythonPath, ["-m", "pip", "install", "-r", DEFAULT_ADMIN_REQUIREMENTS_PATH]);
  return { changed: true, message: `created admin Python venv: ${venvDir}` };
}

async function askSecretLine(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return "";
  }
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!output.muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    },
  });
  output.muted = false;
  const secretRl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  const answerPromise = secretRl.question(`${question}: `);
  output.muted = true;
  const answer = await answerPromise;
  process.stdout.write("\n");
  secretRl.close();
  return answer.trim();
}

async function hasBridgeBotToken(args) {
  const config = await readJsonIfExists(args.configPath, {});
  return (await inspectBridgeBotToken(args, config)).ok;
}

async function storeBotToken(args, token) {
  const config = await readJsonIfExists(args.configPath, {});
  const keychainService = config.botTokenKeychainService || DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE;
  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-s",
      String(keychainService),
      "-a",
      "codex-telegram-frontend",
      "-w",
      token,
    ]);
    return `stored bot token in macOS Keychain service ${keychainService}`;
  }
  await setConfigValues(args.configPath, { botToken: token });
  return `stored bot token in ${args.configPath}`;
}

function normalizeAssistantPhases(value, fallback = DEFAULT_HISTORY_ASSISTANT_PHASES) {
  const raw = Array.isArray(value) ? value : fallback;
  const phases = Array.from(
    new Set(
      raw
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
  return phases.length ? phases : [...DEFAULT_HISTORY_ASSISTANT_PHASES];
}

async function applyConfigDefaults(args) {
  const config = await readJsonIfExists(args.configPath, {});
  if (!args.rehearsal && !args._historyMaxMessagesExplicit && Number.isFinite(config.historyMaxMessages)) {
    args.historyMaxMessages = parsePositiveInt(config.historyMaxMessages, args.historyMaxMessages);
  }
  if (!args._historyMaxUserPromptsExplicit && Number.isFinite(config.historyMaxUserPrompts)) {
    args.historyMaxUserPrompts = parsePositiveInt(config.historyMaxUserPrompts, args.historyMaxUserPrompts);
  }
  if (!args._historyAssistantPhasesExplicit && Array.isArray(config.historyAssistantPhases)) {
    args.historyAssistantPhases = normalizeAssistantPhases(config.historyAssistantPhases);
  } else {
    args.historyAssistantPhases = normalizeAssistantPhases(args.historyAssistantPhases);
  }
  if (!args._historyIncludeHeartbeatsExplicit && typeof config.historyIncludeHeartbeats === "boolean") {
    args.historyIncludeHeartbeats = config.historyIncludeHeartbeats;
  }
}

async function keychainHasSecret(serviceName) {
  if (process.platform !== "darwin" || !serviceName) {
    return false;
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      String(serviceName),
      "-w",
    ]);
    return Boolean(String(stdout ?? "").trim());
  } catch {
    return false;
  }
}

async function resolveAdminPython(args) {
  return (await pathExists(args.adminPythonPath)) ? args.adminPythonPath : "python3";
}

function createPrompt() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function askLine(rl, question, fallback = "") {
  if (!rl) {
    return fallback;
  }
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || fallback;
}

async function askYesNo(rl, question, fallback = false) {
  const answer = (await askLine(rl, `${question} (${fallback ? "Y/n" : "y/N"})`, fallback ? "y" : "n")).toLowerCase();
  return ["y", "yes"].includes(answer);
}

function parseSelection(input, max, fallback = []) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return fallback;
  }
  const selected = new Set();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) {
      continue;
    }
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number.parseInt(range[1], 10);
      const end = Number.parseInt(range[2], 10);
      for (let value = Math.min(start, end); value <= Math.max(start, end); value += 1) {
        if (value >= 1 && value <= max) {
          selected.add(value - 1);
        }
      }
      continue;
    }
    const value = Number.parseInt(token, 10);
    if (value >= 1 && value <= max) {
      selected.add(value - 1);
    }
  }
  return selected.size ? [...selected].sort((a, b) => a - b) : fallback;
}

function makeCheck(label, ok, detail = "", { required = true, action = "" } = {}) {
  return {
    label,
    ok: Boolean(ok),
    detail,
    required,
    action,
  };
}

function renderChecklistItem(check) {
  const status = check.ok ? "[ok]" : check.required ? "[missing]" : "[warn]";
  return `${status} ${check.label}${check.detail ? ` - ${check.detail}` : ""}`;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function renderRecoveryPlan(checks) {
  const missingRequired = checks.filter((check) => !check.ok && check.required);
  const missingOptional = checks.filter((check) => !check.ok && !check.required);
  const lines = [];
  const requiredActions = uniqueStrings(missingRequired.map((check) => check.action));
  if (requiredActions.length) {
    lines.push("Recovery plan:");
    for (const action of requiredActions) {
      lines.push(`- ${action}`);
    }
  }
  const optionalActions = uniqueStrings(missingOptional.map((check) => check.action));
  if (optionalActions.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("Optional polish:");
    for (const action of optionalActions) {
      lines.push(`- ${action}`);
    }
  }
  return lines.join("\n");
}

async function buildOnboardingChecks(args) {
  const config = await readJsonIfExists(args.configPath, {});
  const envValues = await readEnvValues(args.adminEnvPath);
  const nativeDebugBaseUrl = config.nativeDebugBaseUrl || DEFAULT_NATIVE_DEBUG_BASE_URL;
  const envFileOk = await pathExists(args.adminEnvPath);
  const envCheck = validateTelegramAdminEnv(envValues, envFileOk, args.adminEnvPath);
  const [
    configOk,
    helperOk,
    adminPythonOk,
    sessionFileOk,
    threadsDbOk,
    codexAppOk,
    botTokenCheck,
    voiceTranscriptionCheck,
    appControl,
  ] =
    await Promise.all([
      pathExists(args.configPath),
      pathExists(args.adminHelperPath),
      pathExists(args.adminPythonPath),
      pathExists(args.adminSessionPath),
      pathExists(args.threadsDbPath),
      pathExists("/Applications/Codex.app/Contents/MacOS/Codex"),
      inspectBridgeBotToken(args, config),
      inspectVoiceTranscription(config),
      checkAppControl(nativeDebugBaseUrl),
    ]);
  const sessionCheck = await inspectAdminSession(args, {
    envOk: envCheck.ok,
    helperOk,
    adminPythonOk,
    sessionFileOk,
  });
  const appControlOk = appControl.ok;
  return [
    makeCheck("macOS host", process.platform === "darwin", process.platform, {
      action: "Use a local macOS host for v1. Linux/Windows are not supported yet.",
    }),
    makeCheck("Codex.app", codexAppOk, "/Applications/Codex.app/Contents/MacOS/Codex", {
      action: "Install Codex Desktop in /Applications, then open this repo in Codex.",
    }),
    makeCheck("config.local.json", configOk, args.configPath, {
      action: "Run `npm run onboard:prepare`; it creates a safe local config from the example.",
    }),
    makeCheck("admin .env with Telegram API_ID/API_HASH", envCheck.ok, envCheck.detail, {
      action: envCheck.action,
    }),
    makeCheck("Telethon helper", helperOk, args.adminHelperPath, {
      action: "Restore the repo files; admin/telegram_user_admin.py is required for folder/group/topic bootstrap.",
    }),
    makeCheck("admin Python venv", adminPythonOk, args.adminPythonPath, {
      action: "Run `npm run onboard:prepare` without `--skip-admin-deps` to create the admin Python venv.",
    }),
    makeCheck("authorized Telegram user session", sessionCheck.ok, sessionCheck.detail, {
      action: sessionCheck.action,
    }),
    makeCheck("local Codex threads DB", threadsDbOk, args.threadsDbPath, {
      action: "Open Codex Desktop locally at least once; the wizard needs the local Codex threads DB.",
    }),
    makeCheck("Telegram bot token", botTokenCheck.ok, botTokenCheck.detail, {
      action: botTokenCheck.action,
    }),
    makeCheck("voice transcription", voiceTranscriptionCheck.ok, voiceTranscriptionCheck.detail, {
      required: false,
      action: voiceTranscriptionCheck.action,
    }),
    makeCheck(
      "app-control debug port",
      appControlOk,
      appControlOk ? nativeDebugBaseUrl : `${nativeDebugBaseUrl}; launch Codex with --remote-debugging-port=9222`,
      {
        required: false,
        action: `Run \`${CODEX_APP_CONTROL_DIRECT_COMMAND}\`, or run \`npm run codex:launch\` from this repo, for the best live Telegram <-> Codex Desktop UX.`,
      },
    ),
  ];
}

async function buildOnboardingChecklist(args) {
  return (await buildOnboardingChecks(args)).map(renderChecklistItem);
}

async function buildLocalSetupNeeds(args) {
  const envValues = await readEnvValues(args.adminEnvPath);
  const [configOk, envFileOk, adminPythonOk] = await Promise.all([
    pathExists(args.configPath),
    pathExists(args.adminEnvPath),
    pathExists(args.adminPythonPath),
  ]);
  const envOk = envFileOk && hasRealEnvValue(envValues, "API_ID") && hasRealEnvValue(envValues, "API_HASH");
  const needs = [];
  if (!configOk) needs.push("config.local.json");
  if (!envOk) needs.push("admin/.env");
  if (!adminPythonOk) needs.push("admin Python venv");
  return needs;
}

async function promptCredentialSetup(args, rl) {
  if (!rl || args.noInput) {
    return [];
  }
  const messages = [];
  const envValues = await readEnvValues(args.adminEnvPath);
  const apiMissing = !hasRealEnvValue(envValues, "API_ID") || !hasRealEnvValue(envValues, "API_HASH");
  if (apiMissing && (await askYesNo(rl, "Add Telegram API_ID/API_HASH to admin .env now?", true))) {
    const apiId = await askLine(rl, "Telegram API_ID");
    const apiHash = await askSecretLine("Telegram API_HASH (hidden)");
    if (apiId && apiHash) {
      await setEnvValues(args.adminEnvPath, { API_ID: apiId, API_HASH: apiHash });
      messages.push(`updated Telegram API credentials in ${args.adminEnvPath}`);
    }
  }

  const config = await readJsonIfExists(args.configPath, {});
  const updatedEnvValues = await readEnvValues(args.adminEnvPath);
  const existingBotUsername = cleanBotUsername(config.botUsername) || cleanBotUsername(updatedEnvValues.CODEX_TELEGRAM_BOT_USERNAME);
  if (!existingBotUsername && (await askYesNo(rl, "Add Telegram bot username now?", true))) {
    const botUsername = cleanBotUsername(await askLine(rl, "Bot username without @"));
    if (botUsername) {
      await setConfigValues(args.configPath, { botUsername });
      await setEnvValues(args.adminEnvPath, { CODEX_TELEGRAM_BOT_USERNAME: botUsername });
      messages.push(`stored bot username ${botUsername}`);
    }
  }

  if (!(await hasBridgeBotToken(args)) && (await askYesNo(rl, "Store Telegram bot token locally now?", true))) {
    const token = await askSecretLine("Telegram bot token (hidden)");
    if (token) {
      messages.push(await storeBotToken(args, token));
    }
  }
  return messages;
}

async function removeAdminSessionFiles(sessionPath) {
  const candidates = [sessionPath, `${sessionPath}-journal`, `${sessionPath}-wal`, `${sessionPath}-shm`];
  const removed = [];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    await fs.rm(candidate, { force: true });
    removed.push(candidate);
  }
  return removed;
}

function shouldRemoveAdminSessionForLogin(session) {
  if (!session?.exists) {
    return false;
  }
  if (session.verified) {
    return !session.authorized;
  }
  const errorText = String(session.errorText ?? "").toLowerCase();
  return errorText.includes("database disk image is malformed") || errorText.includes("not a database");
}

async function maybeRunTelegramLogin(args, rl, python) {
  const session = await inspectAdminSessionWithPython(args, python);
  if (session.authorized) {
    return `Telegram user session already authorized: ${session.detail}`;
  }

  const shouldLogin =
    args.loginQr ||
    args.loginPhone ||
    (rl && !args.noInput && (await askYesNo(rl, "Authorize Telegram user session with QR login now?", false)));
  if (!shouldLogin) {
    return null;
  }

  const messages = [];
  if (shouldRemoveAdminSessionForLogin(session)) {
    const removed = await removeAdminSessionFiles(args.adminSessionPath);
    if (removed.length) {
      messages.push(`removed stale Telegram user session before login: ${removed.map((filePath) => path.basename(filePath)).join(", ")}`);
    }
  }

  const loginCommand = args.loginPhone ? "login-phone" : "login-qr";
  await runPlainCommand(python, [...adminBaseArgs(args), loginCommand], { cwd: PROJECT_ROOT });
  messages.push(`authorized Telegram user session via ${args.loginPhone ? "phone login" : "QR login"}: ${args.adminSessionPath}`);
  return messages.join("\n");
}

async function prepareLocalSetup(args, rl, { force = false } = {}) {
  await ensureLocalDirs();
  const messages = [];
  messages.push((await ensureConfigFile(args)).message);
  messages.push((await ensureAdminEnvFile(args)).message);

  const shouldInstallDeps =
    !args.skipAdminDeps &&
    !(await pathExists(args.adminPythonPath)) &&
    (force || (rl && !args.noInput && (await askYesNo(rl, "Create admin Python venv and install requirements now?", true))));
  if (shouldInstallDeps) {
    messages.push((await ensureAdminDeps(args)).message);
  } else if (args.skipAdminDeps) {
    messages.push("skipped admin Python dependency setup");
  }

  messages.push(...(await promptCredentialSetup(args, rl)));
  const python = await resolveAdminPython(args);
  const loginMessage = await maybeRunTelegramLogin(args, rl, python);
  if (loginMessage) {
    messages.push(...loginMessage.split("\n"));
  }
  return messages.filter(Boolean);
}

async function maybePrepareForWizard(args, rl) {
  if (args.noPrepare) {
    return;
  }
  const needs = await buildLocalSetupNeeds(args);
  if (!args.prepare && !needs.length) {
    return;
  }
  const shouldPrepare =
    args.prepare ||
    (rl && !args.noInput && (await askYesNo(rl, `Prepare local setup now${needs.length ? ` (${needs.join(", ")})` : ""}?`, true)));
  if (!shouldPrepare) {
    return;
  }
  const messages = await prepareLocalSetup(args, rl);
  process.stdout.write(`\nLocal setup prepare:\n${messages.map((message) => `- ${message}`).join("\n")}\n\n`);
}

function printProjectChoices(projects) {
  process.stdout.write("Candidate projects:\n");
  for (const [index, project] of projects.entries()) {
    process.stdout.write(`${index + 1}. ${project.projectRoot} (${formatProjectMeta(project)})\n`);
    for (const [threadIndex, thread] of (project.threads ?? []).slice(0, 5).entries()) {
      process.stdout.write(`   ${threadIndex + 1}. ${sanitizeThreadTitle(thread)} (${thread.id}; ${formatThreadMeta(thread)})\n`);
    }
  }
}

function sanitizeThreadTitle(thread) {
  return String(thread?.title || thread?.id || "thread").replace(/\s+/g, " ").trim();
}

function normalizeTimestampMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed < 100_000_000_000 ? parsed * 1000 : parsed;
}

function formatAge(value) {
  const timestampMs = normalizeTimestampMs(value);
  if (!timestampMs) {
    return null;
  }
  const deltaMs = Math.max(0, Date.now() - timestampMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (deltaMs < hour) {
    return `${Math.max(1, Math.round(deltaMs / minute))}m ago`;
  }
  if (deltaMs < day) {
    return `${Math.max(1, Math.round(deltaMs / hour))}h ago`;
  }
  return `${Math.max(1, Math.round(deltaMs / day))}d ago`;
}

function formatCompactNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  if (parsed >= 1_000_000) {
    return `${Math.round(parsed / 100_000) / 10}m`;
  }
  if (parsed >= 1_000) {
    return `${Math.round(parsed / 100) / 10}k`;
  }
  return String(parsed);
}

function formatProjectMeta(project) {
  const bits = [`${project.threadCount ?? project.threads?.length ?? 0} threads`];
  const age = formatAge(project.latestUpdatedAtMs ?? project.latestUpdatedAt);
  if (age) {
    bits.push(`last ${age}`);
  }
  return bits.join(", ");
}

function formatThreadMeta(thread) {
  const bits = [];
  const age = formatAge(thread.updated_at_ms ?? thread.updated_at);
  if (age) {
    bits.push(`last ${age}`);
  }
  const model = String(thread.model ?? "").trim();
  const reasoning = String(thread.reasoning_effort ?? "").trim();
  if (model && reasoning) {
    bits.push(`${model}/${reasoning}`);
  } else if (model) {
    bits.push(model);
  }
  const tokens = formatCompactNumber(thread.tokens_used);
  if (tokens) {
    bits.push(`${tokens} tokens`);
  }
  return bits.join(", ") || "no recent metadata";
}

function resolveProjectPath(value, fallback) {
  const text = String(value || fallback || "").trim();
  if (!text) {
    return fallback;
  }
  return path.isAbsolute(text) ? text : path.join(PROJECT_ROOT, text);
}

function normalizePathText(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function isLikelyCodexChatThread(thread, { homeDir = os.homedir() } = {}) {
  const cwd = normalizePathText(thread?.cwd);
  if (!cwd) {
    return true;
  }
  const home = normalizePathText(homeDir);
  const codexScratchRoot = normalizePathText(path.join(homeDir, "Documents", "Codex"));
  return cwd === home || cwd === codexScratchRoot || cwd.startsWith(`${codexScratchRoot}/`);
}

async function resolvePrivateChatUserId(args) {
  if (args.privateChatUserId) {
    return String(args.privateChatUserId).trim();
  }
  const config = await readJsonIfExists(args.configPath, {});
  const firstAllowedUser = Array.isArray(config.allowedUserIds) ? config.allowedUserIds[0] : null;
  return firstAllowedUser != null ? String(firstAllowedUser).trim() : "";
}

function findExistingGroup(projectIndex, projectPlan) {
  const groups = Array.isArray(projectIndex?.groups) ? projectIndex.groups : [];
  if (projectPlan.surface === PRIVATE_CHAT_TOPICS_SURFACE) {
    return (
      groups.find(
        (group) =>
          group?.surface === PRIVATE_CHAT_TOPICS_SURFACE &&
          String(group?.botApiChatId ?? "") === String(projectPlan.botApiChatId ?? ""),
      ) ??
      groups.find((group) => group?.surface === PRIVATE_CHAT_TOPICS_SURFACE) ??
      null
    );
  }
  return (
    groups.find((group) => String(group.projectRoot ?? "") === String(projectPlan.projectRoot ?? "")) ??
    groups.find((group) => String(group.groupTitle ?? "") === String(projectPlan.groupTitle ?? "")) ??
    null
  );
}

function findExistingTopic(group, topicPlan) {
  const topics = Array.isArray(group?.topics) ? group.topics : [];
  return (
    topics.find((topic) => String(topic.threadId ?? "") === String(topicPlan.threadId ?? "")) ??
    topics.find((topic) => String(topic.title ?? "") === String(topicPlan.title ?? "")) ??
    null
  );
}

function findBridgeBinding(bridgeState, group, topicPlan, existingTopic) {
  const bindings = Object.values(bridgeState?.bindings ?? {});
  return (
    bindings.find(
      (binding) =>
        String(binding?.chatId ?? "") === String(group?.botApiChatId ?? "") &&
        existingTopic?.topicId &&
        String(binding?.messageThreadId ?? "") === String(existingTopic.topicId),
    ) ??
    bindings.find(
      (binding) =>
        String(binding?.chatId ?? "") === String(group?.botApiChatId ?? "") &&
        String(binding?.threadId ?? "") === String(topicPlan.threadId ?? ""),
    ) ??
    null
  );
}

function formatReusePreview(plan, { projectIndex = {}, bridgeState = {}, projectIndexPath = DEFAULT_PROJECT_INDEX_PATH } = {}) {
  const lines = ["Reuse preview:"];
  const groups = Array.isArray(projectIndex?.groups) ? projectIndex.groups : [];
  if (!groups.length) {
    lines.push(`- no previous bootstrap index at ${projectIndexPath}`);
    lines.push("- bootstrap still reuses Telegram groups/topics by title when it can see them live");
    lines.push("- cleanup/backfill/smoke only run when you explicitly choose those steps");
    return lines.join("\n");
  }

  for (const project of plan.projects ?? []) {
    const existingGroup = findExistingGroup(projectIndex, project);
    if (existingGroup) {
      const label = project.surface === PRIVATE_CHAT_TOPICS_SURFACE ? "private chat" : "group";
      lines.push(`- ${label} ${project.groupTitle}: reuse ${existingGroup.botApiChatId ?? existingGroup.groupId ?? "known group"}`);
    } else {
      const label = project.surface === PRIVATE_CHAT_TOPICS_SURFACE ? "private chat" : "group";
      lines.push(`- ${label} ${project.groupTitle}: create or reuse by Telegram title`);
    }

    for (const topic of project.topics ?? []) {
      const existingTopic = findExistingTopic(existingGroup, topic);
      const binding = findBridgeBinding(bridgeState, existingGroup, topic, existingTopic);
      if (existingTopic) {
        lines.push(
          `  - topic ${topic.title}: reuse ${existingTopic.topicId ?? "known topic"}; ${
            binding ? "binding already present" : "binding refreshed on apply"
          }`,
        );
      } else {
        lines.push(`  - topic ${topic.title}: create or reuse by Telegram title`);
      }
    }
  }

  lines.push("- no Telegram history is deleted unless cleanup flags are selected");
  return lines.join("\n");
}

async function buildReusePreview(args, plan) {
  const config = await readJsonIfExists(args.configPath, {});
  const projectIndexPath = resolveProjectPath(config.projectIndexPath, DEFAULT_PROJECT_INDEX_PATH);
  const [projectIndex, bridgeState] = await Promise.all([
    readJsonIfExists(projectIndexPath, {}),
    readJsonIfExists(args.bridgeStatePath, {}),
  ]);
  return formatReusePreview(plan, { projectIndex, bridgeState, projectIndexPath });
}

async function runJsonCommand(command, args, { timeoutMs = 180_000 } = {}) {
  process.stdout.write(`\n$ ${[command, ...args].join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stderr.trim()) {
        process.stderr.write(stderr);
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} failed with exit code ${code}`));
        return;
      }
      process.stdout.write(stdout.trim() ? `${stdout.trim()}\n` : "");
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`failed to parse JSON output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function adminBaseArgs(args) {
  return [
    args.adminHelperPath,
    "--config",
    args.configPath,
    "--env-file",
    args.adminEnvPath,
    "--session",
    args.adminSessionPath,
  ];
}

function isNoCleanHistoryError(error) {
  return /no clean history messages found/i.test(compactErrorMessage(error));
}

async function runBootstrap(args, python) {
  return runJsonCommand(python, [
    ...adminBaseArgs(args),
    "bootstrap",
    "--plan",
    args.outputPath,
    "--bridge-state",
    args.bridgeStatePath,
  ]);
}

async function runBotAvatarPolish(args, python) {
  if (args.skipBotAvatar) {
    process.stdout.write("Skipping bot avatar polish because --skip-bot-avatar was passed.\n");
    return null;
  }
  try {
    process.stdout.write("Applying bundled bot avatar if this Telegram user owns the bot.\n");
    return await runJsonCommand(python, [...adminBaseArgs(args), "set-bot-avatar"], { timeoutMs: 120_000 });
  } catch (error) {
    process.stdout.write(
      `Skipping bot avatar polish: ${compactErrorMessage(error)}. The bridge still works; run \`npm run bot:avatar\` later if you care about the icon.\n`,
    );
    return null;
  }
}

async function runBackfillForSummary(args, python, bootstrapSummary, { dryRun = true } = {}) {
  const onboarding = bootstrapSummary?.onboarding ?? {};
  const historyMaxMessages = onboarding.historyMaxMessages ?? args.historyMaxMessages;
  const historyMaxUserPrompts = onboarding.historyMaxUserPrompts ?? args.historyMaxUserPrompts;
  const assistantPhases = normalizeAssistantPhases(onboarding.historyAssistantPhases ?? args.historyAssistantPhases);
  const includeHeartbeats = onboarding.historyIncludeHeartbeats ?? args.historyIncludeHeartbeats;
  const results = [];
  for (const group of bootstrapSummary?.groups ?? []) {
    for (const topic of group.topics ?? []) {
      const commandArgs = [
        ...adminBaseArgs(args),
        "backfill-thread",
        "--thread-id",
        topic.threadId,
        "--chat-id",
        String(group.botApiChatId),
        "--topic-id",
        String(topic.topicId),
        "--max-history-messages",
        String(historyMaxMessages),
        "--sender-mode",
        "labeled-bot",
      ];
      for (const phase of assistantPhases) {
        commandArgs.push("--assistant-phase", phase);
      }
      if (dryRun) {
        commandArgs.push("--dry-run");
      }
      if (historyMaxUserPrompts) {
        commandArgs.push("--max-user-prompts", String(historyMaxUserPrompts));
      }
      if (includeHeartbeats) {
        commandArgs.push("--include-heartbeats");
      }
      try {
        results.push(await runJsonCommand(python, commandArgs, { timeoutMs: 240_000 }));
      } catch (error) {
        if (!isNoCleanHistoryError(error)) {
          throw error;
        }
        const skipped = {
          status: "skipped",
          reason: "no clean history messages found",
          threadId: topic.threadId,
          chatId: String(group.botApiChatId),
          topicId: String(topic.topicId),
        };
        process.stdout.write(
          `Skipping history backfill for ${topic.title || topic.threadId}: no clean user/final-answer history found.\n`,
        );
        results.push(skipped);
      }
    }
  }
  return results;
}

async function runCleanupForSummary(args, python, bootstrapSummary, { dryRun = true } = {}) {
  const results = [];
  for (const group of bootstrapSummary?.groups ?? []) {
    for (const topic of group.topics ?? []) {
      const commandArgs = [
        ...adminBaseArgs(args),
        "cleanup-topic",
        "--chat-id",
        String(group.botApiChatId),
        "--topic-id",
        String(topic.topicId),
        "--bridge-state",
        args.bridgeStatePath,
        "--scan-limit",
        String(args.cleanupScanLimit),
        "--all-visible",
      ];
      if (!dryRun) {
        commandArgs.push("--delete");
      }
      results.push(await runJsonCommand(python, commandArgs, { timeoutMs: 240_000 }));
    }
  }
  return results;
}

function firstBootstrapTopic(bootstrapSummary) {
  for (const group of bootstrapSummary?.groups ?? []) {
    if (group.privateChat || group.surface === "private-chat-topics") {
      continue;
    }
    const topic = group.topics?.[0];
    if (topic?.topicId && group?.botApiChatId) {
      return {
        chatId: group.botApiChatId,
        topicId: topic.topicId,
        title: topic.title,
      };
    }
  }
  return null;
}

async function runSmoke(args, python, bootstrapSummary) {
  const target = firstBootstrapTopic(bootstrapSummary);
  if (!target) {
    throw new Error(
      "no project group topic available for automated smoke; bot-private Codex Chats need `npm run bot:topics -- --smoke --chat-id <user-id>` or a real Telegram UI smoke",
    );
  }
  const sent = await runJsonCommand(python, [
    ...adminBaseArgs(args),
    "send-topic-message",
    "--chat-id",
    String(target.chatId),
    "--topic-id",
    String(target.topicId),
    "--text",
    args.smokeText,
  ]);
  return runJsonCommand(
    python,
    [
      ...adminBaseArgs(args),
      "wait-topic-text",
      "--chat-id",
      String(target.chatId),
      "--topic-id",
      String(target.topicId),
      "--contains",
      args.smokeExpect,
      "--after-message-id",
      String(sent.messageId),
      "--timeout-seconds",
      String(args.smokeTimeoutSeconds),
    ],
    { timeoutMs: (args.smokeTimeoutSeconds + 20) * 1000 },
  );
}

async function shouldRunStep(args, rl, flagValue, question) {
  if (flagValue) {
    return true;
  }
  if (args.yes || args.noInput || !rl) {
    return false;
  }
  return askYesNo(rl, question, false);
}

async function loadSelectedProjects(args) {
  if (args.projects.length) {
    return args.projects.map((projectRoot) => ({ projectRoot }));
  }
  return listRecentProjects(args.threadsDbPath, { limit: args.projectLimit });
}

async function loadProjectsWithThreads(args) {
  const projects = await loadSelectedProjects(args);
  const withThreads = [];
  for (const project of projects) {
    const projectRoot = project.projectRoot;
    const threads = await listProjectThreads(args.threadsDbPath, projectRoot, {
      limit: args.threadsPerProject,
    });
    withThreads.push({
      ...project,
      projectRoot,
      threads,
    });
  }
  return withThreads;
}

async function loadQuickstartProjectsWithThreads(args) {
  const quickstart = await listQuickstartWorkItems(args.threadsDbPath, {
    limit: args.threadLimit,
    globalStatePath: args.codexGlobalStatePath,
  });
  const threads = quickstart.threads;
  const projectsByRoot = new Map();
  const chatThreads = [];
  for (const thread of threads) {
    if (args.includeChats && isLikelyCodexChatThread(thread)) {
      chatThreads.push(thread);
      continue;
    }
    const projectRoot = String(thread.cwd ?? "").trim();
    if (!projectRoot) {
      continue;
    }
    if (!projectsByRoot.has(projectRoot)) {
      projectsByRoot.set(projectRoot, {
        projectRoot,
        threadCount: 0,
        latestUpdatedAt: thread.updated_at ?? null,
        latestUpdatedAtMs: thread.updated_at_ms ?? null,
        threads: [],
      });
    }
    const project = projectsByRoot.get(projectRoot);
    project.threads.push(thread);
    project.threadCount += 1;
    const updatedAtMs = normalizeTimestampMs(thread.updated_at_ms ?? thread.updated_at) ?? 0;
    const latestAtMs = normalizeTimestampMs(project.latestUpdatedAtMs ?? project.latestUpdatedAt) ?? 0;
    if (updatedAtMs > latestAtMs) {
      project.latestUpdatedAt = thread.updated_at ?? project.latestUpdatedAt;
      project.latestUpdatedAtMs = thread.updated_at_ms ?? project.latestUpdatedAtMs;
    }
  }
  return {
    projectsWithThreads: [...projectsByRoot.values()],
    chatThreads,
    pinnedThreadCount: quickstart.selectedPinnedThreadCount,
  };
}

async function buildBootstrapPlanForProjects(projectsWithThreads, args, {
  threadsPerProject = args.threadsPerProject,
  chatThreads = [],
} = {}) {
  const projectPlans = projectsWithThreads.map((project) =>
    buildProjectPlan(project.projectRoot, project.threads ?? [], {
      threadsPerProject,
      groupPrefix: args.groupPrefix ?? undefined,
    }),
  );
  if (args.includeChats && chatThreads.length) {
    const privateChatUserId = await resolvePrivateChatUserId(args);
    if (privateChatUserId) {
      projectPlans.push(
        buildPrivateChatTopicsPlan(chatThreads, {
          chatId: privateChatUserId,
          title: args.chatsSurfaceTitle,
          threadLimit: chatThreads.length,
        }),
      );
    }
  }
  return buildBootstrapPlan(projectPlans, {
    threadsPerProject,
    historyMaxMessages: args.historyMaxMessages,
    historyMaxUserPrompts: args.historyMaxUserPrompts,
    historyAssistantPhases: args.historyAssistantPhases,
    historyIncludeHeartbeats: args.historyIncludeHeartbeats,
    groupPrefix: args.groupPrefix ?? undefined,
    folderTitle: args.folderTitle ?? undefined,
    topicDisplay: args.topicDisplay,
    rehearsal: args.rehearsal,
  });
}

async function commandDoctor(args) {
  const checks = await buildOnboardingChecks(args);
  const ok = checks.filter((check) => check.required).every((check) => check.ok);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok, checks }, null, 2)}\n`);
  } else {
    process.stdout.write("Onboarding doctor:\n");
    process.stdout.write(`${checks.map(renderChecklistItem).map((item) => `- ${item}`).join("\n")}\n`);
    const recoveryPlan = renderRecoveryPlan(checks);
    if (recoveryPlan) {
      process.stdout.write(`\n${recoveryPlan}\n`);
    }
    process.stdout.write(
      ok
        ? "\nLooks good. If Telegram still acts cursed, run self-check next.\n"
        : "\nFix the missing required bits before running the wizard. Saves everyone a weird afternoon.\n",
    );
  }
  if (!ok) {
    process.exitCode = 1;
  }
}

async function commandPrepare(args) {
  const rl = args.noInput ? null : createPrompt();
  try {
    const messages = await prepareLocalSetup(args, rl, { force: true });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ status: "ok", messages }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Local setup prepare:\n${messages.map((message) => `- ${message}`).join("\n")}\n`);
  } finally {
    rl?.close();
  }
}

async function commandScan(args) {
  const projects = await loadProjectsWithThreads(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ projects }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatScanSummary(projects)}\n`);
}

async function commandPlan(args) {
  const projectsWithThreads = await loadProjectsWithThreads(args);
  const projectPlans = projectsWithThreads.map((project) =>
    buildProjectPlan(project.projectRoot, project.threads, {
      threadsPerProject: args.threadsPerProject,
      groupPrefix: args.groupPrefix ?? undefined,
    }),
  );
  const plan = buildBootstrapPlan(projectPlans, {
    threadsPerProject: args.threadsPerProject,
    historyMaxMessages: args.historyMaxMessages,
    historyMaxUserPrompts: args.historyMaxUserPrompts,
    historyAssistantPhases: args.historyAssistantPhases,
    historyIncludeHeartbeats: args.historyIncludeHeartbeats,
    groupPrefix: args.groupPrefix ?? undefined,
    folderTitle: args.folderTitle ?? undefined,
    topicDisplay: args.topicDisplay,
    rehearsal: args.rehearsal,
  });

  if (args.write) {
    await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
    await fs.writeFile(args.outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatBootstrapPlanSummary(plan)}\n`);
  process.stdout.write(`\n${await buildReusePreview(args, plan)}\n`);
  if (args.write) {
    process.stdout.write(`\nWrote ${args.outputPath}\n`);
  } else {
    process.stdout.write(`\nPreview only. Add --write to update ${args.outputPath}.\n`);
  }
}

async function commandQuickstart(args) {
  const rl = args.noInput ? null : createPrompt();
  try {
    if (!args.preview && args.prepare && !args.noPrepare) {
      const messages = await prepareLocalSetup(args, rl, { force: true });
      process.stdout.write(`Local setup prepare:\n${messages.map((message) => `- ${message}`).join("\n")}\n\n`);
    } else if (!args.preview) {
      await maybePrepareForWizard(args, rl);
    }

    await applyConfigDefaults(args);
    const checks = await buildOnboardingChecks(args);
    process.stdout.write("Onboarding checklist:\n");
    process.stdout.write(`${checks.map(renderChecklistItem).map((item) => `- ${item}`).join("\n")}\n\n`);
    const recoveryPlan = renderRecoveryPlan(checks);
    if (recoveryPlan) {
      process.stdout.write(`${recoveryPlan}\n\n`);
    }

    const { projectsWithThreads, chatThreads, pinnedThreadCount } = await loadQuickstartProjectsWithThreads(args);
    const selectedThreadCount = projectsWithThreads.reduce((sum, project) => sum + (project.threads?.length ?? 0), 0);
    const selectedChatCount = chatThreads.length;
    if (!selectedThreadCount && !selectedChatCount) {
      fail("No active Codex threads found. Open Codex Desktop once, then run quickstart again.");
    }
    if (selectedChatCount && !(await resolvePrivateChatUserId(args))) {
      process.stdout.write(
        "Warning: Codex Chats were found, but no private chat user id is configured. Add allowedUserIds or pass --private-chat-user-id to sync them.\n\n",
      );
    }

    const plan = await buildBootstrapPlanForProjects(projectsWithThreads, args, {
      threadsPerProject: Math.max(1, args.threadLimit),
      chatThreads,
    });
    process.stdout.write(
      `Quickstart selected ${selectedThreadCount} project thread(s) and ${selectedChatCount} Codex Chat(s) across ${plan.projects.length} surface(s).\n\n`,
    );
    if (pinnedThreadCount) {
      process.stdout.write(`Included ${pinnedThreadCount} pinned Codex thread(s) before the recent activity tail.\n\n`);
    }
    process.stdout.write(`${formatBootstrapPlanSummary(plan)}\n`);
    process.stdout.write(`\n${await buildReusePreview(args, plan)}\n`);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    }

    const requiredOk = checks.filter((check) => check.required).every((check) => check.ok);
    if (!requiredOk && (args.apply || args.backfill || args.smoke)) {
      fail("Quickstart is blocked by missing required setup. Fix the recovery plan above, then rerun.");
    }

    const shouldWrite = args.write || (await shouldRunStep(args, rl, false, `Write plan to ${args.outputPath}?`));
    if (!shouldWrite) {
      process.stdout.write(`\nPreview only. Add --write to update ${args.outputPath}.\n`);
      return;
    }

    await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
    await fs.writeFile(args.outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    process.stdout.write(`\nWrote ${args.outputPath}\n`);

    const python = await resolveAdminPython(args);
    let bootstrapSummary = null;
    if (await shouldRunStep(args, rl, args.apply, "Run Telegram bootstrap now?")) {
      bootstrapSummary = await runBootstrap(args, python);
      await runBotAvatarPolish(args, python);
    }

    if (await shouldRunStep(args, rl, args.cleanupDryRun, "Run clean rebuild cleanup dry-run now?")) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping cleanup dry-run: bootstrap was not run in this quickstart session.\n");
      } else {
        await runCleanupForSummary(args, python, bootstrapSummary, { dryRun: true });
      }
    }

    if (await shouldRunStep(args, rl, args.cleanup, "Delete visible topic messages for clean rebuild now?")) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping cleanup: bootstrap was not run in this quickstart session.\n");
      } else {
        process.stdout.write("Running cleanup dry-run first because deleting Telegram messages deserves one last look.\n");
        await runCleanupForSummary(args, python, bootstrapSummary, { dryRun: true });
        await runCleanupForSummary(args, python, bootstrapSummary, { dryRun: false });
      }
    }

    if (await shouldRunStep(args, rl, args.backfillDryRun, "Run clean history backfill dry-run now?")) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping backfill dry-run: bootstrap was not run in this quickstart session.\n");
      } else {
        await runBackfillForSummary(args, python, bootstrapSummary, { dryRun: true });
      }
    }

    if (await shouldRunStep(args, rl, args.backfill, "Send clean history backfill now?")) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping backfill: bootstrap was not run in this quickstart session.\n");
      } else {
        await runBackfillForSummary(args, python, bootstrapSummary, { dryRun: false });
      }
    }

    if (await shouldRunStep(args, rl, args.smoke, "Send and wait for Telegram smoke now?")) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping smoke: bootstrap was not run in this quickstart session.\n");
      } else {
        await runSmoke(args, python, bootstrapSummary);
      }
    }

    process.stdout.write(`\nOnboarding quickstart finished.\n${renderPostOnboardingRuntimeNote({ configPath: args.configPath })}`);
  } finally {
    rl?.close();
  }
}

async function chooseProjectsForWizard(args, rl, projectsWithThreads) {
  if (!projectsWithThreads.length) {
    fail("No active Codex projects found.");
  }
  if (args.projects.length) {
    return projectsWithThreads;
  }
  if (args.noInput || !rl) {
    return [projectsWithThreads[0]];
  }
  printProjectChoices(projectsWithThreads);
  const fallback = [0];
  const answer = await askLine(
    rl,
    "Select projects by number, comma, or range",
    fallback.map((index) => index + 1).join(","),
  );
  const selectedIndexes = parseSelection(answer, projectsWithThreads.length, fallback);
  return selectedIndexes.map((index) => projectsWithThreads[index]);
}

async function chooseThreadsForWizard(args, rl, project) {
  const threads = project.threads ?? [];
  if (!threads.length) {
    return [];
  }
  const fallbackIndexes = Array.from(
    { length: Math.min(args.threadsPerProject, threads.length) },
    (_, index) => index,
  );
  if (args.noInput || !rl) {
    return fallbackIndexes.map((index) => threads[index]);
  }
  process.stdout.write(`\nThreads for ${project.projectRoot}:\n`);
  for (const [index, thread] of threads.entries()) {
    process.stdout.write(`${index + 1}. ${sanitizeThreadTitle(thread)} (${thread.id})\n`);
  }
  const answer = await askLine(
    rl,
    "Select topics/threads for this Telegram group",
    fallbackIndexes.map((index) => index + 1).join(","),
  );
  const selectedIndexes = parseSelection(answer, threads.length, fallbackIndexes);
  return selectedIndexes.map((index) => threads[index]);
}

async function commandWizard(args) {
  const rl = args.noInput ? null : createPrompt();
  try {
    await maybePrepareForWizard(args, rl);
    await applyConfigDefaults(args);
    const checks = await buildOnboardingChecks(args);
    const checklist = checks.map(renderChecklistItem);
    process.stdout.write("Onboarding checklist:\n");
    process.stdout.write(`${checklist.map((item) => `- ${item}`).join("\n")}\n\n`);
    const recoveryPlan = renderRecoveryPlan(checks);
    if (recoveryPlan) {
      process.stdout.write(`${recoveryPlan}\n\n`);
    }

    const projectsWithThreads = await loadProjectsWithThreads(args);
    const selectedProjects = await chooseProjectsForWizard(args, rl, projectsWithThreads);
    const projectPlans = [];
    for (const project of selectedProjects) {
      const selectedThreads = await chooseThreadsForWizard(args, rl, project);
      if (!selectedThreads.length) {
        continue;
      }
      projectPlans.push(
        buildProjectPlan(project.projectRoot, selectedThreads, {
          threadsPerProject: selectedThreads.length,
          groupPrefix: args.groupPrefix ?? undefined,
        }),
      );
    }

    const plan = buildBootstrapPlan(projectPlans, {
      threadsPerProject: args.threadsPerProject,
      historyMaxMessages: args.historyMaxMessages,
      historyMaxUserPrompts: args.historyMaxUserPrompts,
      historyAssistantPhases: args.historyAssistantPhases,
      historyIncludeHeartbeats: args.historyIncludeHeartbeats,
      groupPrefix: args.groupPrefix ?? undefined,
      folderTitle: args.folderTitle ?? undefined,
      topicDisplay: args.topicDisplay,
      rehearsal: args.rehearsal,
    });

    process.stdout.write(`\n${formatBootstrapPlanSummary(plan)}\n`);
    process.stdout.write(`\n${await buildReusePreview(args, plan)}\n`);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    }

    const shouldWrite = args.write || (await shouldRunStep(args, rl, false, `Write plan to ${args.outputPath}?`));
    if (!shouldWrite) {
      process.stdout.write(`\nPreview only. Add --write to update ${args.outputPath}.\n`);
      return;
    }

    await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
    await fs.writeFile(args.outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    process.stdout.write(`\nWrote ${args.outputPath}\n`);

    const python = await resolveAdminPython(args);
    let bootstrapSummary = null;
    if (await shouldRunStep(args, rl, args.apply, "Run Telegram bootstrap now?")) {
      bootstrapSummary = await runBootstrap(args, python);
    }

    let cleanupPreviewRan = false;
    const shouldCleanupDryRun = await shouldRunStep(
      args,
      rl,
      args.cleanupDryRun || args.cleanup,
      "Run clean rebuild cleanup dry-run now?",
    );
    if (shouldCleanupDryRun) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping cleanup dry-run: bootstrap was not run in this wizard session.\n");
      } else {
        await runCleanupForSummary(args, python, bootstrapSummary, { dryRun: true });
        cleanupPreviewRan = true;
      }
    }

    const shouldCleanup = await shouldRunStep(
      args,
      rl,
      args.cleanup,
      "Delete visible topic messages for clean rebuild now?",
    );
    if (shouldCleanup) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping cleanup: bootstrap was not run in this wizard session.\n");
      } else {
        if (!cleanupPreviewRan) {
          process.stdout.write("Running cleanup dry-run first because deleting Telegram messages deserves one last look.\n");
          await runCleanupForSummary(args, python, bootstrapSummary, { dryRun: true });
        }
        await runCleanupForSummary(args, python, bootstrapSummary, { dryRun: false });
      }
    }

    const shouldBackfillDryRun = await shouldRunStep(
      args,
      rl,
      args.backfillDryRun,
      "Run clean history backfill dry-run now?",
    );
    if (shouldBackfillDryRun) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping backfill dry-run: bootstrap was not run in this wizard session.\n");
      } else {
        await runBackfillForSummary(args, python, bootstrapSummary, { dryRun: true });
      }
    }

    const shouldBackfill = await shouldRunStep(args, rl, args.backfill, "Send clean history backfill now?");
    if (shouldBackfill) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping backfill: bootstrap was not run in this wizard session.\n");
      } else {
        await runBackfillForSummary(args, python, bootstrapSummary, { dryRun: false });
      }
    }

    if (await shouldRunStep(args, rl, args.smoke, "Send and wait for Telegram smoke now?")) {
      if (!bootstrapSummary) {
        process.stdout.write("Skipping smoke: bootstrap was not run in this wizard session.\n");
      } else {
        await runSmoke(args, python, bootstrapSummary);
      }
    }

    process.stdout.write(`\nOnboarding wizard finished.\n${renderPostOnboardingRuntimeNote({ configPath: args.configPath })}`);
  } finally {
    rl?.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.help) {
    process.stdout.write(`${renderHelp()}\n`);
    return;
  }
  await applyConfigDefaults(args);
  if (args.command === "prepare") {
    await commandPrepare(args);
    return;
  }
  if (args.command === "scan") {
    await commandScan(args);
    return;
  }
  if (args.command === "doctor") {
    await commandDoctor(args);
    return;
  }
  if (args.command === "plan") {
    await commandPlan(args);
    return;
  }
  if (args.command === "quickstart") {
    await commandQuickstart(args);
    return;
  }
  if (args.command === "wizard") {
    await commandWizard(args);
    return;
  }
  fail(`unknown command: ${args.command}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
