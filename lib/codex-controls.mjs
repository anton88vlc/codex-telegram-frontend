import { AppServerLiveStream } from "./app-server-live.mjs";
import { normalizeText } from "./message-routing.mjs";

const DEFAULT_CONTROL_TIMEOUT_MS = 3_000;
const CONFIG_KEYS = {
  model: "model",
  reasoning: "model_reasoning_effort",
  fast: "service_tier",
};
const REASONING_ALIASES = new Map([
  ["off", "none"],
  ["false", "none"],
  ["0", "none"],
  ["minimal", "minimal"],
  ["min", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["med", "medium"],
  ["normal", "medium"],
  ["high", "high"],
  ["extra", "xhigh"],
  ["extra high", "xhigh"],
  ["extra-high", "xhigh"],
  ["x-high", "xhigh"],
  ["xhigh", "xhigh"],
]);
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

function appServerControlTimeoutMs(config = {}) {
  const explicit = Number(config.appServerControlTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const streamTimeout = Number(config.appServerStreamConnectTimeoutMs);
  if (Number.isFinite(streamTimeout) && streamTimeout > 0) {
    return streamTimeout;
  }
  return DEFAULT_CONTROL_TIMEOUT_MS;
}

async function withAppServerControl(config, callback) {
  const client = new AppServerLiveStream({
    url: config.appServerUrl,
    clientInfo: {
      name: "codex-telegram-frontend-controls",
      title: "Codex Telegram Frontend Controls",
      version: "0.1.0",
    },
    connectTimeoutMs: appServerControlTimeoutMs(config),
    reconnectMs: 0,
    maxQueuedEvents: 50,
  });
  try {
    await client.ensureConnected();
    return await callback(client);
  } finally {
    await client.close();
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeReasoningEffort(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[_]+/g, "-").replace(/\s+/g, " ");
  const mapped = REASONING_ALIASES.get(normalized) || normalized;
  return VALID_REASONING_EFFORTS.has(mapped) ? mapped : null;
}

export function normalizeFastMode(value, { current = false } = {}) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return !current;
  }
  if (["on", "true", "1", "yes", "fast"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "0", "no", "standard", "normal"].includes(normalized)) {
    return false;
  }
  return null;
}

export function currentFastMode(codexConfig = {}) {
  return normalizeText(codexConfig.service_tier).toLowerCase() === "fast";
}

export function findModel(models, requestedModel) {
  const requested = normalizeText(requestedModel).toLowerCase();
  if (!requested) {
    return null;
  }
  return (
    asArray(models).find((model) => normalizeText(model.id).toLowerCase() === requested) ||
    asArray(models).find((model) => normalizeText(model.model).toLowerCase() === requested) ||
    asArray(models).find((model) => normalizeText(model.displayName).toLowerCase() === requested) ||
    null
  );
}

export function getCurrentModel(models, codexConfig = {}) {
  return findModel(models, codexConfig.model) || asArray(models).find((model) => model?.isDefault) || null;
}

export function supportedReasoningEfforts(model) {
  return asArray(model?.supportedReasoningEfforts)
    .map((item) => normalizeReasoningEffort(item?.reasoningEffort))
    .filter(Boolean);
}

export async function readCodexControlState(config) {
  return withAppServerControl(config, async (client) => {
    const [configResult, modelsResult] = await Promise.all([
      client.request("config/read", {}),
      client.request("model/list", {}),
    ]);
    return {
      config: configResult?.config || {},
      models: asArray(modelsResult?.data),
    };
  });
}

export async function writeCodexConfigEdits(config, edits) {
  const normalizedEdits = asArray(edits)
    .map((edit) => ({
      keyPath: normalizeText(edit?.keyPath),
      value: edit?.value ?? null,
      mergeStrategy: edit?.mergeStrategy || "replace",
    }))
    .filter((edit) => edit.keyPath);
  if (!normalizedEdits.length) {
    return { skipped: true };
  }
  return withAppServerControl(config, (client) =>
    client.request("config/batchWrite", {
      edits: normalizedEdits,
      reloadUserConfig: true,
    }),
  );
}

export async function setCodexModel(config, modelId) {
  return writeCodexConfigEdits(config, [{ keyPath: CONFIG_KEYS.model, value: modelId }]);
}

export async function setCodexReasoning(config, reasoningEffort) {
  return writeCodexConfigEdits(config, [{ keyPath: CONFIG_KEYS.reasoning, value: reasoningEffort }]);
}

export async function setCodexFastMode(config, enabled) {
  return writeCodexConfigEdits(config, [{ keyPath: CONFIG_KEYS.fast, value: enabled ? "fast" : null }]);
}

export async function startCodexThreadCompact(config, threadId) {
  const normalizedThreadId = normalizeText(threadId);
  if (!normalizedThreadId) {
    throw new Error("missing thread id");
  }
  return withAppServerControl(config, async (client) => {
    await client.request("thread/resume", { threadId: normalizedThreadId });
    return client.request("thread/compact/start", { threadId: normalizedThreadId });
  });
}

function controlCodexConfig(controlState = {}) {
  return controlState.codexConfig || controlState.config || {};
}

export function renderModelStatus(controlState = {}) {
  const codexConfig = controlCodexConfig(controlState);
  const models = controlState.models || [];
  const currentModel = getCurrentModel(models, codexConfig);
  const visibleModels = asArray(models)
    .filter((model) => model && model.hidden !== true)
    .slice(0, 8)
    .map((model) => {
      const marker = currentModel && model.id === currentModel.id ? "current" : "";
      return `- \`${model.id}\`${marker ? ` (${marker})` : ""}`;
    });
  return [
    `model: \`${codexConfig.model || currentModel?.id || "unknown"}\``,
    visibleModels.length ? ["", "Available:", ...visibleModels].join("\n") : "",
    "",
    "Set: `/model gpt-5.4`",
  ].filter(Boolean).join("\n");
}

export function renderReasoningStatus(controlState = {}) {
  const codexConfig = controlCodexConfig(controlState);
  const models = controlState.models || [];
  const currentModel = getCurrentModel(models, codexConfig);
  const efforts = supportedReasoningEfforts(currentModel);
  return [
    `reasoning: \`${codexConfig.model_reasoning_effort || currentModel?.defaultReasoningEffort || "unknown"}\``,
    currentModel ? `model: \`${currentModel.id}\`` : "",
    efforts.length ? `available: ${efforts.map((item) => `\`${item}\``).join(", ")}` : "",
    "",
    "Set: `/think high` or `/reasoning xhigh`",
  ].filter(Boolean).join("\n");
}

export function renderFastStatus(controlState = {}) {
  const codexConfig = controlCodexConfig(controlState);
  const enabled = currentFastMode(codexConfig);
  return [
    `fast: \`${enabled ? "on" : "off"}\``,
    "Toggle: `/fast`",
    "Set: `/fast on` or `/fast off`",
  ].join("\n");
}

export function renderCodexControlError(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (/websocket|connect|econnrefused|127\.0\.0\.1|27890|closed before/i.test(text)) {
    return "Codex controls are unavailable: app-server is not reachable. Open Codex.app and try again.";
  }
  return "Codex controls stumbled. Short version: the command was not applied; details are in the bridge log.";
}
