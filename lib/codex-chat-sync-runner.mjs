import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CODEX_CHATS_SURFACE } from "./binding-classification.mjs";
import { logBridgeEvent } from "./bridge-events.mjs";
import { sendHistoryBackfill } from "./history-backfill.mjs";
import { normalizeText } from "./message-routing.mjs";
import { PRIVATE_CHAT_TOPICS_SURFACE } from "./onboarding-plan.mjs";
import { loadProjectIndex } from "./project-data.mjs";
import { sanitizeTopicTitle } from "./project-sync.mjs";
import { makeBindingKey, setBinding } from "./state.mjs";
import { createForumTopic, editForumTopic } from "./telegram.mjs";
import { clamp, listQuickstartWorkItems, parsePositiveInt } from "./thread-db.mjs";

export const CODEX_CHAT_AUTO_SYNC_CREATOR = "codex-chat-auto-sync";

function normalizePathText(value) {
  return normalizeText(value).replace(/\/+$/, "");
}

function parseThreadTimestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isLikelyCodexChatThread(thread, { homeDir = os.homedir() } = {}) {
  const cwd = normalizePathText(thread?.cwd);
  if (!cwd) {
    return true;
  }
  const home = normalizePathText(homeDir);
  const codexScratchRoot = normalizePathText(path.join(homeDir, "Documents", "Codex"));
  return cwd === home || cwd === codexScratchRoot || cwd.startsWith(`${codexScratchRoot}/`);
}

export function findPrivateChatTopicSurface(groups, { chatId = null } = {}) {
  const normalizedChatId = normalizeText(chatId);
  const candidates = (Array.isArray(groups) ? groups : []).filter(
    (group) => group?.surface === PRIVATE_CHAT_TOPICS_SURFACE && group?.botApiChatId,
  );
  if (normalizedChatId) {
    return candidates.find((group) => normalizeText(group.botApiChatId) === normalizedChatId) ?? null;
  }
  return candidates[0] ?? null;
}

export function getCodexChatBindings(state, chatId) {
  const normalizedChatId = normalizeText(chatId);
  return Object.entries(state?.bindings ?? {})
    .filter(([, binding]) => normalizeText(binding?.chatId) === normalizedChatId && binding?.messageThreadId != null)
    .map(([bindingKey, binding]) => ({ bindingKey, binding }));
}

