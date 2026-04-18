#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { sendNativeTurn } from "./lib/codex-native.mjs";
import {
  loadState,
  saveState,
  makeBindingKey,
  makeMessageKey,
  getBinding,
  setBinding,
  removeBinding,
  hasProcessedMessage,
  markProcessedMessage,
} from "./lib/state.mjs";
import { createForumTopic, editThenSendTextChunks, getUpdates, sendTextChunks, sendTyping } from "./lib/telegram.mjs";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.local.json");

const DEFAULT_STATE_PATH = path.join(PROJECT_ROOT, "state", "state.json");

const DEFAULT_NATIVE_HELPER_PATH = path.join(PROJECT_ROOT, "scripts", "send_via_app_control.js");

const DEFAULT_NATIVE_FALLBACK_HELPER_PATH = path.join(PROJECT_ROOT, "scripts", "send_via_app_server.js");

const DEFAULT_PROJECT_INDEX_PATH = path.join(PROJECT_ROOT, "state", "bootstrap-result.json");

const DEFAULT_THREADS_DB_PATH = path.join(
  process.env.HOME || "/Users/antonnaumov",
  ".codex",
  "state_5.sqlite",
);

function fail(message, extra = {}) {
  const payload = { ok: false, error: message, ...extra };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    configPath: DEFAULT_CONFIG_PATH,
    once: false,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    switch (arg) {
      case "--config":
        out.configPath = argv[++idx];
        break;
      case "--once":
        out.once = true;
        break;
      default:
        fail(`unknown argument: ${arg}`, { argv });
    }
  }
  return out;
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function loadConfig(configPath) {
  const fromFile = await readJsonIfExists(configPath, {});
  const botTokenEnv = fromFile?.botTokenEnv || "CODEX_TELEGRAM_BOT_TOKEN";
  const botToken = process.env[botTokenEnv] || fromFile?.botToken || null;
  if (!botToken) {
    fail(`missing Telegram bot token; set ${botTokenEnv} or botToken in config`, { configPath });
  }

  const config = {
    botToken,
    botTokenEnv,
    allowedUserIds: Array.isArray(fromFile?.allowedUserIds) ? fromFile.allowedUserIds.map(Number).filter(Number.isFinite) : [],
    allowedChatIds: Array.isArray(fromFile?.allowedChatIds) ? fromFile.allowedChatIds.map(String) : [],
    pollTimeoutSeconds: Number.isFinite(fromFile?.pollTimeoutSeconds) ? fromFile.pollTimeoutSeconds : 30,
    sendTyping: fromFile?.sendTyping !== false,
    nativeTimeoutMs: Number.isFinite(fromFile?.nativeTimeoutMs) ? fromFile.nativeTimeoutMs : 120_000,
    statePath: fromFile?.statePath || DEFAULT_STATE_PATH,
    nativeHelperPath: fromFile?.nativeHelperPath || DEFAULT_NATIVE_HELPER_PATH,
    nativeFallbackHelperPath:
      fromFile?.nativeFallbackHelperPath || DEFAULT_NATIVE_FALLBACK_HELPER_PATH,
    projectIndexPath: fromFile?.projectIndexPath || DEFAULT_PROJECT_INDEX_PATH,
    threadsDbPath: fromFile?.threadsDbPath || DEFAULT_THREADS_DB_PATH,
    syncDefaultLimit: Number.isFinite(fromFile?.syncDefaultLimit) ? fromFile.syncDefaultLimit : 3,
  };

  return config;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function stripCommandTarget(text) {
  const [head, ...rest] = normalizeText(text).split(/\s+/);
  const cleanedHead = head.replace(/@[^ ]+$/, "");
  return [cleanedHead, ...rest].join(" ").trim();
}

function parseCommand(text) {
  const stripped = stripCommandTarget(text);
  if (!stripped.startsWith("/")) return null;
  const [command, ...args] = stripped.split(/\s+/);
  return {
    command: command.toLowerCase(),
    args,
  };
}

function buildTargetFromMessage(message) {
  return {
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id ?? null,
  };
}

const TELEGRAM_SERVICE_MESSAGE_KEYS = [
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "message_auto_delete_timer_changed",
  "pinned_message",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "boost_added",
  "chat_background_set",
];

function isTelegramServiceMessage(message) {
  return TELEGRAM_SERVICE_MESSAGE_KEYS.some((key) => key in (message || {}));
}

function renderNativeSendError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(raw)) {
    return "Не дождался ответа от Codex вовремя. Если хочешь, просто повтори сообщение.";
  }
  return `Споткнулся на отправке в Codex: ${raw}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function sanitizeTopicTitle(value, fallback = "Codex thread") {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const base = text || fallback;
  return base.length <= 120 ? base : `${base.slice(0, 117).trimEnd()}...`;
}

function execJsonCommand(command, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} failed with exit code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`failed to parse JSON from ${command}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

