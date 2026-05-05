import { AppServerProtocolClient } from "./app-server-client.mjs";
import {
  DEFAULT_CODEX_GLOBAL_STATE_PATH,
  clamp,
  findActiveThreadSuccessors,
  getThreadById,
  getThreadsByIds,
  listActiveWorkItemsByIds,
  listProjectThreads,
  listQuickstartWorkItems,
  listRecentProjects,
  listRecentThreads,
  listRecentWorkItems,
  parsePositiveInt,
  readPinnedThreadIds,
} from "./thread-db.mjs";

function cleanText(value) {
  return String(value ?? "").trim();
}

function maybeJsonString(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function secondsToMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return number > 10_000_000_000 ? Math.round(number) : Math.round(number * 1000);
}

function msToSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return number > 10_000_000_000 ? Math.floor(number / 1000) : Math.floor(number);
}

function normalizeThreadList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (Array.isArray(payload?.threads)) {
    return payload.threads;
  }
  return [];
}

function normalizeThreadRead(payload) {
  return payload?.thread || payload?.data || payload || null;
}

function isArchivedAppServerThread(thread) {
  const statusType = cleanText(thread?.status?.type || thread?.status);
  return Boolean(thread?.archived === true || thread?.isArchived === true || statusType === "archived");
}

function isWorkerLikeThread(thread) {
  const source = maybeJsonString(thread?.source);
  return Boolean(
    cleanText(thread?.agentNickname) ||
      cleanText(thread?.agentRole) ||
      cleanText(thread?.agent_nickname) ||
      cleanText(thread?.agent_role) ||
      source.startsWith('{"subagent":'),
  );
}

export function normalizeAppServerThread(thread) {
  if (!thread || typeof thread !== "object") {
    return null;
  }
  const id = cleanText(thread.id || thread.threadId);
  if (!id) {
    return null;
  }
  const updatedMs =
    secondsToMs(thread.updatedAt) ??
    secondsToMs(thread.updated_at_ms) ??
    secondsToMs(thread.updated_at) ??
    secondsToMs(thread.createdAt);
  const createdMs = secondsToMs(thread.createdAt) ?? secondsToMs(thread.created_at_ms) ?? secondsToMs(thread.created_at);
  const title = cleanText(thread.name || thread.title || thread.preview) || id;
  return {
    ...thread,
    id,
    title,
    cwd: cleanText(thread.cwd),
    archived: isArchivedAppServerThread(thread) ? 1 : 0,
    updated_at: msToSeconds(updatedMs) ?? 0,
    updated_at_ms: updatedMs ?? 0,
    created_at: msToSeconds(createdMs) ?? null,
    created_at_ms: createdMs ?? null,
    source: maybeJsonString(thread.source),
    rollout_path: cleanText(thread.path || thread.rollout_path || thread.rolloutPath),
    model_provider: cleanText(thread.modelProvider || thread.model_provider),
    model: cleanText(thread.model || thread.modelName),
    reasoning_effort: cleanText(thread.reasoningEffort || thread.reasoning_effort || thread.model_reasoning_effort),
    tokens_used: Number.isFinite(Number(thread.tokensUsed ?? thread.tokens_used)) ? Number(thread.tokensUsed ?? thread.tokens_used) : null,
    agent_nickname: cleanText(thread.agentNickname || thread.agent_nickname),
    agent_role: cleanText(thread.agentRole || thread.agent_role),
    preview: cleanText(thread.preview),
  };
}

export function normalizeAppServerThreads(threads, { includeArchived = true, includeWorkers = false } = {}) {
  return normalizeThreadList(threads)
    .map((thread) => normalizeAppServerThread(thread))
    .filter(Boolean)
    .filter((thread) => (includeArchived ? true : Number(thread.archived) === 0))
    .filter((thread) => (includeWorkers ? true : !isWorkerLikeThread(thread)));
}

