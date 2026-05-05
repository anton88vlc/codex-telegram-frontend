import { AppServerLiveStream } from "./app-server-live.mjs";
import { appendAppServerStreamBuffer, formatAppServerStreamProgressLine } from "./app-server-stream.mjs";
import { sendApprovalRequestToTelegram } from "./app-server-approvals.mjs";
import { logBridgeEvent } from "./bridge-events.mjs";
import { normalizeText } from "./message-routing.mjs";
import { rememberOutboundMirrorSuppressionForText } from "./outbound-memory.mjs";
import { formatOutboundAssistantMirrorText } from "./outbound-mirror-messages.mjs";
import {
  isAppServerStreamBindingEligible,
  isOutboundMirrorBindingEligible,
} from "./outbound-binding-eligibility.mjs";
import { completeOutboundProgressMessage, upsertOutboundProgressMessage } from "./outbound-progress-message.mjs";
import { sendRichTextChunks } from "./telegram.mjs";
import { getThreadsByIds } from "./thread-db.mjs";
import { cleanupMirrorAssistantText } from "./thread-rollout.mjs";

export function makeAppServerLiveStream(
  config,
  {
    AppServerLiveStreamClass = AppServerLiveStream,
    logEventFn = logBridgeEvent,
  } = {},
) {
  if (config.appServerStreamEnabled === false || !config.appServerUrl) {
    return null;
  }
  return new AppServerLiveStreamClass({
    url: config.appServerUrl,
    connectTimeoutMs: config.appServerStreamConnectTimeoutMs,
    reconnectMs: config.appServerStreamReconnectMs,
    maxQueuedEvents: config.appServerStreamMaxEvents,
    onStatus(payload) {
      logEventFn("app_server_stream_status", payload);
    },
  });
}

