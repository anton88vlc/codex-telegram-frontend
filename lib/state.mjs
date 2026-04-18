import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE = {
  version: 1,
  lastUpdateId: 0,
  bindings: {},
  processedMessageKeys: [],
  outboundMirrors: {},
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
    outboundMirrors:
      parsed?.outboundMirrors && typeof parsed.outboundMirrors === "object" ? parsed.outboundMirrors : {},
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

export function getOutboundMirror(state, bindingKey) {
  return state.outboundMirrors?.[bindingKey] ?? null;
}

export function setOutboundMirror(state, bindingKey, mirror) {
  if (!state.outboundMirrors || typeof state.outboundMirrors !== "object") {
    state.outboundMirrors = {};
  }
  state.outboundMirrors[bindingKey] = mirror;
  return state.outboundMirrors[bindingKey];
}

export function removeOutboundMirror(state, bindingKey) {
  if (!state.outboundMirrors || typeof state.outboundMirrors !== "object") {
    return;
  }
  delete state.outboundMirrors[bindingKey];
}

function ensureMirrorRecord(state, bindingKey) {
  if (!state.outboundMirrors || typeof state.outboundMirrors !== "object") {
    state.outboundMirrors = {};
  }
  if (!state.outboundMirrors[bindingKey] || typeof state.outboundMirrors[bindingKey] !== "object") {
    state.outboundMirrors[bindingKey] = {};
  }
  return state.outboundMirrors[bindingKey];
}

export function rememberOutboundSuppression(state, bindingKey, signature, { limit = 8 } = {}) {
  const normalized = String(signature ?? "").trim();
  if (!normalized) {
    return [];
  }
  const mirror = ensureMirrorRecord(state, bindingKey);
  const next = Array.isArray(mirror.suppressions) ? mirror.suppressions.filter((item) => item !== normalized) : [];
  next.push(normalized);
  mirror.suppressions = next.slice(-limit);
  return mirror.suppressions;
}

export function consumeOutboundSuppression(state, bindingKey, signature) {
  const normalized = String(signature ?? "").trim();
  if (!normalized) {
    return false;
  }
  const mirror = getOutboundMirror(state, bindingKey);
  if (!mirror || !Array.isArray(mirror.suppressions) || !mirror.suppressions.includes(normalized)) {
    return false;
  }
  mirror.suppressions = mirror.suppressions.filter((item) => item !== normalized);
  return true;
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