async function withAppServerThreadClient(
  config,
  callback,
  {
    AppServerProtocolClientClass = AppServerProtocolClient,
    connectTimeoutMs = config?.appServerStreamConnectTimeoutMs,
    requestTimeoutMs = config?.appServerControlTimeoutMs,
  } = {},
) {
  const url = cleanText(config?.appServerUrl);
  if (!url) {
    throw new Error("missing app-server URL");
  }
  const client = new AppServerProtocolClientClass({
    url,
    connectTimeoutMs: Number.isFinite(connectTimeoutMs) ? Math.max(500, Number(connectTimeoutMs)) : 1_500,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? Math.max(500, Number(requestTimeoutMs)) : 3_000,
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

export async function listAppServerThreads(config, { limit = 100, includeArchived = true } = {}, deps = {}) {
  const cappedLimit = clamp(parsePositiveInt(limit, 100), 1, 500);
  const payload = await withAppServerThreadClient(
    config,
    async (client) => {
      if (!client.supportsMethod?.("thread/list")) {
        throw new Error("app-server does not support thread/list");
      }
      return client.request("thread/list", {}, { timeoutMs: deps.requestTimeoutMs });
    },
    deps,
  );
  return normalizeAppServerThreads(payload, { includeArchived })
    .sort((a, b) => (Number(b.updated_at_ms) || 0) - (Number(a.updated_at_ms) || 0) || String(b.id).localeCompare(String(a.id)))
    .slice(0, cappedLimit);
}

export async function readAppServerThread(config, threadId, { includeTurns = false } = {}, deps = {}) {
  const normalizedThreadId = cleanText(threadId);
  if (!normalizedThreadId) {
    return null;
  }
  const payload = await withAppServerThreadClient(
    config,
    async (client) => {
      if (!client.supportsMethod?.("thread/read")) {
        throw new Error("app-server does not support thread/read");
      }
      return client.request(
        "thread/read",
        { threadId: normalizedThreadId, includeTurns: Boolean(includeTurns) },
        { timeoutMs: deps.requestTimeoutMs },
      );
    },
    deps,
  );
  return normalizeAppServerThread(normalizeThreadRead(payload));
}

export async function getAppServerThreadsByIds(config, threadIds, deps = {}) {
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(threadIds) ? threadIds : [])
        .map((item) => cleanText(item))
        .filter(Boolean),
    ),
  );
  if (!normalizedIds.length) {
    return [];
  }
  const rows = await listAppServerThreads(config, { limit: Math.max(100, normalizedIds.length), includeArchived: true }, deps);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const missingIds = normalizedIds.filter((id) => !byId.has(id));
  for (const threadId of missingIds) {
    try {
      const row = await readAppServerThread(config, threadId, { includeTurns: false }, deps);
      if (row) {
        byId.set(String(row.id), row);
      }
    } catch {
      // Keep the batch resilient. The caller can fall back to sqlite for gaps.
    }
  }
  return normalizedIds.map((id) => byId.get(id)).filter(Boolean);
}

export async function getAppServerThreadById(config, threadId, deps = {}) {
  const rows = await getAppServerThreadsByIds(config, [threadId], deps);
  return rows[0] ?? null;
}

export async function listAppServerProjectThreads(config, projectRoot, { limit = 10 } = {}, deps = {}) {
  const cappedLimit = clamp(parsePositiveInt(limit, 10), 1, 50);
  const normalizedProjectRoot = cleanText(projectRoot);
  if (!normalizedProjectRoot) {
    return [];
  }
  const rows = await listAppServerThreads(config, { limit: Math.max(cappedLimit * 4, cappedLimit), includeArchived: false }, deps);
  return rows.filter((thread) => thread.cwd === normalizedProjectRoot).slice(0, cappedLimit);
}

export async function listAppServerRecentThreads(config, { limit = 10 } = {}, deps = {}) {
  return listAppServerThreads(config, { limit, includeArchived: false }, deps).then((threads) =>
    threads.filter((thread) => cleanText(thread.cwd)),
  );
}

export async function listAppServerRecentWorkItems(config, { limit = 10 } = {}, deps = {}) {
  return listAppServerThreads(config, { limit, includeArchived: false }, deps);
}

export async function listAppServerRecentProjects(config, { limit = 20 } = {}, deps = {}) {
  const cappedLimit = clamp(parsePositiveInt(limit, 20), 1, 100);
  const rows = await listAppServerRecentThreads(config, { limit: Math.max(cappedLimit * 5, cappedLimit) }, deps);
  const byRoot = new Map();
  for (const thread of rows) {
    const projectRoot = cleanText(thread.cwd);
    if (!projectRoot) {
      continue;
    }
    const entry = byRoot.get(projectRoot) || {
      projectRoot,
      threadCount: 0,
      latestUpdatedAt: 0,
      latestUpdatedAtMs: 0,
    };
    entry.threadCount += 1;
    entry.latestUpdatedAt = Math.max(Number(entry.latestUpdatedAt) || 0, Number(thread.updated_at) || 0);
    entry.latestUpdatedAtMs = Math.max(Number(entry.latestUpdatedAtMs) || 0, Number(thread.updated_at_ms) || 0);
    byRoot.set(projectRoot, entry);
  }
  return [...byRoot.values()]
    .sort((a, b) => (Number(b.latestUpdatedAtMs) || 0) - (Number(a.latestUpdatedAtMs) || 0) || a.projectRoot.localeCompare(b.projectRoot))
    .slice(0, cappedLimit);
}

export async function listAppServerActiveWorkItemsByIds(config, threadIds, deps = {}) {
  const rows = await getAppServerThreadsByIds(config, threadIds, deps);
  return rows.filter((thread) => Number(thread.archived) === 0 && !isWorkerLikeThread(thread));
}

