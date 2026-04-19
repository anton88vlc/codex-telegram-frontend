#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  formatBotPrivateTopicReadiness,
  isPrivateTopicModeMissingError,
  normalizeBotPrivateTopicReadiness,
} from "../lib/bot-private-topics.mjs";
import { createForumTopic, deleteForumTopic, getMe } from "../lib/telegram.mjs";

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
    chatId: null,
    smoke: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        args.configPath = argv[++index];
        break;
      case "--chat-id":
        args.chatId = argv[++index];
        break;
      case "--smoke":
        args.smoke = true;
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
  process.stdout.write(`Usage:
  npm run bot:topics
  npm run bot:topics -- --smoke --chat-id <telegram-user-id>

Checks whether the bot has private chat topic mode enabled. The optional smoke
creates and deletes one temporary topic in the bot direct chat.
`);
}

async function readJsonIfExists(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
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

async function runSmoke(token, { chatId }) {
  if (!chatId) {
    throw new Error("--smoke requires --chat-id <telegram-user-id>");
  }
  const topicName = `Codex private topic smoke ${new Date().toISOString().slice(11, 19)}`;
  const topic = await createForumTopic(token, {
    chatId,
    name: topicName,
  });
  const messageThreadId = topic?.message_thread_id;
  if (!messageThreadId) {
    throw new Error("Telegram did not return message_thread_id for the private topic smoke");
  }
  await deleteForumTopic(token, {
    chatId,
    messageThreadId,
  });
  return {
    created: true,
    deleted: true,
    chatId: String(chatId),
    messageThreadId,
    topicName,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const token = await loadBotToken(args.configPath);
  const profile = await getMe(token);
  const readiness = normalizeBotPrivateTopicReadiness(profile);
  let smoke = null;
  let smokeError = null;

  if (args.smoke) {
    try {
      smoke = await runSmoke(token, { chatId: args.chatId });
    } catch (error) {
      smokeError = error instanceof Error ? error.message : String(error);
      if (isPrivateTopicModeMissingError(error)) {
        readiness.ok = false;
        readiness.hasTopicsEnabled = false;
      }
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ readiness, smoke, smokeError }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${formatBotPrivateTopicReadiness(readiness)}\n`);
  if (args.smoke) {
    process.stdout.write("\nSmoke:\n");
    if (smoke) {
      process.stdout.write(`- created and deleted topic ${smoke.messageThreadId} in private chat ${smoke.chatId}\n`);
    } else {
      process.stdout.write(`- failed: ${smokeError}\n`);
    }
  } else {
    process.stdout.write("\nRun with `-- --smoke --chat-id <telegram-user-id>` for a real create/delete check.\n");
  }

  if (!readiness.ok || smokeError) {
    process.exitCode = 1;
  }
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
