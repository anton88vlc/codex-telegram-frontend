import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE = {
  version: 1,
  lastUpdateId: 0,
  bindings: {},
  processedMessageKeys: [],
};

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

async function readJsonIfExists(filePath, fallback) {
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

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function loadState(statePath) {
  const parsed = await readJsonIfExists(statePath, cloneDefaultState());
  const state = {
    version: Number.isInteger(parsed?.version) ? parsed.version : 1,
    lastUpdateId: Number.isInteger(parsed?.lastUpdateId) ? parsed.lastUpdateId : 0,
    bindings: parsed?.bindings && typeof parsed.bindings === "object" ? parsed.bindings : {},
    processedMessageKeys: Array.isArray(parsed?.processedMessageKeys)
      ? parsed.processedMessageKeys.map(String)
      : [],
  };
  return state;
}

export async function saveState(statePath, state) {
  await writeJsonAtomic(statePath, state);
}

export function makeBindingKey({ chatId, messageThreadId }) {
  if (messageThreadId != null) {
    return `group:${String(chatId)}:topic:${Number(messageThreadId)}`;
  }
  return `direct:${String(chatId)}`;
}

export function getBinding(state, bindingKey) {
  return state.bindings[bindingKey] ?? null;
}

export function setBinding(state, bindingKey, binding) {
  state.bindings[bindingKey] = binding;
  return state.bindings[bindingKey];
}

export function removeBinding(state, bindingKey) {
  delete state.bindings[bindingKey];
}

export function makeMessageKey(message) {
  return `${String(message?.chat?.id)}:${String(message?.message_id)}`;
}

export function hasProcessedMessage(state, messageKey) {
  return state.processedMessageKeys.includes(String(messageKey));
}

export function markProcessedMessage(state, messageKey, { limit = 500 } = {}) {
  const normalized = String(messageKey);
  const next = state.processedMessageKeys.filter((item) => item !== normalized);
  next.push(normalized);
  state.processedMessageKeys = next.slice(-limit);
  return state.processedMessageKeys;
}
