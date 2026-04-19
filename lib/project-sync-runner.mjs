import { logBridgeEvent } from "./bridge-events.mjs";
import { buildBindingPayload, formatThreadBullet } from "./bridge-bindings.mjs";
import {
  getBindingsForChat,
  getProjectGroupForChat,
  loadProjectIndex,
} from "./project-data.mjs";
import {
  buildProjectSyncPlan,
  isClosedSyncBinding,
  isSyncManagedBinding,
  sanitizeTopicTitle,
  SYNC_PROJECT_CREATOR,
} from "./project-sync.mjs";
import { makeBindingKey, setBinding } from "./state.mjs";
import {
  closeForumTopic,
  createForumTopic,
  editForumTopic,
  reopenForumTopic,
} from "./telegram.mjs";
import {
  clamp,
  getThreadsByIds,
  listProjectThreads,
  parsePositiveInt,
} from "./thread-db.mjs";

export function parseSyncProjectArgs(args, defaultLimit) {
  const dryRun = args.some((arg) => /^(dry-run|--dry-run)$/i.test(String(arg)));
  const numericArg = args.find((arg) => /^\d+$/.test(String(arg)));
  const requestedLimit = clamp(parsePositiveInt(numericArg, defaultLimit), 1, 10);
  return {
    dryRun,
    requestedLimit,
  };
}

export async function loadProjectGroupForMessage(
  config,
  message,
  { loadProjectIndexFn = loadProjectIndex, getProjectGroupForChatFn = getProjectGroupForChat } = {},
) {
  const groups = await loadProjectIndexFn(config.projectIndexPath);
  return {
    groups,
    projectGroup: getProjectGroupForChatFn(groups, message.chat.id),
  };
}

export async function loadThreadsByBindings(
  config,
  entries,
  { getThreadsByIdsFn = getThreadsByIds } = {},
) {
  const threadIds = entries
    .map(({ binding }) => String(binding?.threadId ?? "").trim())
    .filter(Boolean);
  const rows = await getThreadsByIdsFn(config.threadsDbPath, threadIds);
  return new Map(rows.map((row) => [String(row.id), row]));
}

export async function collectChatBindingDiagnostics(
  config,
  state,
  chatId,
  { getBindingsForChatFn = getBindingsForChat, loadThreadsByBindingsFn = loadThreadsByBindings } = {},
) {
  const entries = getBindingsForChatFn(state, chatId);
  if (!entries.length) {
    return {
      entries,
      threadsById: new Map(),
      issues: [],
    };
  }

  const threadsById = await loadThreadsByBindingsFn(config, entries);
  const issues = [];
  for (const { bindingKey, binding } of entries) {
    const threadId = String(binding?.threadId ?? "").trim();
    const thread = threadId ? threadsById.get(threadId) ?? null : null;
    if (!threadId) {
      issues.push(`- ${bindingKey}: missing threadId`);
      continue;
    }
    if (!thread) {
      issues.push(`- ${bindingKey}: thread ${threadId} missing in threads DB`);
      continue;
    }
    if (Number(thread.archived) !== 0) {
      issues.push(`- ${bindingKey}: thread ${threadId} archived`);
    }
  }
  return {
    entries,
    threadsById,
    issues,
  };
}

export async function buildSyncContext(
  config,
  state,
  message,
  requestedLimit,
  {
    loadProjectGroupForMessageFn = loadProjectGroupForMessage,
    buildSyncContextForProjectGroupFn = buildSyncContextForProjectGroup,
  } = {},
) {
  const { projectGroup } = await loadProjectGroupForMessageFn(config, message);
  if (!projectGroup) {
    return {
      projectGroup: null,
      diagnostics: null,
      plan: null,
    };
  }

  const context = await buildSyncContextForProjectGroupFn(config, state, projectGroup, requestedLimit);

  return {
    projectGroup,
    diagnostics: context.diagnostics,
    plan: context.plan,
  };
}

export async function buildSyncContextForProjectGroup(
  config,
  state,
  projectGroup,
  requestedLimit,
  {
    maxThreadAgeMs = 0,
    nowMs = Date.now(),
    threadScanLimit = null,
    collectChatBindingDiagnosticsFn = collectChatBindingDiagnostics,
    listProjectThreadsFn = listProjectThreads,
    buildProjectSyncPlanFn = buildProjectSyncPlan,
  } = {},
) {
  const diagnostics = await collectChatBindingDiagnosticsFn(config, state, projectGroup.chatId);
  const threads = await listProjectThreadsFn(config.threadsDbPath, projectGroup.projectRoot, {
    limit: threadScanLimit || requestedLimit,
  });
  const plan = buildProjectSyncPlanFn({
    entries: diagnostics.entries,
    threads,
    requestedLimit,
    maxThreadAgeMs,
    nowMs,
  });

  return {
    diagnostics,
    plan,
  };
}