export async function listAppServerQuickstartWorkItems(
  config,
  { limit = 10, globalStatePath = DEFAULT_CODEX_GLOBAL_STATE_PATH } = {},
  deps = {},
) {
  const cappedLimit = clamp(parsePositiveInt(limit, 10), 1, 100);
  const pinnedThreadIds = await readPinnedThreadIds(globalStatePath);
  const pinnedThreads = await listAppServerActiveWorkItemsByIds(config, pinnedThreadIds, deps);
  const recentThreads = await listAppServerRecentWorkItems(config, { limit: cappedLimit }, deps);
  const targetLimit = Math.max(cappedLimit, pinnedThreads.length);
  const selected = [];
  const seen = new Set();
  for (const thread of [...pinnedThreads, ...recentThreads]) {
    const id = cleanText(thread?.id);
    if (!id || seen.has(id)) {
      continue;
    }
    selected.push({
      ...thread,
      codexPinned: pinnedThreadIds.includes(id),
    });
    seen.add(id);
    if (selected.length >= targetLimit) {
      break;
    }
  }
  return {
    threads: selected,
    pinnedThreadIds,
    selectedPinnedThreadCount: selected.filter((thread) => thread.codexPinned).length,
  };
}

async function withSqliteFallback(config, action, fallback, { logEventFn = null, eventType = "thread_store_fallback" } = {}) {
  if (config?.appServerThreadStoreEnabled === false || !cleanText(config?.appServerUrl)) {
    return fallback();
  }
  try {
    return await action();
  } catch (error) {
    if (typeof logEventFn === "function") {
      logEventFn(eventType, {
        appServerUrl: config.appServerUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return fallback();
  }
}

export async function getThreadsByIdsFromStore(config, threadIds, options = {}) {
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(threadIds) ? threadIds : [])
        .map((item) => cleanText(item))
        .filter(Boolean),
    ),
  );
  if (!normalizedIds.length) {
    return [];
  }
  return withSqliteFallback(
    config,
    async () => {
      const appServerRows = await getAppServerThreadsByIds(config, normalizedIds, options);
      const rowsById = new Map(appServerRows.map((row) => [String(row.id), row]));
      const missingIds = normalizedIds.filter((id) => !rowsById.has(id));
      if (missingIds.length) {
        try {
          const sqliteRows = await getThreadsByIds(config.threadsDbPath, missingIds);
          for (const row of sqliteRows) {
            rowsById.set(String(row.id), row);
          }
        } catch {
          // If app-server is alive but the legacy DB is gone, keep the app-server
          // answer instead of failing the whole lookup.
        }
      }
      return normalizedIds.map((id) => rowsById.get(id)).filter(Boolean);
    },
    () => getThreadsByIds(config.threadsDbPath, normalizedIds),
    options,
  );
}

export async function getThreadByIdFromStore(config, threadId, options = {}) {
  return withSqliteFallback(
    config,
    () => getAppServerThreadById(config, threadId, options),
    () => getThreadById(config.threadsDbPath, threadId),
    options,
  );
}

export async function listProjectThreadsFromStore(config, projectRoot, options = {}) {
  return withSqliteFallback(
    config,
    () => listAppServerProjectThreads(config, projectRoot, options, options),
    () => listProjectThreads(config.threadsDbPath, projectRoot, options),
    options,
  );
}

export async function listRecentProjectsFromStore(config, options = {}) {
  return withSqliteFallback(
    config,
    () => listAppServerRecentProjects(config, options, options),
    () => listRecentProjects(config.threadsDbPath, options),
    options,
  );
}

export async function listRecentThreadsFromStore(config, options = {}) {
  return withSqliteFallback(
    config,
    () => listAppServerRecentThreads(config, options, options),
    () => listRecentThreads(config.threadsDbPath, options),
    options,
  );
}

export async function listRecentWorkItemsFromStore(config, options = {}) {
  return withSqliteFallback(
    config,
    () => listAppServerRecentWorkItems(config, options, options),
    () => listRecentWorkItems(config.threadsDbPath, options),
    options,
  );
}

export async function listActiveWorkItemsByIdsFromStore(config, threadIds, options = {}) {
  return withSqliteFallback(
    config,
    () => listAppServerActiveWorkItemsByIds(config, threadIds, options),
    () => listActiveWorkItemsByIds(config.threadsDbPath, threadIds),
    options,
  );
}

export async function listQuickstartWorkItemsFromStore(config, options = {}) {
  return withSqliteFallback(
    config,
    () => listAppServerQuickstartWorkItems(config, options, options),
    () => listQuickstartWorkItems(config.threadsDbPath, options),
    options,
  );
}

export async function findActiveThreadSuccessorsFromStore(config, archivedThread, options = {}) {
  return withSqliteFallback(
    config,
    async () => {
      const title = cleanText(archivedThread?.title);
      const cwd = cleanText(archivedThread?.cwd);
      if (!title || !cwd) {
        return [];
      }
      const rows = await listAppServerProjectThreads(config, cwd, { limit: Math.max(20, Number(options.limit) || 5) }, options);
      return rows
        .filter((thread) => thread.id !== archivedThread.id)
        .filter((thread) => Number(thread.archived) === 0)
        .filter((thread) => thread.title === title)
        .slice(0, clamp(parsePositiveInt(options.limit, 5), 1, 20));
    },
    () => findActiveThreadSuccessors(config.threadsDbPath, archivedThread, options),
    options,
  );
}
