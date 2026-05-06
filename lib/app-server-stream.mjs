import { fileURLToPath } from "node:url";

import { normalizeText } from "./message-routing.mjs";
import { formatUpdatePlanMirrorText, getGeneratedImagePath } from "./thread-rollout.mjs";

const DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/fileChange/outputDelta",
  "item/commandExecution/outputDelta",
]);
const DELTA_TEXT_LIMIT = 2_000;
const PROGRESS_BUFFER_LIMIT = 420;
const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const USER_INPUT_REQUEST_METHODS = new Set(["item/tool/requestUserInput"]);
const MCP_ELICITATION_REQUEST_METHODS = new Set(["mcpServer/elicitation/request"]);

function compactText(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}...` : text;
}

function compactMultiline(value, limit) {
  const text = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!text) {
    return null;
  }
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}...` : text;
}

export function categorizeAppServerMethod(method) {
  switch (method) {
    case "turn/started":
    case "turn/completed":
    case "item/started":
    case "item/completed":
      return "lifecycle";
    case "item/agentMessage/delta":
      return "agent_delta";
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
      return "reasoning";
    case "turn/plan/updated":
    case "item/plan/delta":
      return "plan";
    case "turn/diff/updated":
    case "item/fileChange/outputDelta":
      return "diff";
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta":
    case "item/commandExecution/terminalInteraction":
      return "command";
    case "item/mcpToolCall/progress":
      return "tool_progress";
    case "thread/tokenUsage/updated":
      return "token_usage";
    case "account/rateLimits/updated":
      return "rate_limits";
    case "model/rerouted":
    case "thread/status/changed":
      return "status";
    case "error":
      return "error";
    default:
      return "other";
  }
}

function turnIdFromParams(params) {
  return params?.turnId ?? params?.turn?.id ?? null;
}

function threadIdFromParams(params) {
  return params?.threadId ?? params?.thread?.id ?? null;
}

function itemIdFromParams(params) {
  return params?.itemId ?? params?.item?.id ?? null;
}

function itemTypeFromParams(params) {
  return params?.item?.type ?? null;
}

function itemPhaseFromParams(params) {
  return params?.item?.phase ?? null;
}

function itemTextFromParams(params) {
  const text = params?.item?.text;
  return typeof text === "string" ? text : null;
}

function normalizeMediaPath(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  return raw.startsWith("/") ? raw : null;
}

function isImagePath(value) {
  return /\.(?:png|jpe?g|webp|gif|heic|heif)$/i.test(normalizeText(value));
}

function normalizeMediaType(value, mimeType, filePath) {
  const type = normalizeText(value);
  if (type === "photo" || type === "image" || type === "output_image" || type === "input_image") {
    return "photo";
  }
  if (type === "image_generation_call" || type === "imageGenerationCall" || type === "generated_image") {
    return "photo";
  }
  if (normalizeText(mimeType).startsWith("image/") || isImagePath(filePath)) {
    return "photo";
  }
  return null;
}

function firstTextValue(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function mediaFromObject(value, { threadId = null } = {}) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const mimeType = firstTextValue(value.mimeType, value.mime_type, value.contentType, value.content_type);
  const directPath = normalizeMediaPath(
    value.path ||
      value.filePath ||
      value.file_path ||
      value.localPath ||
      value.local_path ||
      value.imagePath ||
      value.image_path ||
      value.outputPath ||
      value.output_path ||
      value.uri ||
      value.url,
  );
  const itemType = firstTextValue(value.type, value.itemType, value.kind);
  const isImageGenerationItem = ["image_generation_call", "imageGenerationCall", "generated_image"].includes(itemType);
  const imageId =
    firstTextValue(value.imageId, value.image_id) ||
    (isImageGenerationItem ? firstTextValue(value.id) : null);
  const generatedPath =
    !directPath && imageId && (value.result != null || isImageGenerationItem)
      ? getGeneratedImagePath({ threadId, imageId })
      : null;
  const filePath = directPath || generatedPath;
  const mediaType = normalizeMediaType(itemType, mimeType, filePath);
  if (mediaType !== "photo" || !filePath) {
    return null;
  }
  return {
    type: "photo",
    source: firstTextValue(value.source) || (generatedPath ? "codex_image_generation" : "app_server"),
    imageId,
    path: filePath,
    mimeType: mimeType || (isImagePath(filePath) ? "image/png" : null),
  };
}