export function formatBindingLine(entry, thread) {
  const tags = [];
  if (isSyncManagedBinding(entry.binding)) {
    tags.push(isClosedSyncBinding(entry.binding) ? "sync-parked" : "sync");
  } else {
    tags.push("manual");
  }
  if (entry.binding.transport) {
    tags.push(entry.binding.transport);
  }
  return `- topic ${entry.binding.messageThreadId ?? "direct"} -> ${sanitizeTopicTitle(
    thread?.title || entry.binding.threadTitle,
    entry.binding.threadId,
  )} (${entry.binding.threadId}) [${tags.join(", ")}]`;
}

export function renderSyncPreview(plan) {
  const lines = [
    `sync preview: keep ${plan.summary.keepCount}, rename ${plan.summary.renameCount}, reopen ${plan.summary.reopenCount}, create ${plan.summary.createCount}, park ${plan.summary.parkCount}`,
  ];

  if (plan.rename.length) {
    lines.push("", "**Rename sync topics**");
    for (const item of plan.rename) {
      lines.push(
        `- topic ${item.entry.binding.messageThreadId}: ${sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId)} -> ${sanitizeTopicTitle(item.thread.title, item.thread.id)}`,
      );
    }
  }

  if (plan.reopen.length) {
    lines.push("", "**Reopen parked sync topics**");
    for (const item of plan.reopen) {
      const action = item.renameNeeded ? "reopen + rename" : "reopen";
      lines.push(`- topic ${item.entry.binding.messageThreadId}: ${action} -> ${sanitizeTopicTitle(item.thread.title, item.thread.id)} (${item.thread.id})`);
    }
  }

  if (plan.create.length) {
    lines.push("", "**Create topics**");
    for (const item of plan.create) {
      lines.push(formatThreadBullet(item.thread));
    }
  }

  if (plan.park.length) {
    lines.push("", "**Park stale sync topics**");
    for (const item of plan.park) {
      lines.push(
        `- topic ${item.entry.binding.messageThreadId}: ${sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId)} (${item.entry.binding.threadId}) [${item.reason}]`,
      );
    }
  }

  if (
    plan.rename.length === 0 &&
    plan.reopen.length === 0 &&
    plan.create.length === 0 &&
    plan.park.length === 0
  ) {
    lines.push("", "sync preview: already aligned");
  }

  return lines.join("\n");
}

export async function renderProjectStatus(
  config,
  state,
  message,
  requestedLimit,
  { buildSyncContextFn = buildSyncContext } = {},
) {
  const { projectGroup, diagnostics, plan } = await buildSyncContextFn(config, state, message, requestedLimit);
  if (!projectGroup || !diagnostics || !plan) {
    return "I cannot find a project mapping for this group. Bootstrap is incomplete, or this chat id is different.";
  }

  const lines = [
    `**Project status:** ${projectGroup.groupTitle}`,
    `project root: \`${projectGroup.projectRoot}\``,
    `desired thread column: ${plan.summary.desiredCount}`,
    `active bindings in this chat: ${plan.summary.activeCount}`,
    `parked sync topics: ${plan.summary.parkedCount}`,
    `bootstrap topics: ${projectGroup.topics.length}`,
    `stale bindings: ${diagnostics.issues.length}`,
  ];

  if (plan.desiredThreads.length) {
    lines.push("", "**Desired thread column**");
    for (const thread of plan.desiredThreads) {
      lines.push(formatThreadBullet(thread));
    }
  } else {
    lines.push("", "Desired thread column: empty");
  }

  if (plan.activeEntries.length) {
    lines.push("", "**Current active topics**");
    for (const entry of plan.activeEntries.slice(0, 12)) {
      const thread = diagnostics.threadsById.get(String(entry.binding.threadId)) ?? null;
      lines.push(formatBindingLine(entry, thread));
    }
  } else {
    lines.push("", "Current active topics: none");
  }

  if (plan.parkedEntries.length) {
    lines.push("", "**Parked sync topics**");
    for (const entry of plan.parkedEntries.slice(0, 12)) {
      const thread = diagnostics.threadsById.get(String(entry.binding.threadId)) ?? null;
      lines.push(formatBindingLine(entry, thread));
    }
  }

  if (diagnostics.issues.length) {
    lines.push("", "**Stale bindings**");
    lines.push(...diagnostics.issues);
  }

  lines.push("", "**Sync plan**");
  lines.push(renderSyncPreview(plan));

  return lines.join("\n");
}

export function countSyncPlanActions(plan) {
  return (
    (plan?.rename?.length || 0) +
    (plan?.reopen?.length || 0) +
    (plan?.create?.length || 0) +
    (plan?.park?.length || 0)
  );
}

