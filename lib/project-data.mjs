import fs from "node:fs/promises";

import { normalizeText } from "./message-routing.mjs";
import { isActiveBinding } from "./project-sync.mjs";

export async function readJsonIfExists(filePath, fallback = null) {
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

export async function loadProjectIndex(projectIndexPath) {
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

export function getProjectGroupForChat(groups, chatId) {
  return groups.find((group) => String(group.chatId) === String(chatId)) ?? null;
}

export function getBoundThreadIdsForChat(state, chatId, { includeInactive = false } = {}) {
  const ids = new Set();
  for (const binding of Object.values(state.bindings ?? {})) {
    if (!includeInactive && !isActiveBinding(binding)) {
      continue;
    }
    if (String(binding?.chatId) === String(chatId) && binding?.threadId) {
      ids.add(String(binding.threadId));
    }
  }
  return ids;
}

export function getBindingsForChat(state, chatId, { includeInactive = true } = {}) {
  return Object.entries(state.bindings ?? {})
    .filter(([, binding]) => {
      if (String(binding?.chatId) !== String(chatId)) {
        return false;
      }
      if (!includeInactive && !isActiveBinding(binding)) {
        return false;
      }
      return true;
    })
    .map(([bindingKey, binding]) => ({
      bindingKey,
      binding,
    }))
    .sort((left, right) => {
      const leftTopic = Number(left?.binding?.messageThreadId ?? Number.MAX_SAFE_INTEGER);
      const rightTopic = Number(right?.binding?.messageThreadId ?? Number.MAX_SAFE_INTEGER);
      return leftTopic - rightTopic;
    });
}
