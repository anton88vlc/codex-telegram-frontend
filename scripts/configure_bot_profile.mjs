#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  applyBotInstallPolish,
  buildBotInstallPolishPlan,
  formatBotInstallPolishPlan,
} from "../lib/bot-install-polish.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.local.json");
const DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE = "codex-telegram-bridge-bot-token";
const execFileAsync = promisify(execFile);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG_PATH,
    apply: false,
    json: false,
    includeCommands: true,
    includeProfile: true,
    includeMenuButton: true,
    includeDefaultAdminRights: true,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        args.configPath = argv[++index];
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--skip-commands":
        args.includeCommands = false;
        break;
      case "--skip-profile":
        args.includeProfile = false;
        break;
      case "--skip-menu-button":
        args.includeMenuButton = false;
        break;
      case "--skip-default-admin-rights":
        args.includeDefaultAdminRights = false;
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
      "  node scripts/configure_bot_profile.mjs [--config config.local.json] [--apply] [--json]",
      "",
      "Without --apply this only prints the Bot API changes it would make.",
      "Useful skip flags: --skip-commands, --skip-profile, --skip-menu-button, --skip-default-admin-rights.",
    ].join("\n") + "\n",
  );
}

async function readJsonIfExists(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function readKeychainSecret(serviceName) {
  if (process.platform !== "darwin" || !serviceName) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      String(serviceName),
      "-w",
    ]);
    return String(stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

async function loadBotToken(configPath) {
  const config = await readJsonIfExists(configPath, {});
  const botTokenEnv = config.botTokenEnv || "CODEX_TELEGRAM_BOT_TOKEN";
  const keychainService = config.botTokenKeychainService || DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE;
  const envBotToken = process.env[botTokenEnv] || null;
  const configBotToken = config.botToken || null;
  const keychainBotToken = envBotToken || configBotToken ? null : await readKeychainSecret(keychainService);
  const botToken = envBotToken || configBotToken || keychainBotToken || null;
  if (!botToken) {
    fail(`missing Telegram bot token; set ${botTokenEnv}, botToken, or Keychain item ${keychainService}`);
  }
  return botToken;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const plan = buildBotInstallPolishPlan(args);
  if (!args.apply) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ apply: false, plan }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatBotInstallPolishPlan(plan)}\n\nRun with --apply to update the Telegram bot.\n`);
    }
    return;
  }

  const token = await loadBotToken(args.configPath);
  const result = await applyBotInstallPolish(token, plan, { dryRun: false });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Applied ${result.operations.length} Telegram bot polish operation(s).\n`);
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
