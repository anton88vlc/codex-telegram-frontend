import path from "node:path";

import { sanitizeTopicTitle } from "./project-sync.mjs";

export const DEFAULT_GROUP_PREFIX = "Codex - ";
export const DEFAULT_THREADS_PER_PROJECT = 3;
export const DEFAULT_HISTORY_MAX_MESSAGES = 40;
export const DEFAULT_HISTORY_ASSISTANT_PHASES = ["final_answer"];

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

export function buildBootstrapPlan(projects, {
  generatedAt = new Date().toISOString(),
  threadsPerProject = DEFAULT_THREADS_PER_PROJECT,
  historyMaxMessages = DEFAULT_HISTORY_MAX_MESSAGES,
  historyAssistantPhases = DEFAULT_HISTORY_ASSISTANT_PHASES,
} = {}) {
  return {
    version: 1,
    generatedAt,
    onboarding: {
      threadsPerProject,
      historyMaxMessages,
      historyAssistantPhases,
      note: "Preview first. Bootstrap creates Telegram groups/topics; backfill imports only clean user prompts + final answers.",
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
  const lines = [
    `Bootstrap plan: ${plan.projects?.length ?? 0} project(s)`,
    `history: last ${plan.onboarding?.historyMaxMessages ?? DEFAULT_HISTORY_MAX_MESSAGES} clean messages, assistant phases: ${(plan.onboarding?.historyAssistantPhases ?? DEFAULT_HISTORY_ASSISTANT_PHASES).join(", ")}`,
  ];
  for (const project of plan.projects ?? []) {
    lines.push(`- ${project.groupTitle}: ${project.topics.length} topic(s)`);
    for (const topic of project.topics) {
      lines.push(`  - ${topic.title} (${topic.threadId})`);
    }
  }
  return lines.join("\n");
}