export function buildCodexChatSyncPlan({
  state,
  chatId,
  threads,
  limit = 5,
  maxThreadAgeMs = 0,
  nowMs = Date.now(),
} = {}) {
  if (!normalizeText(chatId)) {
    return {
      desiredThreads: [],
      entries: [],
      create: [],
      rename: [],
      summary: {
        desiredCount: 0,
        activeCount: 0,
        createCount: 0,
        renameCount: 0,
      },
    };
  }
  const requestedLimit = clamp(parsePositiveInt(limit, 5), 1, 20);
  const maxAge = Number.isFinite(Number(maxThreadAgeMs)) ? Math.max(0, Number(maxThreadAgeMs)) : 0;
  const entries = getCodexChatBindings(state, chatId);
  const entriesByThreadId = new Map(
    entries
      .filter(({ binding }) => normalizeText(binding?.threadId))
      .map((entry) => [normalizeText(entry.binding.threadId), entry]),
  );
  const desiredThreads = [];
  const seen = new Set();
  for (const thread of Array.isArray(threads) ? threads : []) {
    const threadId = normalizeText(thread?.id);
    if (!threadId || seen.has(threadId) || !isLikelyCodexChatThread(thread)) {
      continue;
    }
    const updatedAtMs = parseThreadTimestampMs(thread?.updated_at_ms ?? thread?.updated_at);
    if (maxAge > 0 && updatedAtMs > 0 && nowMs - updatedAtMs > maxAge) {
      continue;
    }
    desiredThreads.push(thread);
    seen.add(threadId);
    if (desiredThreads.length >= requestedLimit) {
      break;
    }
  }

  const create = [];
  const rename = [];
  for (const thread of desiredThreads) {
    const threadId = normalizeText(thread.id);
    const existing = entriesByThreadId.get(threadId);
    const nextTitle = sanitizeTopicTitle(thread.title, thread.id);
    if (!existing) {
      create.push({ thread, title: nextTitle });
      continue;
    }
    const currentTitle = sanitizeTopicTitle(existing.binding?.threadTitle, existing.binding?.threadId);
    if (currentTitle !== nextTitle) {
      rename.push({ ...existing, thread, title: nextTitle });
    }
  }

  return {
    desiredThreads,
    entries,
    create,
    rename,
    summary: {
      desiredCount: desiredThreads.length,
      activeCount: entries.length,
      createCount: create.length,
      renameCount: rename.length,
    },
  };
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function upsertPrivateChatTopicsInProjectIndex(projectIndexPath, chatGroup, topics) {
  if (!projectIndexPath || !chatGroup || !Array.isArray(topics) || !topics.length) {
    return false;
  }
  const index = await readJsonIfExists(projectIndexPath, null);
  if (!index || !Array.isArray(index.groups)) {
    return false;
  }
  const normalizedChatId = normalizeText(chatGroup.botApiChatId);
  const groupIndex = index.groups.findIndex(
    (group) =>
      group?.surface === PRIVATE_CHAT_TOPICS_SURFACE &&
      (!normalizedChatId || normalizeText(group.botApiChatId) === normalizedChatId),
  );
  if (groupIndex < 0) {
    return false;
  }
  const group = index.groups[groupIndex];
  const byThreadId = new Map(
    (Array.isArray(group.topics) ? group.topics : [])
      .filter((topic) => normalizeText(topic?.threadId))
      .map((topic) => [normalizeText(topic.threadId), topic]),
  );
  for (const topic of topics) {
    const threadId = normalizeText(topic.threadId);
    if (!threadId) {
      continue;
    }
    byThreadId.set(threadId, {
      ...(byThreadId.get(threadId) || {}),
      title: sanitizeTopicTitle(topic.title, threadId),
      topicId: Number(topic.topicId),
      threadId,
      createdTopic: topic.createdTopic === true,
    });
  }
  index.groups[groupIndex] = {
    ...group,
    topics: [...byThreadId.values()],
  };
  await fs.writeFile(projectIndexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return true;
}

export async function applyCodexChatSyncPlan({
  config,
  state,
  chatGroup,
  plan,
  now = new Date().toISOString(),
  createForumTopicFn = createForumTopic,
  editForumTopicFn = editForumTopic,
  updateProjectIndexFn = upsertPrivateChatTopicsInProjectIndex,
  logEventFn = logBridgeEvent,
} = {}) {
  const chatId = normalizeText(chatGroup?.botApiChatId);
  if (!chatId || !plan) {
    return { changed: false, actionCount: 0, created: [], renamed: [] };
  }
  const created = [];
  const renamed = [];

  for (const item of plan.rename) {
    try {
      await editForumTopicFn(config.botToken, {
        chatId,
        messageThreadId: item.binding.messageThreadId,
        name: item.title,
      });
      state.bindings[item.bindingKey] = {
        ...item.binding,
        threadTitle: item.title,
        updatedAt: now,
        lastSyncedAt: now,
        syncManaged: true,
        surface: CODEX_CHATS_SURFACE,
      };
      renamed.push({
        topicId: item.binding.messageThreadId,
        title: item.title,
        threadId: normalizeText(item.thread.id),
      });
    } catch (error) {
      logEventFn("codex_chat_auto_sync_rename_error", {
        chatId,
        messageThreadId: item.binding.messageThreadId ?? null,
        threadId: item.thread?.id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const item of plan.create) {
    try {
      const topic = await createForumTopicFn(config.botToken, {
        chatId,
        name: item.title,
      });
      const topicId = Number(topic?.message_thread_id);
      if (!Number.isInteger(topicId)) {
        throw new Error(`createForumTopic returned invalid message_thread_id for ${item.thread.id}`);
      }
      const bindingKey = makeBindingKey({ chatId, messageThreadId: topicId });
      setBinding(state, bindingKey, {
        threadId: normalizeText(item.thread.id),
        transport: "native",
        chatId,
        messageThreadId: topicId,
        chatTitle: normalizeText(chatGroup.groupTitle) || "Codex - Chats",
        threadTitle: item.title,
        createdAt: now,
        updatedAt: now,
        createdBy: CODEX_CHAT_AUTO_SYNC_CREATOR,
        syncManaged: true,
        syncState: "active",
        topicStatus: "open",
        surface: CODEX_CHATS_SURFACE,
        lastSyncedAt: now,
      });
      created.push({
        topicId,
        title: item.title,
        threadId: normalizeText(item.thread.id),
        rolloutPath: normalizeText(item.thread.rollout_path),
        createdTopic: true,
      });
    } catch (error) {
      logEventFn("codex_chat_auto_sync_create_error", {
        chatId,
        threadId: item.thread?.id ?? null,
        title: item.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const changedTopics = [...renamed, ...created];
  if (changedTopics.length) {
    try {
      await updateProjectIndexFn(config.projectIndexPath, chatGroup, changedTopics);
    } catch (error) {
      logEventFn("codex_chat_auto_sync_index_error", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    changed: changedTopics.length > 0,
    actionCount: changedTopics.length,
    created,
    renamed,
  };
}

export async function syncAutoCodexChatTopics({
  config,
  state,
  nowMs = Date.now(),
  loadProjectIndexFn = loadProjectIndex,
  listQuickstartWorkItemsFn = listQuickstartWorkItems,
  buildCodexChatSyncPlanFn = buildCodexChatSyncPlan,
  applyCodexChatSyncPlanFn = applyCodexChatSyncPlan,
  sendHistoryBackfillFn = sendHistoryBackfill,
  logEventFn = logBridgeEvent,
} = {}) {
  if (config.privateTopicAutoSyncEnabled === false) {
    return { changed: false, checked: 0, actionCount: 0 };
  }
  const groups = await loadProjectIndexFn(config.projectIndexPath);
  const chatGroup = findPrivateChatTopicSurface(groups);
  if (!chatGroup?.botApiChatId) {
    return { changed: false, checked: 0, actionCount: 0 };
  }

  const limit = clamp(parsePositiveInt(config.privateTopicAutoSyncLimit, 5), 1, 20);
  const scanLimit = Math.min(100, Math.max(limit * 4, limit));
  const quickstart = await listQuickstartWorkItemsFn(config.threadsDbPath, {
    limit: scanLimit,
  });
  const plan = buildCodexChatSyncPlanFn({
    state,
    chatId: chatGroup.botApiChatId,
    threads: quickstart.threads,
    limit,
    maxThreadAgeMs: config.privateTopicAutoSyncMaxThreadAgeMs,
    nowMs,
  });
  const maxActions = Math.max(1, Number(config.privateTopicAutoSyncMaxActionsPerTick) || 1);
  const planActions = plan.summary.createCount + plan.summary.renameCount;
  if (planActions === 0) {
    return { changed: false, checked: 1, actionCount: 0 };
  }
  let applyPlan = plan;
  if (planActions > maxActions) {
    const create = plan.create.slice(0, maxActions);
    const rename = plan.rename.slice(0, Math.max(0, maxActions - create.length));
    applyPlan = {
      ...plan,
      create,
      rename,
      summary: {
        ...plan.summary,
        createCount: create.length,
        renameCount: rename.length,
      },
    };
    logEventFn("codex_chat_auto_sync_deferred", {
      chatId: chatGroup.botApiChatId,
      actionCount: planActions,
      maxActions,
      deferredCount: planActions - create.length - rename.length,
    });
  }

  const result = await applyCodexChatSyncPlanFn({ config, state, chatGroup, plan: applyPlan });
  const createdTopics = Array.isArray(result.created) ? result.created : [];
  const backfill = [];
  if (config.privateTopicAutoBackfillEnabled !== false && createdTopics.length) {
    const threadsById = new Map(plan.desiredThreads.map((thread) => [normalizeText(thread.id), thread]));
    for (const topic of createdTopics) {
      const threadId = normalizeText(topic.threadId);
      const topicId = Number(topic.topicId);
      if (!threadId || !Number.isInteger(topicId)) {
        backfill.push({
          threadId,
          topicId: Number.isInteger(topicId) ? topicId : null,
          status: "skipped",
          sent: 0,
          reason: "missing private topic id",
        });
        continue;
      }
      const thread = threadsById.get(threadId);
      const bindingKey = makeBindingKey({
        chatId: chatGroup.botApiChatId,
        messageThreadId: topicId,
      });
      try {
        const backfillResult = await sendHistoryBackfillFn({
          config,
          thread,
          chatId: chatGroup.botApiChatId,
          messageThreadId: topicId,
          maxHistoryMessages: config.privateTopicAutoBackfillMaxMessages,
          maxUserPrompts: config.historyMaxUserPrompts,
          assistantPhases: config.historyAssistantPhases,
        });
        const binding = state.bindings?.[bindingKey];
        if (binding) {
          binding.historyBackfillStatus = backfillResult.status;
          binding.historyBackfilledBy = CODEX_CHAT_AUTO_SYNC_CREATOR;
          binding.historyImportedAt = new Date().toISOString();
          binding.historyImportedCount = Number(backfillResult.messages) || 0;
          binding.historyTelegramMessagesSent = Number(backfillResult.sent) || 0;
          if (backfillResult.status === "ok") {
            delete binding.historyBackfillError;
          } else {
            binding.historyBackfillError = backfillResult.reason || "history backfill skipped";
          }
        }
        backfill.push({
          threadId,
          topicId,
          status: backfillResult.status,
          sent: backfillResult.sent || 0,
          reason: backfillResult.reason || null,
        });
        logEventFn(
          backfillResult.status === "ok" ? "codex_chat_auto_backfill_ok" : "codex_chat_auto_backfill_skipped",
          {
            chatId: chatGroup.botApiChatId,
            threadId,
            topicId,
            status: backfillResult.status,
            sent: backfillResult.sent || 0,
            messages: backfillResult.messages || 0,
            reason: backfillResult.reason || null,
          },
        );
      } catch (error) {
        const binding = state.bindings?.[bindingKey];
        if (binding) {
          binding.historyBackfillStatus = "error";
          binding.historyBackfilledBy = CODEX_CHAT_AUTO_SYNC_CREATOR;
          binding.historyBackfillError = error instanceof Error ? error.message : String(error);
        }
        backfill.push({
          threadId,
          topicId,
          status: "error",
          sent: 0,
          reason: error instanceof Error ? error.message : String(error),
        });
        logEventFn("codex_chat_auto_backfill_error", {
          chatId: chatGroup.botApiChatId,
          threadId,
          topicId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  logEventFn("codex_chat_auto_sync_applied", {
    chatId: chatGroup.botApiChatId,
    desiredCount: plan.summary.desiredCount,
    createCount: createdTopics.length,
    renameCount: Array.isArray(result.renamed) ? result.renamed.length : 0,
    backfill,
  });
  return {
    changed: result.changed,
    checked: 1,
    actionCount: result.actionCount,
    backfill,
  };
}
