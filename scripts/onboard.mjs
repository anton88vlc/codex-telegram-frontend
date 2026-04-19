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
  buildProjectPlan,
  DEFAULT_HISTORY_ASSISTANT_PHASES,
  DEFAULT_HISTORY_INCLUDE_HEARTBEATS,
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_MAX_USER_PROMPTS,
  DEFAULT_REHEARSAL_FOLDER_TITLE,
  DEFAULT_REHEARSAL_GROUP_PREFIX,
  DEFAULT_TOPIC_DISPLAY,
  formatBootstrapPlanSummary,
  formatScanSummary,
} from "../lib/onboarding-plan.mjs";
import { DEFAULT_APP_CONTROL_BASE_URL, checkAppControl } from "../lib/app-control-launcher.mjs";
import { listProjectThreads, listRecentProjects, parsePositiveInt } from "../lib/thread-db.mjs";

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
const DEFAULT_NATIVE_DEBUG_BASE_URL = DEFAULT_APP_CONTROL_BASE_URL;
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
    threadsPerProject: 3,
    historyMaxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
    historyMaxUserPrompts: DEFAULT_HISTORY_MAX_USER_PROMPTS,
    historyAssistantPhases: [...DEFAULT_HISTORY_ASSISTANT_PHASES],
    historyIncludeHeartbeats: DEFAULT_HISTORY_INCLUDE_HEARTBEATS,
    groupPrefix: null,
    folderTitle: null,
    topicDisplay: DEFAULT_TOPIC_DISPLAY,
    threadsDbPath: DEFAULT_THREADS_DB_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    json: false,
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
    loginQr: false,
    _projectLimitExplicit: false,
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
      case "--threads-per-project":
        args.threadsPerProject = parsePositiveInt(rest[++index], args.threadsPerProject);
        args._threadsPerProjectExplicit = true;
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
      case "--output":
        args.outputPath = rest[++index];
        args._outputPathExplicit = true;
        break;
      case "--json":
        args.json = true;
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
      case "--login-qr":
        args.loginQr = true;
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

  return args;
}