async function loadProjectIndex(projectIndexPath) {
  const parsed = await readJsonIfExists(projectIndexPath, null);
  if (!parsed?.groups || !Array.isArray(parsed.groups)) {
    throw new Error(`project index missing groups: ${projectIndexPath}`);
  }
  return parsed.groups.map((group) => ({
    projectRoot: normalizeText(group.projectRoot),
    groupTitle: normalizeText(group.groupTitle),
    chatId: String(group.botApiChatId),
    topics: Array.isArray(group.topics) ? group.topics : [],
  }));
}

function getProjectGroupForChat(groups, chatId) {
  return groups.find((group) => String(group.chatId) === String(chatId)) ?? null;
}

function getBoundThreadIdsForChat(state, chatId) {
  const ids = new Set();
  for (const binding of Object.values(state.bindings ?? {})) {
    if (String(binding?.chatId) === String(chatId) && binding?.threadId) {
      ids.add(String(binding.threadId));
    }
  }
  return ids;
}

async function listProjectThreads(threadsDbPath, projectRoot, { limit = 10 } = {}) {
  const cappedLimit = clamp(parsePositiveInt(limit, 10), 1, 20);
  const sql = `
    select
      id,
      title,
      cwd,
      archived,
      updated_at,
      coalesce(updated_at_ms, updated_at * 1000) as updated_at_ms,
      source
    from threads
    where cwd = '${String(projectRoot).replaceAll("'", "''")}'
      and archived = 0
      and coalesce(agent_nickname, '') = ''
      and coalesce(agent_role, '') = ''
      and source not like '{"subagent":%'
    order by updated_at desc, id desc
    limit ${cappedLimit};
  `;

  const rows = await execJsonCommand("sqlite3", ["-json", threadsDbPath, sql], {
    timeoutMs: 15_000,
  });
  return Array.isArray(rows) ? rows : [];
}

function formatThreadBullet(thread) {
  return `- ${sanitizeTopicTitle(thread.title, thread.id)} (${thread.id})`;
}

