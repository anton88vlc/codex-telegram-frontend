#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_APP_CONTROL_BASE_URL,
  DEFAULT_CODEX_APP_BINARY,
  checkAppControl,
  isCodexAppRunning,
  launchCodexAppControl,
  normalizeAppControlBaseUrl,
  pathExists,
  waitForAppControl,
} from "../lib/app-control-launcher.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.local.json");

function fail(message, code = 1, { json = false, extra = {} } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message, ...extra }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG_PATH,
    baseUrl: process.env.CODEX_REMOTE_DEBUG_URL || null,
    binaryPath: DEFAULT_CODEX_APP_BINARY,
    waitMs: 15_000,
    dryRun: false,
    json: false,
    launchEvenIfRunning: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        args.configPath = argv[++index];
        break;
      case "--debug-base-url":
        args.baseUrl = argv[++index];
        break;
      case "--binary":
        args.binaryPath = argv[++index];
        break;
      case "--wait-ms":
        args.waitMs = Number.parseInt(argv[++index], 10);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--launch-even-if-running":
        args.launchEvenIfRunning = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function renderHelp() {
  return [
    "Usage:",
    "  node scripts/launch_codex_app_control.mjs [--config config.local.json] [--debug-base-url http://127.0.0.1:9222]",
    "",
    "Behavior:",
    "  - If app-control is already reachable, exits cleanly.",
    "  - If Codex.app is already running without app-control, refuses to kill it.",
    "  - If Codex.app is not running, launches it with --remote-debugging-port.",
    "",
    "Options:",
    "  --binary /path/to/Codex                 Override Codex.app binary.",
    "  --wait-ms 15000                         Wait for app-control after launch.",
    "  --dry-run                               Print what would run.",
    "  --json                                  Machine-readable output.",
    "  --launch-even-if-running                Try anyway when Codex.app is already running.",
  ].join("\n");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${renderHelp()}\n`);
    return;
  }

  const config = await readJsonIfExists(args.configPath);
  const baseUrl = normalizeAppControlBaseUrl(args.baseUrl || config.nativeDebugBaseUrl || DEFAULT_APP_CONTROL_BASE_URL);
  const binaryPath = args.binaryPath || DEFAULT_CODEX_APP_BINARY;

  const existing = await checkAppControl(baseUrl);
  if (existing.ok) {
    const result = {
      ok: true,
      state: "already_reachable",
      baseUrl,
      targetCount: existing.targetCount,
    };
    process.stdout.write(
      args.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `app-control is already reachable at ${baseUrl}${Number.isFinite(existing.targetCount) ? ` (${existing.targetCount} targets)` : ""}.\n`,
    );
    return;
  }

  if (!(await pathExists(binaryPath))) {
    fail(`Codex.app binary was not found at ${binaryPath}. Install Codex.app first.`, 1, {
      json: args.json,
      extra: { state: "missing_codex_app", binaryPath, baseUrl },
    });
  }

  const running = await isCodexAppRunning();
  if (running && !args.launchEvenIfRunning) {
    fail(
      [
        `Codex.app is already running, but app-control is not reachable at ${baseUrl}.`,
        "Close Codex.app, then run this repo helper again, or launch Codex directly with `/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222`.",
        "Not killing it automatically. That kind of convenience is how ghosts are born.",
      ].join("\n"),
      2,
      {
        json: args.json,
        extra: { state: "running_without_app_control", baseUrl, binaryPath },
      },
    );
  }

  const launch = await launchCodexAppControl({
    binaryPath,
    baseUrl,
    dryRun: args.dryRun,
  });
  if (args.dryRun) {
    const result = { ok: true, state: "dry_run", baseUrl, ...launch };
    process.stdout.write(
      args.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Would run: ${launch.command} ${launch.args.join(" ")}\n`,
    );
    return;
  }

  if (!args.json) {
    process.stdout.write(`Launching Codex.app with app-control at ${baseUrl}...\n`);
  }
  const ready = await waitForAppControl(baseUrl, { timeoutMs: args.waitMs });
  if (!ready.ok) {
    fail(`Launched Codex.app, but app-control did not become reachable at ${baseUrl}.`, 3, {
      json: args.json,
      extra: {
        state: "launch_timeout",
        baseUrl,
        launch,
        lastCheck: ready.check,
      },
    });
  }

  const result = {
    ok: true,
    state: "launched",
    baseUrl,
    launch,
    elapsedMs: ready.elapsedMs,
  };
  process.stdout.write(
    args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `app-control is ready at ${baseUrl} (${ready.elapsedMs}ms).\n`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
