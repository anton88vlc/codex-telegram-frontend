#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildBootstrapPlan,
  buildProjectPlan,
  DEFAULT_REHEARSAL_FOLDER_TITLE,
  DEFAULT_REHEARSAL_GROUP_PREFIX,
  DEFAULT_TOPIC_DISPLAY,
  formatBootstrapPlanSummary,
  formatScanSummary,
} from "../lib/onboarding-plan.mjs";
import { listProjectThreads, listRecentProjects, parsePositiveInt } from "../lib/thread-db.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_THREADS_DB_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, "admin", "bootstrap-plan.json");
const DEFAULT_REHEARSAL_OUTPUT_PATH = path.join(PROJECT_ROOT, "admin", "bootstrap-plan.rehearsal.json");

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
    historyMaxMessages: 40,
    groupPrefix: null,
    folderTitle: null,
    topicDisplay: DEFAULT_TOPIC_DISPLAY,
    threadsDbPath: DEFAULT_THREADS_DB_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    json: false,
    rehearsal: false,
    write: false,
    _projectLimitExplicit: false,
    _threadsPerProjectExplicit: false,
    _historyMaxMessagesExplicit: false,
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
    "  node scripts/onboard.mjs scan [--project-limit 8] [--threads-per-project 3] [--json]",
    "  node scripts/onboard.mjs plan --project /path/to/repo [--project /path/to/other] [--threads-per-project 3] [--group-prefix 'Codex - '] [--folder-title codex] [--topic-display tabs|list] [--write]",
    "  node scripts/onboard.mjs plan --rehearsal --project /path/to/repo [--write]",
    "",
    "Notes:",
    "  scan is read-only and shows candidate Codex projects/threads.",
    "  plan is a preview by default; add --write to update admin/bootstrap-plan.json.",
    "  --rehearsal writes admin/bootstrap-plan.rehearsal.json by default and uses codex-lab/Codex Lab naming.",
    "  bootstrap/apply is still handled by admin/telegram_user_admin.py bootstrap.",
  ].join("\n");
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.help) {
    process.stdout.write(`${renderHelp()}\n`);
    return;
  }
  if (args.command === "scan") {
    await commandScan(args);
    return;
  }
  if (args.command === "plan") {
    await commandPlan(args);
    return;
  }
  fail(`unknown command: ${args.command}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
