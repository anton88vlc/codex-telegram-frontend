#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  applyStateDoctorActions,
  formatStateDoctorReport,
  inspectStateDoctor,
  loadStateDoctorInputs,
  writeStateDoctorProjectIndex,
} from "../lib/state-doctor.mjs";
import { loadState, saveState } from "../lib/state.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.local.json");
const DEFAULT_STATE_PATH = path.join(PROJECT_ROOT, "state", "state.json");
const DEFAULT_PROJECT_INDEX_PATH = path.join(PROJECT_ROOT, "state", "bootstrap-result.json");
const DEFAULT_THREADS_DB_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");
const DEFAULT_EVENT_LOG_PATH = path.join(PROJECT_ROOT, "logs", "bridge.events.ndjson");
const DEFAULT_BRIDGE_LOG_PATH = path.join(PROJECT_ROOT, "logs", "bridge.stderr.log");

function usage() {
  return [
    "Usage: node scripts/state_doctor.mjs [--config path] [--apply] [--json]",
    "",
    "Checks local bridge state and bootstrap index for stale bindings, dead topics, duplicate surfaces and orphan mirror state.",
    "--apply only writes local state/index repairs. It never deletes Telegram messages.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG_PATH,
    apply: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--config") {
      args.configPath = argv[++index] || args.configPath;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readJsonIfExists(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function resolveProjectPath(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw) {
    return raw;
  }
  return path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
}

function loadLocalConfig(configPath) {
  const fromFile = readJsonIfExists(configPath, {});
  return {
    statePath: resolveProjectPath(fromFile.statePath, DEFAULT_STATE_PATH),
    projectIndexPath: resolveProjectPath(fromFile.projectIndexPath, DEFAULT_PROJECT_INDEX_PATH),
    threadsDbPath: resolveProjectPath(fromFile.threadsDbPath, DEFAULT_THREADS_DB_PATH),
    eventLogPath: resolveProjectPath(fromFile.eventLogPath, DEFAULT_EVENT_LOG_PATH),
    bridgeLogPath: resolveProjectPath(fromFile.bridgeLogPath, DEFAULT_BRIDGE_LOG_PATH),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const config = loadLocalConfig(args.configPath);
  const state = await loadState(config.statePath);
  const report = await inspectStateDoctor({ config, state });
  let applied = null;
  let afterReport = null;

  if (args.apply && report.actions.length) {
    const inputs = await loadStateDoctorInputs(config, state);
    applied = applyStateDoctorActions({
      state,
      projectIndex: inputs.projectIndex,
      actions: report.actions,
    });
    await saveState(config.statePath, applied.state);
    await writeStateDoctorProjectIndex(config.projectIndexPath, applied.projectIndex);
    afterReport = await inspectStateDoctor({ config, state: applied.state });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ report, applied, afterReport }, null, 2)}\n`);
    return;
  }

  const text = [formatStateDoctorReport(report, { applied })];
  if (afterReport) {
    text.push("", "After repair:", formatStateDoctorReport(afterReport));
  }
  process.stdout.write(`${text.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