function extractMediaFromValue(value, { threadId = null, limit = 12, depth = 0 } = {}) {
  if (!value || limit <= 0 || depth > 3) {
    return [];
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      out.push(...extractMediaFromValue(item, { threadId, limit: limit - out.length, depth: depth + 1 }));
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }
  if (typeof value !== "object") {
    return [];
  }

  const direct = mediaFromObject(value, { threadId });
  const out = [];
  if (direct) {
    out.push(direct);
  }

  const nestedKeys = ["media", "attachments", "files", "images", "content", "output", "outputs", "result", "results", "item"];
  for (const key of nestedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    out.push(...extractMediaFromValue(value[key], { threadId, limit: limit - out.length, depth: depth + 1 }));
    if (out.length >= limit) {
      break;
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const item of out) {
    const key = [item.type, item.path, item.imageId].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

export function extractAppServerMedia(params) {
  const threadId = threadIdFromParams(params);
  return extractMediaFromValue(params, { threadId });
}

function commandActionsFromParams(params) {
  const actions = Array.isArray(params?.commandActions) ? params.commandActions : [];
  return actions
    .map((action) => {
      if (typeof action === "string") {
        return action;
      }
      if (action && typeof action === "object") {
        return action.cmd || action.command || action.text || null;
      }
      return null;
    })
    .map((command) => compactMultiline(command, 900))
    .filter(Boolean);
}

function commandTextFromParams(params) {
  const actions = commandActionsFromParams(params);
  if (actions.length) {
    return actions.join("\n");
  }
  return compactMultiline(params?.cmd || params?.command || params?.commandText, 900);
}

function normalizeQuestion(question, index) {
  if (!question || typeof question !== "object") {
    return null;
  }
  const id = compactText(question.id || `q${index + 1}`, 120);
  const text = compactMultiline(question.question || question.text || question.prompt || question.label, 900);
  if (!id || !text) {
    return null;
  }
  return {
    id,
    header: compactText(question.header, 120),
    question: text,
    isOther: question.isOther === true,
    options: Array.isArray(question.options)
      ? question.options
          .map((option) => {
            if (typeof option === "string") {
              return { label: compactText(option, 160), description: null };
            }
            if (!option || typeof option !== "object") {
              return null;
            }
            const label = compactText(option.label || option.value || option.id, 160);
            return label
              ? {
                  label,
                  description: compactText(option.description, 260),
                }
              : null;
          })
          .filter(Boolean)
      : [],
  };
}

function userInputQuestionsFromParams(params) {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  return questions.map(normalizeQuestion).filter(Boolean);
}

function mcpElicitationDetailsFromParams(params) {
  if (!params || typeof params !== "object" || params.mode !== "form") {
    return null;
  }
  const meta = params._meta && typeof params._meta === "object" ? params._meta : {};
  const approvalKind = compactText(meta.codex_approval_kind, 120);
  return {
    kind:
      approvalKind === "tool_suggestion"
        ? "tool_suggestion"
        : approvalKind === "mcp_tool_call"
          ? "mcp_tool_call"
          : "generic",
    message: compactMultiline(params.message, 900),
    serverName: compactText(params.serverName, 160),
    riskLevel: compactText(meta.riskLevel, 80),
    subtitle: compactText(meta.subtitle, 260),
    toolName: compactText(meta.tool_name || meta.connector_name, 180),
    toolId: compactText(meta.tool_id || meta.connector_id, 180),
    toolType: compactText(meta.tool_type, 80),
    suggestType: compactText(meta.suggest_type, 80),
    suggestReason: compactMultiline(meta.suggest_reason, 420),
    persist: meta.persist || null,
    toolParams: meta.tool_params && typeof meta.tool_params === "object" ? meta.tool_params : null,
  };
}

function textPreview(value, limit = 240) {
  return compactText(value, limit);
}

function deltaText(value, limit = DELTA_TEXT_LIMIT) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  return value.length > limit ? value.slice(0, limit) : value;
}

export function normalizeAppServerNotification(message, { ts = null } = {}) {
  if (!message || typeof message !== "object" || typeof message.method !== "string" || message.id != null) {
    return null;
  }

  const params = message.params && typeof message.params === "object" ? message.params : {};
  const method = message.method;
  const delta = typeof params.delta === "string" ? params.delta : null;
  const item = params.item && typeof params.item === "object" ? params.item : null;
  const media = extractAppServerMedia(params);
  const category = media.length ? "media" : categorizeAppServerMethod(method);
  const planText = Array.isArray(params.plan) ? formatUpdatePlanMirrorText({ plan: params.plan }) : null;
  const mediaTextPreview = media.length
    ? media.length === 1
      ? "Generated image"
      : `Generated ${media.length} images`
    : null;

  return {
    type: "app_server_stream_event",
    ts,
    method,
    category,
    threadId: threadIdFromParams(params),
    turnId: turnIdFromParams(params),
    itemId: itemIdFromParams(params),
    itemType: itemTypeFromParams(params),
    phase: itemPhaseFromParams(params),
    itemText: itemTextFromParams(params),
    media,
    deltaText: deltaText(delta),
    deltaChars: delta ? delta.length : 0,
    diffChars: typeof params.diff === "string" ? params.diff.length : 0,
    planSteps: Array.isArray(params.plan) ? params.plan.length : null,
    planText,
    textPreview:
      textPreview(delta) ||
      textPreview(params.message) ||
      textPreview(params.explanation) ||
      textPreview(item?.text) ||
      mediaTextPreview ||
      null,
  };
}

export function isAppServerApprovalRequest(message) {
  return Boolean(
    message &&
      typeof message === "object" &&
      message.id != null &&
      typeof message.method === "string" &&
      APPROVAL_REQUEST_METHODS.has(message.method),
  );
}

export function isAppServerUserInputRequest(message) {
  return Boolean(
    message &&
      typeof message === "object" &&
      message.id != null &&
      typeof message.method === "string" &&
      USER_INPUT_REQUEST_METHODS.has(message.method),
  );
}

export function isAppServerMcpElicitationRequest(message) {
  return Boolean(
    message &&
      typeof message === "object" &&
      message.id != null &&
      typeof message.method === "string" &&
      MCP_ELICITATION_REQUEST_METHODS.has(message.method),
  );
}

export function normalizeAppServerRequest(message, { ts = null } = {}) {
  if (
    !isAppServerApprovalRequest(message) &&
    !isAppServerUserInputRequest(message) &&
    !isAppServerMcpElicitationRequest(message)
  ) {
    return null;
  }

  const params = message.params && typeof message.params === "object" ? message.params : {};
  const requestId = String(message.id);
  const common = {
    type: "app_server_request",
    ts,
    requestId,
    method: message.method,
    threadId: threadIdFromParams(params),
    turnId: turnIdFromParams(params),
    itemId: itemIdFromParams(params),
  };

  if (message.method === "item/commandExecution/requestApproval") {
    return {
      ...common,
      category: "approval",
      requestKind: "command",
      approvalReason: compactMultiline(params.approvalReason || params.reason || params.message, 420),
      commandText: commandTextFromParams(params),
      commandActions: commandActionsFromParams(params),
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment || params.proposedExecPolicyAmendment || null,
      networkApprovalContext: params.networkApprovalContext || null,
      proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments || null,
    };
  }

  if (message.method === "item/fileChange/requestApproval") {
    return {
      ...common,
      category: "approval",
      requestKind: "file",
      approvalReason: compactMultiline(params.approvalReason || params.reason || params.message, 420),
      grantRoot: compactMultiline(params.grantRoot || params.root || params.path, 420),
    };
  }

  if (message.method === "item/permissions/requestApproval") {
    return {
      ...common,
      category: "approval",
      requestKind: "permissions",
      approvalReason: compactMultiline(params.approvalReason || params.reason || params.message, 420),
      permissions: params.permissions && typeof params.permissions === "object" ? params.permissions : {},
    };
  }

  if (message.method === "item/tool/requestUserInput") {
    return {
      ...common,
      category: "user_input",
      requestKind: "user_input",
      questions: userInputQuestionsFromParams(params),
    };
  }

  const elicitation = mcpElicitationDetailsFromParams(params);
  if (!elicitation) {
    return {
      ...common,
      category: "elicitation",
      requestKind: "mcp_elicitation",
      unsupported: true,
      message: compactMultiline(params.message, 900),
    };
  }
  return {
    ...common,
    category: "elicitation",
    requestKind: "mcp_elicitation",
    ...elicitation,
  };
}

function streamBufferKey(event) {
  return [event?.category || "other", event?.itemId || event?.method || "event"].join(":");
}

export function appendAppServerStreamBuffer(currentTurn, event, { limit = PROGRESS_BUFFER_LIMIT } = {}) {
  const rawDeltaText = typeof event?.deltaText === "string" ? event.deltaText : "";
  if (!rawDeltaText.trim()) {
    return normalizeText(event?.textPreview);
  }
  if (!currentTurn || typeof currentTurn !== "object") {
    return compactText(rawDeltaText, limit);
  }
  if (!currentTurn.appServerStreamBuffers || typeof currentTurn.appServerStreamBuffers !== "object") {
    currentTurn.appServerStreamBuffers = {};
  }
  const key = streamBufferKey(event);
  const existing = typeof currentTurn.appServerStreamBuffers[key] === "string" ? currentTurn.appServerStreamBuffers[key] : "";
  const merged = `${existing}${rawDeltaText}`;
  currentTurn.appServerStreamBuffers[key] = merged.length > limit ? merged.slice(-limit) : merged;
  return compactText(currentTurn.appServerStreamBuffers[key], limit);
}

export function formatAppServerStreamProgressLine(event, { bufferText = null } = {}) {
  if (!event) {
    return null;
  }
  const preview = normalizeText(bufferText || event.textPreview);
  switch (event.category) {
    case "lifecycle":
      if (event.method === "turn/started") {
        return "Codex started the turn.";
      }
      if (event.method === "turn/completed") {
        return null;
      }
      if (event.method === "item/started" && event.itemType) {
        return `Started ${event.itemType}.`;
      }
      return null;
    case "reasoning":
      return preview ? `Thinking: ${preview}` : "Thinking...";
    case "agent_delta":
      return "Writing the final answer...";
    case "plan":
      return event.planText ? null : preview ? `Todo updated: ${preview}` : "Todo updated.";
    case "diff":
      return preview ? `Changed files updated: ${preview}` : "Changed files updated.";
    case "command":
      return preview ? `Command output: ${preview}` : "Command is running.";
    case "tool_progress":
      return preview ? `Tool progress: ${preview}` : "Tool progress updated.";
    case "media":
      return preview ? `Media ready: ${preview}` : "Media ready.";
    case "status":
      if (event.method === "model/rerouted") {
        return preview ? `Status: ${preview}` : "Model route updated.";
      }
      return null;
    case "error":
      return preview ? `Stream warning: ${preview}` : "Stream warning.";
    default:
      return null;
  }
}

export function shouldKeepAppServerStreamEvent(event, { threadId = null, turnId = null } = {}) {
  if (!event) {
    return false;
  }
  if (threadId && event.threadId && event.threadId !== threadId) {
    return false;
  }
  if (turnId && event.turnId && event.turnId !== turnId) {
    return false;
  }
  if (!threadId) {
    return true;
  }
  return Boolean(event.threadId === threadId || ["rate_limits", "error"].includes(event.category));
}

export function summarizeAppServerStreamEvents(events) {
  const safeEvents = (Array.isArray(events) ? events : []).filter((event) => event?.type === "app_server_stream_event");
  const byMethod = new Map();
  const byCategory = new Map();
  let agentDeltaChars = 0;
  let reasoningDeltaChars = 0;
  let diffDeltaChars = 0;
  let commandDeltaChars = 0;
  let finalAgentMessages = 0;
  let completedTurns = 0;
  let latestTurnId = null;
  let latestTextPreview = null;

  for (const event of safeEvents) {
    byMethod.set(event.method, (byMethod.get(event.method) || 0) + 1);
    byCategory.set(event.category, (byCategory.get(event.category) || 0) + 1);
    if (event.turnId) {
      latestTurnId = event.turnId;
    }
    if (event.textPreview) {
      latestTextPreview = event.textPreview;
    }
    if (event.category === "agent_delta") {
      agentDeltaChars += event.deltaChars || 0;
    }
    if (event.category === "reasoning") {
      reasoningDeltaChars += event.deltaChars || 0;
    }
    if (event.category === "diff") {
      diffDeltaChars += (event.deltaChars || 0) + (event.diffChars || 0);
    }
    if (event.category === "command") {
      commandDeltaChars += event.deltaChars || 0;
    }
    if (event.method === "item/completed" && event.itemType === "agentMessage" && event.phase === "final_answer") {
      finalAgentMessages += 1;
    }
    if (event.method === "turn/completed") {
      completedTurns += 1;
    }
  }

  return {
    total: safeEvents.length,
    byMethod: Object.fromEntries([...byMethod.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    byCategory: Object.fromEntries([...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    agentDeltaChars,
    reasoningDeltaChars,
    diffDeltaChars,
    commandDeltaChars,
    planUpdates: byMethod.get("turn/plan/updated") || 0,
    planDeltas: byMethod.get("item/plan/delta") || 0,
    tokenUsageUpdates: byMethod.get("thread/tokenUsage/updated") || 0,
    rateLimitUpdates: byMethod.get("account/rateLimits/updated") || 0,
    toolProgressEvents: byMethod.get("item/mcpToolCall/progress") || 0,
    finalAgentMessages,
    completedTurns,
    latestTurnId,
    latestTextPreview,
    sawStreamingSignal: safeEvents.some(
      (event) =>
        DELTA_METHODS.has(event.method) ||
        ["turn/plan/updated", "turn/diff/updated", "thread/tokenUsage/updated", "account/rateLimits/updated"].includes(
          event.method,
        ),
    ),
  };
}