function renderHelp() {
  return [
    "Usage:",
    "  node scripts/onboard.mjs prepare [--skip-admin-deps] [--login-qr]",
    "  node scripts/onboard.mjs doctor [--json]",
    "  node scripts/onboard.mjs scan [--project-limit 8] [--threads-per-project 3] [--json]",
    "  node scripts/onboard.mjs plan --project /path/to/repo [--project /path/to/other] [--threads-per-project 3] [--history-max-messages 40] [--history-assistant-phase final_answer] [--group-prefix 'Codex - '] [--folder-title codex] [--topic-display tabs|list] [--write]",
    "  node scripts/onboard.mjs plan --rehearsal --project /path/to/repo [--write]",
    "  node scripts/onboard.mjs wizard [--rehearsal] [--write] [--apply] [--cleanup-dry-run|--cleanup] [--backfill-dry-run|--backfill] [--smoke]",
    "  npm run codex:launch",
    "",
    "Notes:",
    "  preferred public setup is agent-led: ask Codex to run doctor, prepare local config, then drive the wizard.",
    "  prepare creates missing local config/admin env files, can create the admin venv, and can guide credential/session setup.",
    "  doctor checks local prerequisites before the wizard gets creative.",
    "  codex:launch starts Codex.app with the app-control debug port when it is not already open.",
    "  scan is read-only and shows candidate Codex projects/threads.",
    "  plan is a preview by default; add --write to update admin/bootstrap-plan.json.",
    "  wizard is interactive by default and can write/apply/backfill/smoke with explicit confirmation or flags.",
    "  history import defaults come from config.local.json unless a history flag overrides them.",
    "  --cleanup-dry-run previews a clean rebuild for bootstrapped topics; --cleanup deletes visible topic messages except protected root/status ids.",
    "  --rehearsal writes admin/bootstrap-plan.rehearsal.json by default and uses codex-lab/Codex Lab naming.",
    "  lower-level admin/telegram_user_admin.py commands are escape hatches, not the normal install story.",
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
  const botTokenEnv = config.botTokenEnv || "CODEX_TELEGRAM_BOT_TOKEN";
  const keychainService = config.botTokenKeychainService || DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE;
  return Boolean(process.env[botTokenEnv] || config.botToken || (await keychainHasSecret(keychainService)));
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
  const botTokenEnv = config.botTokenEnv || "CODEX_TELEGRAM_BOT_TOKEN";
  const keychainService = config.botTokenKeychainService || DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE;
  const nativeDebugBaseUrl = config.nativeDebugBaseUrl || DEFAULT_NATIVE_DEBUG_BASE_URL;
  const configHasBotToken = Boolean(process.env[botTokenEnv] || config.botToken);
  const envFileOk = await pathExists(args.adminEnvPath);
  const envOk = envFileOk && hasRealEnvValue(envValues, "API_ID") && hasRealEnvValue(envValues, "API_HASH");
  const envDetail = envFileOk ? `${args.adminEnvPath} (API_ID/API_HASH required)` : args.adminEnvPath;
  const [configOk, helperOk, adminPythonOk, sessionOk, threadsDbOk, codexAppOk, botTokenOk, appControl] =
    await Promise.all([
      pathExists(args.configPath),
      pathExists(args.adminHelperPath),
      pathExists(args.adminPythonPath),
      pathExists(args.adminSessionPath),
      pathExists(args.threadsDbPath),
      pathExists("/Applications/Codex.app/Contents/MacOS/Codex"),
      configHasBotToken ? Promise.resolve(true) : keychainHasSecret(keychainService),
      checkAppControl(nativeDebugBaseUrl),
    ]);
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
    makeCheck("admin .env with Telegram API_ID/API_HASH", envOk, envDetail, {
      action: "Run `npm run onboard:prepare` and paste Telegram API_ID/API_HASH from my.telegram.org when asked.",
    }),
    makeCheck("Telethon helper", helperOk, args.adminHelperPath, {
      action: "Restore the repo files; admin/telegram_user_admin.py is required for folder/group/topic bootstrap.",
    }),
    makeCheck("admin Python venv", adminPythonOk, args.adminPythonPath, {
      action: "Run `npm run onboard:prepare` without `--skip-admin-deps` to create the admin Python venv.",
    }),
    makeCheck("authorized Telegram user session", sessionOk, args.adminSessionPath, {
      action: "Run `npm run onboard:prepare -- --login-qr` and authorize the local Telegram user session.",
    }),
    makeCheck("local Codex threads DB", threadsDbOk, args.threadsDbPath, {
      action: "Open Codex Desktop locally at least once; the wizard needs the local Codex threads DB.",
    }),
    makeCheck("Telegram bot token", botTokenOk, `${botTokenEnv}, config, or Keychain service ${keychainService}`, {
      action: "Create/reuse a bot with @BotFather, then let `npm run onboard:prepare` store the token locally.",
    }),
    makeCheck(
      "app-control debug port",
      appControlOk,
      appControlOk ? nativeDebugBaseUrl : `${nativeDebugBaseUrl}; run npm run codex:launch`,
      {
        required: false,
        action: "Run `npm run codex:launch` for the best live Telegram <-> Codex Desktop UX.",
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
  const apiMissing = !envValues.API_ID || !envValues.API_HASH;
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

async function maybeRunLoginQr(args, rl, python) {
  if (await pathExists(args.adminSessionPath)) {
    return null;
  }
  const shouldLogin = args.loginQr || (rl && !args.noInput && (await askYesNo(rl, "Authorize Telegram user session with QR login now?", false)));
  if (!shouldLogin) {
    return null;
  }
  await runPlainCommand(python, [...adminBaseArgs(args), "login-qr"], { cwd: PROJECT_ROOT });
  return `authorized Telegram user session: ${args.adminSessionPath}`;
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
  const loginMessage = await maybeRunLoginQr(args, rl, python);
  if (loginMessage) {
    messages.push(loginMessage);
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

function findExistingGroup(projectIndex, projectPlan) {
  const groups = Array.isArray(projectIndex?.groups) ? projectIndex.groups : [];
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
      lines.push(`- group ${project.groupTitle}: reuse ${existingGroup.botApiChatId ?? existingGroup.groupId ?? "known group"}`);
    } else {
      lines.push(`- group ${project.groupTitle}: create or reuse by Telegram title`);
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
      results.push(await runJsonCommand(python, commandArgs, { timeoutMs: 240_000 }));
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
    throw new Error("no bootstrap topic available for smoke");
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

    process.stdout.write("\nOnboarding wizard finished.\n");
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
  if (args.command === "wizard") {
    await commandWizard(args);
    return;
  }
  fail(`unknown command: ${args.command}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