export function formatSyncApplyResult({ projectGroup, changed, plan }) {
  const lines = [
    `Synced the working set for ${projectGroup.groupTitle}.`,
    `rename ${changed.renamed.length}, reopen ${changed.reopened.length}, create ${changed.created.length}, park ${plan.park.length}`,
  ];
  if (changed.renamed.length) {
    lines.push("", "**Renamed**");
    lines.push(...changed.renamed.map((item) => `- topic ${item.topicId}: ${item.title} -> ${item.threadId}`));
  }
  if (changed.reopened.length) {
    lines.push("", "**Reopened**");
    lines.push(...changed.reopened.map((item) => `- topic ${item.topicId}: ${item.title} -> ${item.threadId}`));
  }
  if (changed.created.length) {
    lines.push("", "**Created**");
    lines.push(...changed.created.map((item) => `- topic ${item.topicId}: ${item.title} -> ${item.threadId}`));
  }
  if (plan.park.length) {
    lines.push("", "**Parked**");
    const parkedLines = [
      ...changed.parked,
      ...changed.parkPending.map((item) => ({
        topicId: item.entry.binding.messageThreadId,
        title: sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId),
        threadId: String(item.entry.binding.threadId),
        reason: item.reason,
      })),
    ];
    lines.push(...parkedLines.map((item) => `- topic ${item.topicId}: ${item.title} -> ${item.threadId} [${item.reason}]`));
  }
  if (
    changed.renamed.length === 0 &&
    changed.reopened.length === 0 &&
    changed.created.length === 0 &&
    plan.park.length === 0
  ) {
    lines.push("", "Already aligned. Nothing had to change.");
  }
  return lines.join("\n");
}

