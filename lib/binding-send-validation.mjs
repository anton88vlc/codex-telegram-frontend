import { statSync } from "node:fs";

import { isThreadDbOptionalBinding } from "./binding-classification.mjs";
import { logBridgeEvent } from "./bridge-events.mjs";
import { isClosedSyncBinding } from "./project-sync.mjs";
import {
  removeOutboundMirror,
  setBinding,
  setOutboundMirror,
} from "./state.mjs";
import { findActiveThreadSuccessors, getThreadById } from "./thread-db.mjs";

export async function validateBindingForSend(
  config,
  binding,
  {
    getThreadByIdFn = getThreadById,
    isClosedSyncBindingFn = isClosedSyncBinding,
    isThreadDbOptionalBindingFn = isThreadDbOptionalBinding,
    logEventFn = logBridgeEvent,
  } = {},
) {
  if (isClosedSyncBindingFn(binding)) {
    return {
      ok: false,
      message:
        "This sync-managed topic is parked and should not be used as an active work chat. Run `/sync-project` to bring it back into the active set.",
    };
  }
  try {
    const thread = await getThreadByIdFn(config.threadsDbPath, binding.threadId);
    if (!thread) {
      if (isThreadDbOptionalBindingFn(binding)) {
        logEventFn("binding_thread_db_pending", {
          threadId: binding.threadId,
          chatId: binding.chatId,
          messageThreadId: binding.messageThreadId ?? null,
          createdBy: binding.createdBy || null,
          surface: binding.surface || null,
        });
        return { ok: true, thread: null };
      }
      return {
        ok: false,
        message: `This binding points to thread ${binding.threadId}, which is no longer in the local Codex DB. Use /detach and bind it again.`,
      };
    }
    if (Number(thread.archived) !== 0) {
      return {
        ok: false,
        thread,
        message: `This binding points to archived thread ${binding.threadId}. Use /detach and pick an active thread.`,
      };
    }
    return { ok: true, thread };
  } catch (error) {
    logEventFn("binding_validation_error", {
      threadId: binding.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: true, thread: null };
  }
}

export function fileSizeOrZero(filePath, { statFn = statSync } = {}) {
  if (!filePath) {
    return 0;
  }
  try {
    return Number(statFn(filePath).size) || 0;
  } catch {
    return 0;
  }
}

export function prepareOutboundMirrorAtFileEnd(
  state,
  bindingKey,
  thread,
  {
    fileSizeFn = fileSizeOrZero,
    removeOutboundMirrorFn = removeOutboundMirror,
    setOutboundMirrorFn = setOutboundMirror,
  } = {},
) {
  if (!thread?.rollout_path) {
    removeOutboundMirrorFn(state, bindingKey);
    return;
  }
  setOutboundMirrorFn(state, bindingKey, {
    initialized: true,
    threadId: String(thread.id),
    rolloutPath: thread.rollout_path,
    byteOffset: fileSizeFn(thread.rollout_path),
    partialLine: "",
    lastSignature: null,
    suppressions: [],
    pendingMessages: [],
    replyTargetMessageId: null,
  });
}

export async function validateBindingForSendWithRescue({
  config,
  state,
  bindingKey,
  binding,
  now = new Date().toISOString(),
  findActiveThreadSuccessorsFn = findActiveThreadSuccessors,
  getThreadByIdFn = getThreadById,
  isClosedSyncBindingFn = isClosedSyncBinding,
  isThreadDbOptionalBindingFn = isThreadDbOptionalBinding,
  logEventFn = logBridgeEvent,
  prepareOutboundMirrorAtFileEndFn = prepareOutboundMirrorAtFileEnd,
  setBindingFn = setBinding,
} = {}) {
  const result = await validateBindingForSend(config, binding, {
    getThreadByIdFn,
    isClosedSyncBindingFn,
    isThreadDbOptionalBindingFn,
    logEventFn,
  });
  if (result.ok || !result.thread || Number(result.thread.archived) === 0) {
    return result;
  }

  let candidates = [];
  try {
    candidates = await findActiveThreadSuccessorsFn(config.threadsDbPath, result.thread, { limit: 3 });
  } catch (error) {
    logEventFn("binding_archived_rescue_lookup_error", {
      bindingKey,
      threadId: binding.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (candidates.length !== 1) {
    logEventFn("binding_archived_rescue_ambiguous", {
      bindingKey,
      threadId: binding.threadId,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        cwd: candidate.cwd,
      })),
    });
    return {
      ...result,
      message:
        candidates.length > 1
          ? `This Telegram topic points to archived Codex thread ${binding.threadId}, and I found ${candidates.length} possible active replacements. Use /detach and /attach <thread-id> once.`
          : result.message,
    };
  }

  const successor = candidates[0];
  const nextBinding = setBindingFn(state, bindingKey, {
    ...binding,
    threadId: String(successor.id),
    threadTitle: successor.title || binding.threadTitle,
    reboundFromThreadId: binding.threadId,
    reboundAt: now,
    updatedAt: now,
  });
  prepareOutboundMirrorAtFileEndFn(state, bindingKey, successor);
  logEventFn("binding_archived_rescued", {
    bindingKey,
    fromThreadId: binding.threadId,
    toThreadId: successor.id,
    title: successor.title,
    cwd: successor.cwd,
  });
  return {
    ok: true,
    thread: successor,
    binding: nextBinding,
    notice: "Recovered the Telegram binding to the active Codex thread; continuing.",
  };
}
