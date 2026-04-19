#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
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
const DEFAULT_ADMIN_ENV_PATH = path.join(PROJECT_ROOT, "admin", ".env");
const DEFAULT_ADMIN_SESSION_PATH = path.join(PROJECT_ROOT, "state", "telegram_user.session");
const DEFAULT_BRIDGE_STATE_PATH = path.join(PROJECT_ROOT, "state", "state.json");
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
    "  node scripts/onboard.mjs doctor [--json]",
    "  node scripts/onboard.mjs scan [--project-limit 8] [--threads-per-project 3] [--json]",
    "  node scripts/onboard.mjs plan --project /path/to/repo [--project /path/to/other] [--threads-per-project 3] [--history-max-messages 40] [--history-assistant-phase final_answer] [--group-prefix 'Codex - '] [--folder-title codex] [--topic-display tabs|list] [--write]",
    "  node scripts/onboard.mjs plan --rehearsal --project /path/to/repo [--write]",
    "  node scripts/onboard.mjs wizard [--rehearsal] [--write] [--apply] [--cleanup-dry-run|--cleanup] [--backfill-dry-run|--backfill] [--smoke]",
    "  npm run codex:launch",
    "",
    "Notes:",
    "  doctor checks local prerequisites before the wizard gets creative.",
    "  codex:launch starts Codex.app with the app-control debug port when it is not already open.",
    "  scan is read-only and shows candidate Codex projects/threads.",
    "  plan is a preview by default; add --write to update admin/bootstrap-plan.json.",
    "  wizard is interactive by default and keeps Telegram side effects behind explicit confirmation or flags.",
    "  history import defaults come from config.local.json unless a history flag overrides them.",
    "  --cleanup-dry-run previews a clean rebuild for bootstrapped topics; --cleanup deletes visible topic messages except protected root/status ids.",
    "  --rehearsal writes admin/bootstrap-plan.rehearsal.json by default and uses codex-lab/Codex Lab naming.",
    "  bootstrap/apply is still handled by admin/telegram_user_admin.py bootstrap.",
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

function makeCheck(label, ok, detail = "", { required = true } = {}) {
  return {
    label,
    ok: Boolean(ok),
    detail,
    required,
  };
}

function renderChecklistItem(check) {
  const status = check.ok ? "[ok]" : check.required ? "[missing]" : "[warn]";
  return `${status} ${check.label}${check.detail ? ` - ${check.detail}` : ""}`;
}

async function buildOnboardingChecks(args) {
  const config = await readJsonIfExists(args.configPath, {});
  const botTokenEnv = config.botTokenEnv || "CODEX_TELEGRAM_BOT_TOKEN";
  const keychainService = config.botTokenKeychainService || DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE;
  const nativeDebugBaseUrl = config.nativeDebugBaseUrl || DEFAULT_NATIVE_DEBUG_BASE_URL;
  const configHasBotToken = Boolean(process.env[botTokenEnv] || config.botToken);
  const [configOk, envOk, helperOk, adminPythonOk, sessionOk, threadsDbOk, codexAppOk, botTokenOk, appControl] =
    await Promise.all([
      pathExists(args.configPath),
      pathExists(args.adminEnvPath),
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
    makeCheck("macOS host", process.platform === "darwin", process.platform),
    makeCheck("Codex.app", codexAppOk, "/Applications/Codex.app/Contents/MacOS/Codex"),
    makeCheck("config.local.json", configOk, args.configPath),
    makeCheck("admin .env with Telegram API_ID/API_HASH", envOk, args.adminEnvPath),
    makeCheck("Telethon helper", helperOk, args.adminHelperPath),
    makeCheck("admin Python venv", adminPythonOk, args.adminPythonPath),
    makeCheck("authorized Telegram user session", sessionOk, args.adminSessionPath),
    makeCheck("local Codex threads DB", threadsDbOk, args.threadsDbPath),
    makeCheck("Telegram bot token", botTokenOk, `${botTokenEnv}, config, or Keychain service ${keychainService}`),
    makeCheck(
      "app-control debug port",
      appControlOk,
      appControlOk ? nativeDebugBaseUrl : `${nativeDebugBaseUrl}; run npm run codex:launch`,
      { required: false },
    ),
  ];
}

async function buildOnboardingChecklist(args) {
  return (await buildOnboardingChecks(args)).map(renderChecklistItem);
}

function printProjectChoices(projects) {
  process.stdout.write("Candidate projects:\n");
  for (const [index, project] of projects.entries()) {
    process.stdout.write(`${index + 1}. ${project.projectRoot} (${project.threadCount ?? project.threads?.length ?? 0} threads)\n`);
    for (const [threadIndex, thread] of (project.threads ?? []).slice(0, 5).entries()) {
      process.stdout.write(`   ${threadIndex + 1}. ${sanitizeThreadTitle(thread)} (${thread.id})\n`);
    }
  }
}

function sanitizeThreadTitle(thread) {
  return String(thread?.title || thread?.id || "thread").replace(/\s+/g, " ").trim();
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
    const checklist = await buildOnboardingChecklist(args);
    process.stdout.write("Onboarding checklist:\n");
    process.stdout.write(`${checklist.map((item) => `- ${item}`).join("\n")}\n\n`);

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
