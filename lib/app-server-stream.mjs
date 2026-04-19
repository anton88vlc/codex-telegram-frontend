const DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/fileChange/outputDelta",
  "item/commandExecution/outputDelta",
]);

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

function textPreview(value, limit = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}...` : text;
}

export function normalizeAppServerNotification(message, { ts = null } = {}) {
  if (!message || typeof message !== "object" || typeof message.method !== "string" || message.id != null) {
    return null;
  }

  const params = message.params && typeof message.params === "object" ? message.params : {};
  const method = message.method;
  const delta = typeof params.delta === "string" ? params.delta : null;
  const item = params.item && typeof params.item === "object" ? params.item : null;
  const category = categorizeAppServerMethod(method);

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
    deltaChars: delta ? delta.length : 0,
    diffChars: typeof params.diff === "string" ? params.diff.length : 0,
    planSteps: Array.isArray(params.plan) ? params.plan.length : null,
    textPreview:
      textPreview(delta) ||
      textPreview(params.message) ||
      textPreview(params.explanation) ||
      textPreview(item?.text) ||
      null,
  };
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