export async function subscribeAppServerStream({
  config,
  stream,
  bindingKey,
  binding,
  logEventFn = logBridgeEvent,
}) {
  if (!stream || config.appServerStreamEnabled === false || !binding?.threadId) {
    return false;
  }
  try {
    await stream.subscribe(binding.threadId);
    return true;
  } catch (error) {
    logEventFn("app_server_stream_subscribe_error", {
      bindingKey,
      threadId: binding.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function syncAppServerStreamSubscriptions({
  config,
  state,
  stream,
  isAppServerStreamBindingEligibleFn = isAppServerStreamBindingEligible,
  subscribeAppServerStreamFn = subscribeAppServerStream,
  logEventFn = logBridgeEvent,
  nowMs = Date.now(),
}) {
  if (!stream || config.appServerStreamEnabled === false) {
    return { subscribed: 0 };
  }
  let subscribed = 0;
  let attempts = 0;
  const maxAttempts = Number.isFinite(config.appServerStreamSubscribeMaxAttemptsPerPoll)
    ? Math.max(1, Number(config.appServerStreamSubscribeMaxAttemptsPerPoll))
    : 3;
  const entries = Object.entries(state.bindings ?? {}).filter(([, binding]) => {
    return isAppServerStreamBindingEligibleFn(binding, config, { nowMs });
  });
  for (const [bindingKey, binding] of entries) {
    if (stream.isSubscribed?.(binding.threadId)) {
      subscribed += 1;
      continue;
    }
    if (stream.isSubscribeCoolingDown?.(binding.threadId, nowMs)) {
      continue;
    }
    if (attempts >= maxAttempts) {
      continue;
    }
    attempts += 1;
    if (await subscribeAppServerStreamFn({ config, stream, bindingKey, binding, logEventFn })) {
      subscribed += 1;
    }
  }
  return { subscribed };
}

export function getAppServerPatch(patches, bindingKey) {
  if (!patches.has(bindingKey)) {
    patches.set(bindingKey, {
      eventCount: 0,
      categories: new Set(),
      lines: new Map(),
      planText: null,
      latestTimestamp: null,
      sawDiff: false,
      sawTurnCompleted: false,
      finalText: null,
      finalTimestamp: null,
    });
  }
  return patches.get(bindingKey);
}

export function appServerLineKey(event) {
  return [event?.category || "other", event?.itemId || event?.method || "event"].join(":");
}

function isFinalAppServerAgentMessage(event) {
  return event?.method === "item/completed" && event.itemType === "agentMessage" && event.phase === "final_answer";
}

export async function syncAppServerStreamProgress({
  config,
  state,
  stream,
  isOutboundMirrorBindingEligibleFn = isOutboundMirrorBindingEligible,
  getThreadsByIdsFn = getThreadsByIds,
  loadChangedFilesTextForThreadFn = null,
  upsertOutboundProgressMessageFn = upsertOutboundProgressMessage,
  completeOutboundProgressMessageFn = completeOutboundProgressMessage,
  sendRichTextChunksFn = sendRichTextChunks,
  rememberOutboundFn = () => {},
  rememberOutboundMirrorSuppressionFn = rememberOutboundMirrorSuppressionForText,
  logEventFn = logBridgeEvent,
}) {
  if (!stream || config.appServerStreamEnabled === false) {
    return { changed: false, applied: 0, events: 0 };
  }
  const events = stream.drainEvents();
  if (!events.length) {
    return { changed: false, applied: 0, events: 0 };
  }

  const eligibleEntries = Object.entries(state.bindings ?? {}).filter(([, binding]) => {
    return isOutboundMirrorBindingEligibleFn(binding);
  });
  const bindingByThreadId = new Map(
    eligibleEntries.map(([bindingKey, binding]) => [String(binding.threadId), [bindingKey, binding]]),
  );
  const patches = new Map();
  let changed = false;
  let applied = 0;

  for (const event of events) {
    const threadId = normalizeText(event?.threadId);
    if (!threadId || !bindingByThreadId.has(threadId)) {
      continue;
    }
    const [bindingKey, binding] = bindingByThreadId.get(threadId);
    if (event.type === "app_server_request" && event.category === "approval") {
      try {
        await sendApprovalRequestToTelegram({
          config,
          binding,
          bindingKey,
          event,
          replyToMessageId: binding.lastInboundMessageId || binding.lastMirroredUserMessageId || null,
          logEventFn,
        });
        state.bindings[bindingKey] = binding;
        changed = true;
        applied += 1;
      } catch (error) {
        logEventFn("app_server_approval_request_error", {
          bindingKey,
          threadId: binding.threadId,
          requestId: event.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (!binding.currentTurn) {
      continue;
    }
    const currentTurn = binding.currentTurn || {};
    if (event.turnId && currentTurn.appServerTurnId && currentTurn.appServerTurnId !== event.turnId) {
      continue;
    }
    if (event.turnId && !currentTurn.appServerTurnId) {
      currentTurn.appServerTurnId = event.turnId;
    }
    binding.currentTurn = currentTurn;

    const patch = getAppServerPatch(patches, bindingKey);
    patch.eventCount += 1;
    patch.categories.add(event.category);
    patch.latestTimestamp = event.ts || patch.latestTimestamp || new Date().toISOString();
    if (event.planText) {
      patch.planText = event.planText;
    }
    if (event.category === "diff") {
      patch.sawDiff = true;
    }
    if (event.method === "turn/completed") {
      patch.sawTurnCompleted = true;
    }
    if (isFinalAppServerAgentMessage(event)) {
      patch.finalText = cleanupMirrorAssistantText(event.itemText || event.textPreview);
      patch.finalTimestamp = event.ts || patch.latestTimestamp || new Date().toISOString();
    }
    const bufferText = appendAppServerStreamBuffer(currentTurn, event);
    const line = formatAppServerStreamProgressLine(event, { bufferText });
    if (line) {
      patch.lines.set(appServerLineKey(event), line);
    }
  }

  if (!patches.size) {
    return { changed, applied, events: events.length };
  }

  const threads = await getThreadsByIdsFn(
    config.threadsDbPath,
    [...patches.keys()].map((bindingKey) => state.bindings[bindingKey]?.threadId).filter(Boolean),
  );
  const threadsById = new Map(threads.map((thread) => [String(thread.id), thread]));
  const changedFilesCache = new Map();
  for (const [bindingKey, patch] of patches.entries()) {
    const binding = state.bindings[bindingKey];
    if (!binding?.currentTurn) {
      continue;
    }
    const target = {
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId ?? null,
    };
    const thread = threadsById.get(String(binding.threadId));
    const changedFilesText =
      thread && (patch.sawDiff || patch.planText || patch.lines.size || patch.finalText) && loadChangedFilesTextForThreadFn
        ? await loadChangedFilesTextForThreadFn({
            config,
            thread,
            binding,
            cache: changedFilesCache,
          })
        : null;
    const progressText = [...patch.lines.values()].slice(-4).join("\n");
    const message = progressText
      ? {
          role: "assistant",
          phase: "commentary",
          text: progressText,
          timestamp: patch.latestTimestamp || new Date().toISOString(),
        }
      : patch.planText
        ? {
            role: "plan",
            phase: "update_plan",
            text: patch.planText,
            timestamp: patch.latestTimestamp || new Date().toISOString(),
          }
        : null;
    if (!message) {
      if (!patch.finalText) {
        continue;
      }
    } else {
      binding.currentTurn.progressSource = "app-server";
      binding.currentTurn.appServerProgressAt = patch.latestTimestamp || new Date().toISOString();
      if (patch.sawTurnCompleted) {
        binding.currentTurn.completedAt = patch.latestTimestamp || new Date().toISOString();
      }
      if (patch.planText && message.role !== "plan") {
        binding.currentTurn.planText = patch.planText;
        binding.currentTurn.planUpdatedAt = patch.latestTimestamp || new Date().toISOString();
      }
      try {
        const sent = await upsertOutboundProgressMessageFn({
          config,
          binding,
          target,
          replyToMessageId: binding.lastInboundMessageId || binding.lastMirroredUserMessageId || null,
          message,
          changedFilesText,
        });
        rememberOutboundFn(binding, sent);
        binding.updatedAt = new Date().toISOString();
        binding.lastAppServerStreamAt = patch.latestTimestamp || binding.updatedAt;
        state.bindings[bindingKey] = binding;
        logEventFn("app_server_stream_progress", {
          bindingKey,
          threadId: binding.threadId,
          eventCount: patch.eventCount,
          categories: [...patch.categories].sort(),
        });
        changed = true;
        applied += 1;
      } catch (error) {
        logEventFn("app_server_stream_progress_error", {
          bindingKey,
          threadId: binding.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (patch.finalText) {
      try {
        const replyToMessageId = binding.lastInboundMessageId || binding.lastMirroredUserMessageId || null;
        const sent = await sendRichTextChunksFn(
          config.botToken,
          target,
          formatOutboundAssistantMirrorText({
            role: "assistant",
            phase: "final_answer",
            text: patch.finalText,
          }),
          replyToMessageId,
        );
        rememberOutboundFn(binding, sent);
        rememberOutboundMirrorSuppressionFn(state, bindingKey, patch.finalText, {
          role: "assistant",
          phase: "final_answer",
        });
        await completeOutboundProgressMessageFn({ config, binding, target, changedFilesText });
        binding.currentTurn = null;
        binding.updatedAt = new Date().toISOString();
        binding.lastAppServerStreamAt = patch.finalTimestamp || binding.updatedAt;
        binding.lastMirroredAt = patch.finalTimestamp || binding.updatedAt;
        binding.lastMirroredPhase = "final_answer";
        binding.lastMirroredRole = "assistant";
        state.bindings[bindingKey] = binding;
        logEventFn("app_server_stream_final", {
          bindingKey,
          threadId: binding.threadId,
        });
        changed = true;
        applied += 1;
      } catch (error) {
        logEventFn("app_server_stream_final_error", {
          bindingKey,
          threadId: binding.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { changed, applied, events: events.length };
}
