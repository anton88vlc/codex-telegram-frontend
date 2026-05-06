#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  formatBridgeEventReport,
  readRecentBridgeEvents,
  summarizeBridgeEvents,
} from "../lib/bridge-events.mjs";
import { loadConfig } from "../lib/config.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.local.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG_PATH,
    limit: 200,
    tailBytes: 512 * 1024,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        args.configPath = argv[++index];
        break;
      case "--limit":
        args.limit = Number(argv[++index]);
        break;
      case "--tail-bytes":
        args.tailBytes = Number(argv[++index]);
        break;
      case "--json":
        args.json = true;
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

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/event_log_report.mjs [--config config.local.json] [--limit 200] [--json]",
      "",
      "Reads the structured bridge event log and prints a compact operator report.",
    ].join("\n") + "\n",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = await loadConfig(args.configPath);
  const logPath = config.eventLogPath || config.bridgeLogPath;
  const events = await readRecentBridgeEvents(logPath, {
    limit: Number.isFinite(args.limit) ? args.limit : 200,
    tailBytes: Number.isFinite(args.tailBytes) ? args.tailBytes : 512 * 1024,
  });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          path: logPath,
          sampled: events.length,
          summary: summarizeBridgeEvents(events),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${formatBridgeEventReport(events, { logPath })}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
