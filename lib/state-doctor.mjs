import fs from "node:fs/promises";
import path from "node:path";

import { isThreadDbOptionalBinding } from "./binding-classification.mjs";
import { readRecentBridgeEvents } from "./bridge-events.mjs";
import { makeBindingKey, removeBinding, removeOutboundMirror } from "./state.mjs";
import { getThreadsByIds } from "./thread-db.mjs";

function cleanText(value) {
  return String(value ?? "").trim();
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

function normalizeProjectIndex(projectIndex) {
  return {
    ...(projectIndex && typeof projectIndex === "object" ? projectIndex : {}),
    groups: Array.isArray(projectIndex?.groups) ? projectIndex.groups : [],
  };
}

function groupChatId(group) {
  return cleanText(group?.botApiChatId ?? group?.chatId);
}

function topicId(topic) {
  const value = topic?.topicId ?? topic?.messageThreadId ?? topic?.telegramTopicId;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function topicBindingKey(group, topic) {
  const chatId = groupChatId(group);
  const messageThreadId = topicId(topic);
  if (!chatId || messageThreadId == null) {
    return null;
  }
  return makeBindingKey({ chatId, messageThreadId });
}

function isGroupTopicBinding(binding) {
  return cleanText(binding?.chatId) && binding?.messageThreadId != null;
}

function bindingAgeMs(binding) {
  return Math.max(Date.parse(binding?.updatedAt || "") || 0, Date.parse(binding?.createdAt || "") || 0);
}

function isActiveBinding(binding) {
  return Boolean(binding && !binding.detached && binding.syncState !== "closed" && binding.topicStatus !== "closed");
}

function isMissingTopicEvent(event) {
  return Boolean(
    event?.bindingKey &&
      /message thread not found|message_id_invalid|topic.*not found/i.test(cleanText(event.error)),
  );
}

function addAction(actionsById, action) {
  if (!action?.id || actionsById.has(action.id)) {
    return;
  }
  actionsById.set(action.id, action);
}

function addFinding(findings, finding) {
  findings.push({
    severity: "warning",
    ...finding,
  });
}

function makeTombstoneAction(bindingKey, reason) {
  return {
    id: `tombstone-binding:${bindingKey}`,
    type: "tombstone-binding",
    bindingKey,
    reason,
    safe: true,
  };
}

function makeRemoveMirrorAction(bindingKey, reason) {
  return {
    id: `remove-outbound-mirror:${bindingKey}`,
    type: "remove-outbound-mirror",
    bindingKey,
    reason,
    safe: true,
  };
}

function makePruneTopicAction({ chatId, topicId: messageThreadId, bindingKey, reason }) {
  return {
    id: `prune-bootstrap-topic:${chatId}:${messageThreadId}`,
    type: "prune-bootstrap-topic",
    chatId,
    messageThreadId,
    bindingKey,
    reason,
    safe: true,
  };
}

function makePruneGroupAction({ chatId, reason }) {
  return {
    id: `prune-bootstrap-group:${chatId}`,
    type: "prune-bootstrap-group",
    chatId,
    reason,
    safe: true,
  };
}

function summarize({ findings, actions, bindingCount, bootstrapGroupCount }) {
  const repairable = actions.filter((action) => action.safe !== false).length;
  return {
    findings: findings.length,
    repairable,
    bindings: bindingCount,
    bootstrapGroups: bootstrapGroupCount,
  };
}

export async function loadStateDoctorInputs(config, state, { recentEvents = null } = {}) {
  const projectIndex = normalizeProjectIndex(await readJsonIfExists(config.projectIndexPath, { groups: [] }));
  const bindingThreadIds = [
    ...new Set(
      Object.values(state.bindings ?? {})
        .map((binding) => cleanText(binding?.threadId))
        .filter(Boolean),
    ),
  ];
  const threads = bindingThreadIds.length ? await getThreadsByIds(config.threadsDbPath, bindingThreadIds) : [];
  const events =
    Array.isArray(recentEvents)
      ? recentEvents
      : await readRecentBridgeEvents(config.eventLogPath || config.bridgeLogPath).catch(() => []);
  return {
    projectIndex,
    threads,
    recentEvents: events,
  };
}

export async function inspectStateDoctor({ config, state, recentEvents = null } = {}) {
  const inputs = await loadStateDoctorInputs(config, state, { recentEvents });
  return buildStateDoctorReport({
    state,
    projectIndex: inputs.projectIndex,
    threads: inputs.threads,
    recentEvents: inputs.recentEvents,
  });
}

export function buildStateDoctorReport({ state = {}, projectIndex = { groups: [] }, threads = [], recentEvents = [] } = {}) {
  const bindings = state.bindings && typeof state.bindings === "object" ? state.bindings : {};
  const outboundMirrors = state.outboundMirrors && typeof state.outboundMirrors === "object" ? state.outboundMirrors : {};
  const normalizedProjectIndex = normalizeProjectIndex(projectIndex);
  const threadsById = new Map((Array.isArray(threads) ? threads : []).map((thread) => [String(thread.id), thread]));
  const findings = [];
  const actionsById = new Map();

  const deadTopicBindingKeys = new Set(
    (Array.isArray(recentEvents) ? recentEvents : []).filter(isMissingTopicEvent).map((event) => cleanText(event.bindingKey)),
  );

  for (const [bindingKey, binding] of Object.entries(bindings)) {
    const threadId = cleanText(binding?.threadId);
    if (!threadId) {
      const action = makeTombstoneAction(bindingKey, "binding has no threadId");
      addAction(actionsById, action);
      addFinding(findings, {
        kind: "binding-missing-thread-id",
        bindingKey,
        message: `${bindingKey}: missing threadId`,
        actionId: action.id,
      });
      continue;
    }
    const thread = threadsById.get(threadId);
    if (!thread) {
      if (isThreadDbOptionalBinding(binding)) {
        continue;
      }
      const action = makeTombstoneAction(bindingKey, `thread ${threadId} missing in threads DB`);
      addAction(actionsById, action);
      addFinding(findings, {
        kind: "binding-missing-thread",
        bindingKey,
        threadId,
        message: `${bindingKey}: thread ${threadId} missing in threads DB`,
        actionId: action.id,
      });
      continue;
    }
    if (Number(thread.archived) !== 0) {
      const action = makeTombstoneAction(bindingKey, `thread ${threadId} is archived`);
      addAction(actionsById, action);
      addFinding(findings, {
        kind: "binding-archived-thread",
        bindingKey,
        threadId,
        message: `${bindingKey}: thread ${threadId} is archived`,
        actionId: action.id,
      });
    }
    if (deadTopicBindingKeys.has(bindingKey)) {
      const action = makeTombstoneAction(bindingKey, "Telegram reported message thread not found");
      addAction(actionsById, action);
      addFinding(findings, {
        kind: "binding-dead-telegram-topic",
        bindingKey,
        threadId,
        message: `${bindingKey}: Telegram recently reported message thread not found`,
        actionId: action.id,
      });
    }
  }

  const activeTopicBindingsByThread = new Map();
  for (const [bindingKey, binding] of Object.entries(bindings)) {
    if (!isGroupTopicBinding(binding) || !isActiveBinding(binding)) {
      continue;
    }
    const threadId = cleanText(binding.threadId);
    if (!threadId) {
      continue;
    }
    const list = activeTopicBindingsByThread.get(threadId) || [];
    list.push({ bindingKey, binding });
    activeTopicBindingsByThread.set(threadId, list);
  }
  for (const [threadId, entries] of activeTopicBindingsByThread.entries()) {
    if (entries.length <= 1) {
      continue;
    }
    entries.sort((left, right) => bindingAgeMs(right.binding) - bindingAgeMs(left.binding));
    addFinding(findings, {
      kind: "duplicate-active-topic-binding",
      severity: "notice",
      threadId,
      bindingKey: entries[0].bindingKey,
      message: `thread ${threadId} has ${entries.length} active Telegram topic bindings: ${entries
        .map((entry) => entry.bindingKey)
        .join(", ")}`,
    });
  }

  for (const bindingKey of Object.keys(outboundMirrors)) {
    if (bindings[bindingKey]) {
      continue;
    }
    const action = makeRemoveMirrorAction(bindingKey, "outbound mirror has no matching binding");
    addAction(actionsById, action);
    addFinding(findings, {
      kind: "orphan-outbound-mirror",
      bindingKey,
      message: `${bindingKey}: outbound mirror has no matching binding`,
      actionId: action.id,
    });
  }

  const liveBindingKeys = new Set(Object.keys(bindings));
  const groupTopicCounts = new Map();
  const staleTopicCounts = new Map();
  for (const group of normalizedProjectIndex.groups) {
    const chatId = groupChatId(group);
    const topics = Array.isArray(group.topics) ? group.topics : [];
    groupTopicCounts.set(chatId, topics.length);
    for (const topic of topics) {
      const messageThreadId = topicId(topic);
      const bindingKey = topicBindingKey(group, topic);
      if (!chatId || messageThreadId == null || !bindingKey) {
        continue;
      }
      if (!liveBindingKeys.has(bindingKey)) {
        staleTopicCounts.set(chatId, (staleTopicCounts.get(chatId) || 0) + 1);
        const action = makePruneTopicAction({
          chatId,
          topicId: messageThreadId,
          bindingKey,
          reason: "bootstrap topic has no live binding",
        });
        addAction(actionsById, action);
        addFinding(findings, {
          kind: "bootstrap-topic-without-binding",
          bindingKey,
          chatId,
          messageThreadId,
          message: `${bindingKey}: bootstrap topic has no live binding`,
          actionId: action.id,
        });
      }
    }
  }

  for (const group of normalizedProjectIndex.groups) {
    const chatId = groupChatId(group);
    if (!chatId) {
      continue;
    }
    const topicCount = groupTopicCounts.get(chatId) || 0;
    const staleCount = staleTopicCounts.get(chatId) || 0;
    const hasLiveBinding = Object.values(bindings).some((binding) => String(binding?.chatId) === chatId);
    if (topicCount > 0 && staleCount === topicCount && !hasLiveBinding) {
      const action = makePruneGroupAction({ chatId, reason: "bootstrap group has no live bound topics" });
      addAction(actionsById, action);
      addFinding(findings, {
        kind: "bootstrap-group-without-bindings",
        chatId,
        message: `${group.groupTitle || chatId}: bootstrap group has no live bound topics`,
        actionId: action.id,
      });
    }
  }

  const report = {
    ok: findings.length === 0,
    findings,
    actions: [...actionsById.values()],
  };
  report.summary = summarize({
    findings: report.findings,
    actions: report.actions,
    bindingCount: Object.keys(bindings).length,
    bootstrapGroupCount: normalizedProjectIndex.groups.length,
  });
  return report;
}

export function applyStateDoctorActions({ state, projectIndex, actions = [] } = {}) {
  const normalizedProjectIndex = normalizeProjectIndex(projectIndex);
  const applied = [];
  const skipped = [];

  for (const action of actions) {
    if (!action?.safe) {
      skipped.push({ ...action, skippedReason: "not marked safe" });
      continue;
    }
    if (action.type === "tombstone-binding" && action.bindingKey) {
      removeBinding(state, action.bindingKey);
      removeOutboundMirror(state, action.bindingKey);
      applied.push(action);
      continue;
    }
    if (action.type === "remove-outbound-mirror" && action.bindingKey) {
      removeOutboundMirror(state, action.bindingKey);
      applied.push(action);
      continue;
    }
    if (action.type === "prune-bootstrap-topic" && action.chatId && action.messageThreadId != null) {
      for (const group of normalizedProjectIndex.groups) {
        if (groupChatId(group) !== String(action.chatId) || !Array.isArray(group.topics)) {
          continue;
        }
        group.topics = group.topics.filter((topic) => topicId(topic) !== Number(action.messageThreadId));
      }
      applied.push(action);
      continue;
    }
    if (action.type === "prune-bootstrap-group" && action.chatId) {
      normalizedProjectIndex.groups = normalizedProjectIndex.groups.filter((group) => groupChatId(group) !== String(action.chatId));
      applied.push(action);
      continue;
    }
    skipped.push({ ...action, skippedReason: "unknown action" });
  }

  return {
    state,
    projectIndex: normalizedProjectIndex,
    applied,
    skipped,
  };
}

export async function writeStateDoctorProjectIndex(projectIndexPath, projectIndex) {
  await writeJsonAtomic(projectIndexPath, normalizeProjectIndex(projectIndex));
}

export function formatStateDoctorReport(report, { applied = null } = {}) {
  const lines = [
    report.ok ? "STATE DOCTOR OK" : "STATE DOCTOR NEEDS REPAIR",
    `bindings: ${report.summary.bindings}; bootstrap groups: ${report.summary.bootstrapGroups}; findings: ${report.summary.findings}; safe repairs: ${report.summary.repairable}`,
  ];

  if (report.findings.length) {
    lines.push("", "Findings:");
    for (const finding of report.findings) {
      const action = finding.actionId ? `; repair ${finding.actionId}` : "";
      lines.push(`- ${finding.severity || "warning"} ${finding.kind}: ${finding.message}${action}`);
    }
  }

  if (report.actions.length) {
    lines.push("", "Safe repair plan:");
    for (const action of report.actions) {
      lines.push(`- ${action.type}: ${action.bindingKey || action.chatId || action.id} (${action.reason})`);
    }
  }

  if (applied) {
    lines.push("", `Applied: ${applied.applied.length}; skipped: ${applied.skipped.length}`);
  } else if (report.actions.length) {
    lines.push("", "Run with `--apply` to write only local state/index repairs. No Telegram messages are deleted.");
  }

  return lines.join("\n");
}