export async function applyProjectSyncPlan({
  config,
  state,
  chatId,
  projectGroup,
  plan,
  currentBindingKey = null,
  sendResponse = null,
  now = new Date().toISOString(),
  editForumTopicFn = editForumTopic,
  reopenForumTopicFn = reopenForumTopic,
  createForumTopicFn = createForumTopic,
  closeForumTopicFn = closeForumTopic,
  logEventFn = logBridgeEvent,
}) {
  const parkCurrentTopic = new Set(
    plan.park
      .filter((item) => currentBindingKey && item.entry.bindingKey === currentBindingKey)
      .map((item) => item.entry.bindingKey),
  );
  const parkBeforeReply = plan.park.filter((item) => !parkCurrentTopic.has(item.entry.bindingKey));
  const parkAfterReply = plan.park.filter((item) => parkCurrentTopic.has(item.entry.bindingKey));
  const changed = {
    renamed: [],
    reopened: [],
    created: [],
    parked: [],
    parkPending: parkAfterReply,
  };

  for (const item of plan.rename) {
    const nextTitle = sanitizeTopicTitle(item.thread.title, item.thread.id);
    await editForumTopicFn(config.botToken, {
      chatId,
      messageThreadId: item.entry.binding.messageThreadId,
      name: nextTitle,
    });
    state.bindings[item.entry.bindingKey] = {
      ...item.entry.binding,
      threadTitle: nextTitle,
      syncManaged: true,
      syncState: "active",
      topicStatus: "open",
      updatedAt: now,
      lastSyncedAt: now,
    };
    changed.renamed.push({
      topicId: item.entry.binding.messageThreadId,
      title: nextTitle,
      threadId: String(item.thread.id),
    });
  }

  for (const item of plan.reopen) {
    await reopenForumTopicFn(config.botToken, {
      chatId,
      messageThreadId: item.entry.binding.messageThreadId,
    });
    const nextTitle = sanitizeTopicTitle(item.thread.title, item.thread.id);
    if (item.renameNeeded) {
      await editForumTopicFn(config.botToken, {
        chatId,
        messageThreadId: item.entry.binding.messageThreadId,
        name: nextTitle,
      });
    }
    state.bindings[item.entry.bindingKey] = {
      ...item.entry.binding,
      threadTitle: nextTitle,
      syncManaged: true,
      syncState: "active",
      topicStatus: "open",
      updatedAt: now,
      lastSyncedAt: now,
    };
    changed.reopened.push({
      topicId: item.entry.binding.messageThreadId,
      title: nextTitle,
      threadId: String(item.thread.id),
    });
  }

  for (const item of plan.create) {
    const { thread } = item;
    const topicTitle = sanitizeTopicTitle(thread.title, thread.id);
    const topic = await createForumTopicFn(config.botToken, {
      chatId,
      name: topicTitle,
    });
    const topicId = Number(topic?.message_thread_id);
    if (!Number.isInteger(topicId)) {
      throw new Error(`createForumTopic returned invalid message_thread_id for ${thread.id}`);
    }
    const topicBindingKey = makeBindingKey({
      chatId,
      messageThreadId: topicId,
    });
    setBinding(state, topicBindingKey, {
      ...buildBindingPayload({
        message: {
          chat: { id: chatId, title: projectGroup.groupTitle },
          message_thread_id: topicId,
        },
        thread,
        chatTitle: projectGroup.groupTitle,
      }),
      createdBy: SYNC_PROJECT_CREATOR,
      syncManaged: true,
      syncState: "active",
      topicStatus: "open",
      lastSyncedAt: now,
    });
    changed.created.push({
      topicId,
      title: topicTitle,
      threadId: String(thread.id),
    });
  }

  for (const item of parkBeforeReply) {
    await closeForumTopicFn(config.botToken, {
      chatId,
      messageThreadId: item.entry.binding.messageThreadId,
    });
    state.bindings[item.entry.bindingKey] = {
      ...item.entry.binding,
      syncManaged: true,
      syncState: "closed",
      topicStatus: "closed",
      updatedAt: now,
      lastSyncedAt: now,
    };
    changed.parked.push({
      topicId: item.entry.binding.messageThreadId,
      title: sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId),
      threadId: String(item.entry.binding.threadId),
      reason: item.reason,
    });
  }

  if (sendResponse) {
    await sendResponse(formatSyncApplyResult({ projectGroup, changed, plan }));
  }

  for (const item of parkAfterReply) {
    try {
      await closeForumTopicFn(config.botToken, {
        chatId,
        messageThreadId: item.entry.binding.messageThreadId,
      });
      state.bindings[item.entry.bindingKey] = {
        ...item.entry.binding,
        syncManaged: true,
        syncState: "closed",
        topicStatus: "closed",
        updatedAt: now,
        lastSyncedAt: now,
      };
      changed.parked.push({
        topicId: item.entry.binding.messageThreadId,
        title: sanitizeTopicTitle(item.entry.binding.threadTitle, item.entry.binding.threadId),
        threadId: String(item.entry.binding.threadId),
        reason: item.reason,
      });
    } catch (error) {
      logEventFn("sync_project_park_after_reply_error", {
        chatId,
        messageThreadId: item.entry.binding.messageThreadId,
        threadId: item.entry.binding.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const actionCount = countSyncPlanActions(plan);
  return {
    changed: actionCount > 0,
    actionCount,
    details: changed,
  };
}

export async function syncAutoProjectTopics({
  config,
  state,
  nowMs = Date.now(),
  loadProjectIndexFn = loadProjectIndex,
  buildSyncContextForProjectGroupFn = buildSyncContextForProjectGroup,
  applyProjectSyncPlanFn = applyProjectSyncPlan,
  logEventFn = logBridgeEvent,
} = {}) {
  if (config.topicAutoSyncEnabled !== true) {
    return { changed: false, checked: 0, actionCount: 0 };
  }

  const groups = await loadProjectIndexFn(config.projectIndexPath);
  const requestedLimit = clamp(parsePositiveInt(config.topicAutoSyncLimit, config.syncDefaultLimit), 1, 10);
  const maxActions = Math.max(1, Number(config.topicAutoSyncMaxActionsPerTick) || 1);
  let checked = 0;
  let actionCount = 0;
  let changed = false;

  for (const projectGroup of groups) {
    if (actionCount >= maxActions) {
      break;
    }
    if (!projectGroup.chatId || !projectGroup.projectRoot) {
      continue;
    }
    checked += 1;
    const { plan } = await buildSyncContextForProjectGroupFn(config, state, projectGroup, requestedLimit, {
      maxThreadAgeMs: config.topicAutoSyncMaxThreadAgeMs,
      nowMs,
      threadScanLimit: Math.min(50, Math.max(requestedLimit * 4, requestedLimit)),
    });
    const planActions = countSyncPlanActions(plan);
    if (planActions === 0) {
      continue;
    }
    if (actionCount + planActions > maxActions) {
      logEventFn("topic_auto_sync_skipped_project", {
        chatId: projectGroup.chatId,
        projectRoot: projectGroup.projectRoot,
        actionCount: planActions,
        remainingActionBudget: maxActions - actionCount,
      });
      continue;
    }
    const result = await applyProjectSyncPlanFn({
      config,
      state,
      chatId: projectGroup.chatId,
      projectGroup,
      plan,
    });
    actionCount += result.actionCount;
    changed = changed || result.changed;
    logEventFn("topic_auto_sync_project_applied", {
      chatId: projectGroup.chatId,
      projectRoot: projectGroup.projectRoot,
      desiredCount: plan.summary.desiredCount,
      renameCount: plan.summary.renameCount,
      reopenCount: plan.summary.reopenCount,
      createCount: plan.summary.createCount,
      parkCount: plan.summary.parkCount,
    });
  }

  return { changed, checked, actionCount };
}
