import path from "node:path";

import { sanitizeTopicTitle } from "./project-sync.mjs";

export const DEFAULT_GROUP_PREFIX = "Codex - ";
export const DEFAULT_FOLDER_TITLE = "codex";
export const DEFAULT_REHEARSAL_GROUP_PREFIX = "Codex Lab - ";
export const DEFAULT_REHEARSAL_FOLDER_TITLE = "codex-lab";
export const DEFAULT_TOPIC_DISPLAY = "tabs";
export const DEFAULT_THREADS_PER_PROJECT = 3;
export const PRIVATE_CHAT_TOPICS_SURFACE = "private-chat-topics";
export const DEFAULT_HISTORY_MAX_MESSAGES = 40;
export const DEFAULT_HISTORY_MAX_USER_PROMPTS = null;
export const DEFAULT_HISTORY_ASSISTANT_PHASES = ["final_answer"];
export const DEFAULT_HISTORY_INCLUDE_HEARTBEATS = false;

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function projectNameFromRoot(projectRoot) {
  const normalized = normalizeText(projectRoot).replace(/\/+$/, "");
  if (!normalized) {
    return "project";
  }
  return path.basename(normalized) || normalized.replaceAll("/", "_");
}

export function buildGroupTitle(projectRoot, { groupPrefix = DEFAULT_GROUP_PREFIX } = {}) {
  return `${groupPrefix}${projectNameFromRoot(projectRoot)}`;
}

export function buildProjectPlan(projectRoot, threads, {
  threadsPerProject = DEFAULT_THREADS_PER_PROJECT,
  groupPrefix = DEFAULT_GROUP_PREFIX,
} = {}) {
  const normalizedRoot = normalizeText(projectRoot);
  const topicLimit = Math.max(1, Number.parseInt(String(threadsPerProject), 10) || DEFAULT_THREADS_PER_PROJECT);
  const selectedThreads = (Array.isArray(threads) ? threads : []).slice(0, topicLimit);
  return {
    projectRoot: normalizedRoot,
    groupTitle: buildGroupTitle(normalizedRoot, { groupPrefix }),
    about: `Remote frontend for the ${projectNameFromRoot(normalizedRoot)} Codex project.`,
    topics: selectedThreads.map((thread) => ({
      title: sanitizeTopicTitle(thread?.title, thread?.id),
      threadId: String(thread?.id ?? ""),
    })).filter((topic) => topic.threadId),
  };
}

export function buildPrivateChatTopicsPlan(threads, {
  chatId,
  title = "Codex - Chats",
  threadLimit = 5,
} = {}) {
  const selectedThreads = (Array.isArray(threads) ? threads : []).slice(
    0,
    Math.max(1, Number.parseInt(String(threadLimit), 10) || 5),
  );
  return {
    surface: PRIVATE_CHAT_TOPICS_SURFACE,
    projectRoot: "",
    groupTitle: title,
    about: "Projectless Codex Desktop chats in the bot direct chat.",
    botApiChatId: chatId != null ? String(chatId) : null,
    topics: selectedThreads.map((thread) => ({
      title: sanitizeTopicTitle(thread?.title, thread?.id),
      threadId: String(thread?.id ?? ""),
    })).filter((topic) => topic.threadId),
  };
}

export function buildBootstrapPlan(projects, {
  generatedAt = new Date().toISOString(),
  threadsPerProject = DEFAULT_THREADS_PER_PROJECT,
  historyMaxMessages = DEFAULT_HISTORY_MAX_MESSAGES,
  historyMaxUserPrompts = DEFAULT_HISTORY_MAX_USER_PROMPTS,
  historyAssistantPhases = DEFAULT_HISTORY_ASSISTANT_PHASES,
  historyIncludeHeartbeats = DEFAULT_HISTORY_INCLUDE_HEARTBEATS,
  groupPrefix = DEFAULT_GROUP_PREFIX,
  folderTitle = DEFAULT_FOLDER_TITLE,
  topicDisplay = DEFAULT_TOPIC_DISPLAY,
  rehearsal = false,
} = {}) {
  return {
    version: 1,
    generatedAt,
    onboarding: {
      rehearsal,
      groupPrefix,
      folderTitle,
      topicDisplay,
      threadsPerProject,
      historyMaxMessages,
      historyMaxUserPrompts,
      historyAssistantPhases,
      historyIncludeHeartbeats,
      note: "Preview first. Bootstrap creates Telegram groups/topics; backfill imports only the configured clean history tail.",
    },
    projects: (Array.isArray(projects) ? projects : []).filter((project) => project?.topics?.length),
  };
}

export function formatScanSummary(projectsWithThreads) {
  const lines = ["Codex projects found:"];
  for (const [index, item] of (Array.isArray(projectsWithThreads) ? projectsWithThreads : []).entries()) {
    lines.push(`${index + 1}. ${item.projectRoot} (${item.threadCount ?? item.threads?.length ?? 0} threads)`);
    for (const thread of (item.threads ?? []).slice(0, 5)) {
      lines.push(`   - ${sanitizeTopicTitle(thread.title, thread.id)} (${thread.id})`);
    }
  }
  if (lines.length === 1) {
    lines.push("No active Codex projects found.");
  }
  return lines.join("\n");
}

export function formatBootstrapPlanSummary(plan) {
  const hasPrivateChatTopics = (plan.projects ?? []).some((project) => project?.surface === PRIVATE_CHAT_TOPICS_SURFACE);
  const lines = [
    `Bootstrap plan: ${plan.projects?.length ?? 0} ${hasPrivateChatTopics ? "surface(s)" : "project(s)"}`,
    `surface: folder ${plan.onboarding?.folderTitle ?? DEFAULT_FOLDER_TITLE}, group prefix ${JSON.stringify(plan.onboarding?.groupPrefix ?? DEFAULT_GROUP_PREFIX)}`,
    `topics: display as ${plan.onboarding?.topicDisplay ?? DEFAULT_TOPIC_DISPLAY}`,
    `history: last ${plan.onboarding?.historyMaxMessages ?? DEFAULT_HISTORY_MAX_MESSAGES} clean messages, assistant phases: ${(plan.onboarding?.historyAssistantPhases ?? DEFAULT_HISTORY_ASSISTANT_PHASES).join(", ")}`,
  ];
  if (plan.onboarding?.historyMaxUserPrompts) {
    lines.push(`history user prompt cap: ${plan.onboarding.historyMaxUserPrompts}`);
  }
  if (plan.onboarding?.historyIncludeHeartbeats) {
    lines.push("history includes heartbeat/system-like user messages");
  }
  for (const project of plan.projects ?? []) {
    const surface = project.surface === PRIVATE_CHAT_TOPICS_SURFACE ? " (private chat topics)" : "";
    lines.push(`- ${project.groupTitle}${surface}: ${project.topics.length} topic(s)`);
    for (const topic of project.topics) {
      lines.push(`  - ${topic.title} (${topic.threadId})`);
    }
  }
  return lines.join("\n");
}