function buildBindingPayload({ message, thread, chatTitle }) {
  return {
    threadId: String(thread.id),
    transport: "native",
    chatId: String(message.chat.id),
    messageThreadId: message.message_thread_id ?? null,
    chatTitle: normalizeText(chatTitle || message.chat.title || message.chat.username || message.chat.first_name || ""),
    threadTitle: sanitizeTopicTitle(thread.title, thread.id),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function isAuthorized(config, message) {
  const userId = Number(message?.from?.id);
  const chatId = String(message?.chat?.id);
  if (config.allowedUserIds.length && !config.allowedUserIds.includes(userId)) {
    return false;
  }
  if (config.allowedChatIds.length && !config.allowedChatIds.includes(chatId)) {
    return false;
  }
  return true;
}

async function reply(token, message, text) {
  return sendTextChunks(token, buildTargetFromMessage(message), text, message.message_id);
}

function rememberOutbound(binding, sentMessages) {
  if (!binding || !Array.isArray(sentMessages)) return;
  binding.lastOutboundMessageIds = sentMessages
    .map((item) => item?.message_id)
    .filter((value) => Number.isInteger(value));
}

function logBridgeEvent(type, payload = {}) {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), type, ...payload }, null, 2)}\n`);
}

function renderHelp() {
  return [
    "Команды:",
    "/attach <thread-id> - привязать текущий чат или topic к Codex thread",
    "/attach-latest - привязать текущий topic к самому свежему непривязанному thread этого проекта",
    "/detach - снять привязку",
    "/sync-project [count] - создать topics для свежих непривязанных thread проекта",
    "/status - показать текущую привязку",
    "/mode native - явно зафиксировать native transport",
    "/help - показать это сообщение",
    "",
    "После /attach обычный текст из этого чата уходит в привязанный Codex thread.",
    "v1 честный: только native transport. Heartbeat/UI-visible путь оставлен на phase 2.",
    "Full-auto sync я специально не включал: иначе Telegram быстро превращается в мусорку.",
  ].join("\n");
}

async function handleCommand({ config, state, message, bindingKey, binding, parsed }) {
  switch (parsed.command) {
    case "/help":
    case "/start":
      await reply(config.botToken, message, renderHelp());
      return true;

    case "/attach": {
      const threadId = parsed.args[0];
      if (!threadId) {
        await reply(config.botToken, message, "Нужен thread id: /attach <thread-id>");
        return true;
      }
      setBinding(state, bindingKey, {
        threadId,
        transport: "native",
        chatId: String(message.chat.id),
        messageThreadId: message.message_thread_id ?? null,
        chatTitle: normalizeText(message.chat.title || message.chat.username || message.chat.first_name || ""),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const nextBinding = getBinding(state, bindingKey);
      const sent = await reply(config.botToken, message, `Привязал этот чат к thread ${threadId} через native transport.`);
      rememberOutbound(nextBinding, sent);
      return true;
    }

    case "/attach-latest": {
      if (message.message_thread_id == null) {
        await reply(config.botToken, message, "Эта команда имеет смысл только внутри forum topic.");
        return true;
      }
      if (binding) {
        await reply(config.botToken, message, `Этот topic уже привязан к ${binding.threadId}. Если хочешь перекинуть его, сначала /detach.`);
        return true;
      }

      const groups = await loadProjectIndex(config.projectIndexPath);
      const projectGroup = getProjectGroupForChat(groups, message.chat.id);
      if (!projectGroup) {
        await reply(config.botToken, message, "Для этой группы я не нашёл project mapping. Сначала нужен bootstrap или ручная привязка.");
        return true;
      }

      const boundThreadIds = getBoundThreadIdsForChat(state, message.chat.id);
      const candidates = await listProjectThreads(config.threadsDbPath, projectGroup.projectRoot, { limit: 12 });
      const nextThread = candidates.find((thread) => !boundThreadIds.has(String(thread.id)));

      if (!nextThread) {
        await reply(config.botToken, message, "Свежих непривязанных thread тут сейчас не вижу.");
        return true;
      }

      const nextBinding = setBinding(
        state,
        bindingKey,
        buildBindingPayload({
          message,
          thread: nextThread,
          chatTitle: projectGroup.groupTitle,
        }),
      );
      const sent = await reply(
        config.botToken,
        message,
        `Привязал этот topic к свежему thread.\nthread: ${nextThread.id}\ntitle: ${sanitizeTopicTitle(nextThread.title, nextThread.id)}`,
      );
      rememberOutbound(nextBinding, sent);
      return true;
    }

    case "/detach":
      if (!binding) {
        await reply(config.botToken, message, "Тут и так нет привязки.");
        return true;
      }
      removeBinding(state, bindingKey);
      await reply(config.botToken, message, `Отвязал thread ${binding.threadId}.`);
      return true;

    case "/status":
      if (!binding) {
        await reply(config.botToken, message, "Привязки нет. Используй /attach <thread-id>.");
        return true;
      }
      const sent = await reply(
        config.botToken,
        message,
        `Текущая привязка:\nthread: ${binding.threadId}\ntransport: ${binding.transport || "native"}\nkey: ${bindingKey}`,
      );
      rememberOutbound(binding, sent);
      return true;

    case "/sync-project": {
      const groups = await loadProjectIndex(config.projectIndexPath);
      const projectGroup = getProjectGroupForChat(groups, message.chat.id);
      if (!projectGroup) {
        await reply(config.botToken, message, "Для этой группы я не нашёл project mapping. Значит bootstrap ещё не дотянут или chat id другой.");
        return true;
      }

      const requestedLimit = clamp(
        parsePositiveInt(parsed.args[0], config.syncDefaultLimit),
        1,
        10,
      );
      const boundThreadIds = getBoundThreadIdsForChat(state, message.chat.id);
      const threads = await listProjectThreads(config.threadsDbPath, projectGroup.projectRoot, {
        limit: Math.max(requestedLimit * 4, 12),
      });
      const unboundThreads = threads.filter((thread) => !boundThreadIds.has(String(thread.id))).slice(0, requestedLimit);

      if (!unboundThreads.length) {
        await reply(config.botToken, message, "Новых непривязанных thread для этого проекта сейчас нет.");
        return true;
      }

      const created = [];
      for (const thread of unboundThreads) {
        const topic = await createForumTopic(config.botToken, {
          chatId: message.chat.id,
          name: sanitizeTopicTitle(thread.title, thread.id),
        });
        const topicId = Number(topic?.message_thread_id);
        if (!Number.isInteger(topicId)) {
          throw new Error(`createForumTopic returned invalid message_thread_id for ${thread.id}`);
        }
        const topicBindingKey = makeBindingKey({
          chatId: message.chat.id,
          messageThreadId: topicId,
        });
        setBinding(
          state,
          topicBindingKey,
          {
            ...buildBindingPayload({
              message: {
                ...message,
                message_thread_id: topicId,
              },
              thread,
              chatTitle: projectGroup.groupTitle,
            }),
            createdBy: "sync-project",
          },
        );
        created.push({
          topicId,
          title: sanitizeTopicTitle(thread.title, thread.id),
          threadId: String(thread.id),
        });
      }

      const lines = [
        `Создал ${created.length} topic(s) для ${projectGroup.groupTitle}.`,
        ...created.map((item) => `- [topic ${item.topicId}] ${item.title} -> ${item.threadId}`),
      ];
      await reply(config.botToken, message, lines.join("\n"));
      return true;
    }

    case "/mode": {
      const mode = normalizeText(parsed.args[0] || "");
      if (!binding) {
        await reply(config.botToken, message, "Сначала нужна привязка: /attach <thread-id>.");
        return true;
      }
      if (mode !== "native") {
        await reply(
          config.botToken,
          message,
          "В v1 включён только native. Heartbeat в standalone bridge я сознательно не подделывал: это phase 2.",
        );
        return true;
      }
      binding.transport = "native";
      binding.updatedAt = new Date().toISOString();
      const sent = await reply(config.botToken, message, "Ок, transport = native.");
      rememberOutbound(binding, sent);
      return true;
    }

    default:
      await reply(config.botToken, message, "Неизвестная команда. /help покажет доступные варианты.");
      return true;
  }
}

async function handlePlainText({ config, state, message, bindingKey, binding }) {
  if (!binding) {
    await reply(config.botToken, message, "Нет привязки. Используй /attach <thread-id>.");
    return;
  }

  if ((binding.transport || "native") !== "native") {
    await reply(config.botToken, message, "Этот bridge v1 умеет только native transport.");
    return;
  }

  binding.lastInboundMessageId = message.message_id ?? null;
  binding.updatedAt = new Date().toISOString();
  state.bindings[bindingKey] = binding;

  if (config.sendTyping) {
    await sendTyping(config.botToken, buildTargetFromMessage(message)).catch(() => null);
  }

  const prompt = normalizeText(message.text);
  const target = buildTargetFromMessage(message);
  const receipt = await reply(
    config.botToken,
    message,
    "Работаю...",
  );
  const receiptMessageId = receipt[0]?.message_id ?? null;
  rememberOutbound(binding, receipt);

  try {
    const result = await sendNativeTurn({
      helperPath: config.nativeHelperPath,
      fallbackHelperPath: config.nativeFallbackHelperPath,
      threadId: binding.threadId,
      prompt,
      timeoutMs: config.nativeTimeoutMs,
    });
    binding.updatedAt = new Date().toISOString();
    state.bindings[bindingKey] = binding;
    const replyText = normalizeText(result?.reply?.text) || "(пустой ответ)";
    const sent = receiptMessageId
      ? await editThenSendTextChunks(config.botToken, target, receiptMessageId, replyText)
      : await reply(config.botToken, message, replyText);
    rememberOutbound(binding, sent);
  } catch (error) {
    logBridgeEvent("native_send_error", {
      threadId: binding.threadId,
      bindingKey,
      error: error instanceof Error ? error.message : String(error),
    });
    const errorText = renderNativeSendError(error);
    const sent = receiptMessageId
      ? await editThenSendTextChunks(config.botToken, target, receiptMessageId, errorText)
      : await reply(config.botToken, message, errorText);
    rememberOutbound(binding, sent);
  }
}

async function processMessage({ config, state, message }) {
  if (!message?.chat?.id) return false;
  if (message?.from?.is_bot) return false;
  if (!isAuthorized(config, message)) return false;
  if (isTelegramServiceMessage(message)) {
    logBridgeEvent("skip_service_message", {
      chatId: message.chat.id,
      messageId: message.message_id ?? null,
      messageThreadId: message.message_thread_id ?? null,
      serviceKeys: TELEGRAM_SERVICE_MESSAGE_KEYS.filter((key) => key in message),
    });
    return false;
  }
  if (typeof message.text !== "string" || !message.text.trim()) {
    await reply(config.botToken, message, "Пока понимаю только текст. Картинки и файлы подключим потом.");
    return true;
  }

  const bindingKey = makeBindingKey({
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id ?? null,
  });
  const binding = getBinding(state, bindingKey);
  const parsed = parseCommand(message.text);
  try {
    if (parsed) {
      return await handleCommand({ config, state, message, bindingKey, binding, parsed });
    }
    return await handlePlainText({ config, state, message, bindingKey, binding });
  } catch (error) {
    await reply(
      config.botToken,
      message,
      `Bridge споткнулся: ${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  }
}

