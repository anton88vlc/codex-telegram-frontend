export const SYNC_PROJECT_CREATOR = "sync-project";

export function sanitizeTopicTitle(value, fallback = "Codex thread") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const base = text || fallback;
  return base.length <= 120 ? base : `${base.slice(0, 117).trimEnd()}...`;
}

export function isSyncManagedBinding(binding) {
  return binding?.syncManaged === true || binding?.createdBy === SYNC_PROJECT_CREATOR;
}

export function isClosedSyncBinding(binding) {
  return isSyncManagedBinding(binding) && binding?.syncState === "closed";
}

export function isActiveBinding(binding) {
  return !isClosedSyncBinding(binding);
}

function sortedEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((left, right) => {
    const leftTopic = Number(left?.binding?.messageThreadId ?? Number.MAX_SAFE_INTEGER);
    const rightTopic = Number(right?.binding?.messageThreadId ?? Number.MAX_SAFE_INTEGER);
    return leftTopic - rightTopic;
  });
}

function pushGrouped(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function getThreadTitle(thread) {
  return sanitizeTopicTitle(thread?.title, thread?.id);
}

function bindingNeedsRename(entry, thread) {
  return String(entry?.binding?.threadTitle || "") !== getThreadTitle(thread);
}

export function buildProjectSyncPlan({ entries = [], threads = [], requestedLimit = 3 } = {}) {
  const desiredThreads = [...threads].slice(0, requestedLimit);
  const desiredThreadIds = new Set(desiredThreads.map((thread) => String(thread.id)));
  const activeEntries = sortedEntries(entries).filter(({ binding }) => isActiveBinding(binding));
  const activeManualByThread = new Map();
  const activeSyncByThread = new Map();
  const parkedSyncByThread = new Map();

  for (const entry of sortedEntries(entries)) {
    const threadId = String(entry?.binding?.threadId ?? "").trim();
    if (!threadId) {
      continue;
    }
    if (isSyncManagedBinding(entry.binding)) {
      if (isClosedSyncBinding(entry.binding)) {
        pushGrouped(parkedSyncByThread, threadId, entry);
      } else {
        pushGrouped(activeSyncByThread, threadId, entry);
      }
      continue;
    }
    pushGrouped(activeManualByThread, threadId, entry);
  }

  const keep = [];
  const rename = [];
  const reopen = [];
  const create = [];
  const park = [];
  const coveredThreadIds = new Set();
  const parkedKeys = new Set();

  for (const thread of desiredThreads) {
    const threadId = String(thread.id);
    const manualEntries = activeManualByThread.get(threadId) ?? [];
    const activeSyncEntries = activeSyncByThread.get(threadId) ?? [];
    const parkedSyncEntries = parkedSyncByThread.get(threadId) ?? [];

    if (manualEntries.length > 0) {
      keep.push({
        coverage: "manual",
        entry: manualEntries[0],
        thread,
      });
      coveredThreadIds.add(threadId);
      for (const duplicate of activeSyncEntries) {
        if (parkedKeys.has(duplicate.bindingKey)) {
          continue;
        }
        park.push({
          entry: duplicate,
          thread,
          reason: "manual_binding_exists",
        });
        parkedKeys.add(duplicate.bindingKey);
      }
      continue;
    }

    if (activeSyncEntries.length > 0) {
      const [primary, ...duplicates] = activeSyncEntries;
      if (bindingNeedsRename(primary, thread)) {
        rename.push({ entry: primary, thread });
      } else {
        keep.push({
          coverage: "sync",
          entry: primary,
          thread,
        });
      }
      coveredThreadIds.add(threadId);
      for (const duplicate of duplicates) {
        if (parkedKeys.has(duplicate.bindingKey)) {
          continue;
        }
        park.push({
          entry: duplicate,
          thread,
          reason: "duplicate_sync_binding",
        });
        parkedKeys.add(duplicate.bindingKey);
      }
      continue;
    }

    if (parkedSyncEntries.length > 0) {
      reopen.push({
        entry: parkedSyncEntries[0],
        thread,
        renameNeeded: bindingNeedsRename(parkedSyncEntries[0], thread),
      });
      coveredThreadIds.add(threadId);
      continue;
    }

    create.push({ thread });
  }

  for (const entry of activeEntries) {
    if (!isSyncManagedBinding(entry.binding)) {
      continue;
    }
    const threadId = String(entry.binding.threadId);
    if (coveredThreadIds.has(threadId) || parkedKeys.has(entry.bindingKey)) {
      continue;
    }
    park.push({
      entry,
      thread: null,
      reason: desiredThreadIds.has(threadId) ? "duplicate_sync_binding" : "out_of_working_set",
    });
    parkedKeys.add(entry.bindingKey);
  }

  return {
    desiredThreads,
    desiredThreadIds,
    activeEntries,
    parkedEntries: sortedEntries(entries).filter(({ binding }) => isClosedSyncBinding(binding)),
    keep,
    rename,
    reopen,
    create,
    park,
    summary: {
      desiredCount: desiredThreads.length,
      activeCount: activeEntries.length,
      activeSyncCount: activeEntries.filter(({ binding }) => isSyncManagedBinding(binding)).length,
      parkedCount: sortedEntries(entries).filter(({ binding }) => isClosedSyncBinding(binding)).length,
      keepCount: keep.length,
      renameCount: rename.length,
      reopenCount: reopen.length,
      createCount: create.length,
      parkCount: park.length,
    },
  };
}