async function checkpointMessage(statePath, state, update) {
  const updateId = Number.isInteger(update?.update_id) ? update.update_id : state.lastUpdateId;
  const messageKey = makeMessageKey(update.message);
  if (hasProcessedMessage(state, messageKey)) {
    state.lastUpdateId = Math.max(state.lastUpdateId, updateId);
    await saveState(statePath, state);
    return { messageKey, alreadyProcessed: true };
  }

  state.lastUpdateId = Math.max(state.lastUpdateId, updateId);
  markProcessedMessage(state, messageKey);
  await saveState(statePath, state);
  return { messageKey, alreadyProcessed: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.configPath);
  const state = await loadState(config.statePath);
  let consecutivePollErrors = 0;

  while (true) {
    let updates = [];
    try {
      updates = await getUpdates(config.botToken, {
        offset: state.lastUpdateId > 0 ? state.lastUpdateId + 1 : 0,
        timeoutSeconds: config.pollTimeoutSeconds,
        limit: 50,
      });
      consecutivePollErrors = 0;
    } catch (error) {
      consecutivePollErrors += 1;
      logBridgeEvent("poll_error", {
        consecutivePollErrors,
        error: error instanceof Error ? error.message : String(error),
      });
      await saveState(config.statePath, state);
      if (args.once) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 1000 * consecutivePollErrors)));
      continue;
    }

    for (const update of updates) {
      if (update?.message) {
        const checkpoint = await checkpointMessage(config.statePath, state, update);
        if (checkpoint.alreadyProcessed) {
          continue;
        }
        await processMessage({ config, state, message: update.message });
        await saveState(config.statePath, state);
      } else {
        state.lastUpdateId = Number.isInteger(update.update_id) ? update.update_id : state.lastUpdateId;
        await saveState(config.statePath, state);
      }
    }

    if (updates.length === 0) {
      await saveState(config.statePath, state);
    }

    if (args.once) {
      break;
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
