import { logBridgeEvent } from "./bridge-events.mjs";
import { readCodexControlState } from "./codex-controls.mjs";
import { getThreadsByIds } from "./thread-db.mjs";
import { buildStatusBarMessage, makeStatusBarHash, readRolloutRuntimeStatus } from "./status-bar.mjs";
import { editMessageText, pinChatMessage, sendMessage } from "./telegram.mjs";
import { isStatusBarBindingEligible } from "./outbound-binding-eligibility.mjs";

const CONTROL_ERROR_LOG_COOLDOWN_MS = 60_000;

let codexConfigCache = {
  key: "",
  expiresAtMs: 0,
  value: null,
  lastErrorLoggedAtMs: 0,
};

export function resetStatusBarCodexConfigCacheForTest() {
  codexConfigCache = {
    key: "",
    expiresAtMs: 0,
    value: null,
    lastErrorLoggedAtMs: 0,
  };
}

async function readCachedCodexConfig({
  config,
  readCodexControlStateFn,
  logEventFn,
  nowMs,
}) {
  const pollIntervalMs = Number(config.statusBarCodexConfigPollIntervalMs);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    return null;
  }

  const key = String(config.appServerUrl || "");
  if (codexConfigCache.key === key && codexConfigCache.expiresAtMs > nowMs) {
    return codexConfigCache.value;
  }

  try {
    const controlState = await readCodexControlStateFn(config);
    const value = controlState?.config || null;
    codexConfigCache = {
      key,
      value,
      expiresAtMs: nowMs + pollIntervalMs,
      lastErrorLoggedAtMs: codexConfigCache.lastErrorLoggedAtMs,
    };
    return value;
  } catch (error) {
    if (nowMs - codexConfigCache.lastErrorLoggedAtMs >= CONTROL_ERROR_LOG_COOLDOWN_MS) {
      logEventFn("status_bar_codex_config_error", {
        appServerUrl: config.appServerUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      codexConfigCache.lastErrorLoggedAtMs = nowMs;
    }
    codexConfigCache.key = key;
    codexConfigCache.expiresAtMs = nowMs + pollIntervalMs;
    return codexConfigCache.value;
  }
}

export function isMissingStatusBarMessageError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /message to edit not found|message_id_invalid|message can't be edited|message not found/i.test(message);
}

export async function reserveStatusBarMessage({
  config,
  bindingKey,
  binding,
  message,
  sendMessageFn = sendMessage,
  pinChatMessageFn = pinChatMessage,
  logEventFn = logBridgeEvent,
}) {
  const sent = await sendMessageFn(config.botToken, {
    chatId: binding.chatId,
    messageThreadId: binding.messageThreadId,
    text: message.text,
    entities: message.entities,
  });
  const messageId = sent?.message_id;
  if (!Number.isInteger(messageId)) {
    throw new Error(`status bar reserve returned invalid message_id for ${bindingKey}`);
  }

  if (config.statusBarPin !== false) {
    try {
      await pinChatMessageFn(config.botToken, {
        chatId: binding.chatId,
        messageId,
        disableNotification: true,
      });
      binding.statusBarPinnedAt = new Date().toISOString();
    } catch (error) {
      logEventFn("status_bar_pin_error", {
        bindingKey,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  binding.statusBarMessageId = messageId;
  return messageId;
}

export async function refreshStatusBars({
  config,
  state,
  onlyBindingKey = null,
  getThreadsByIdsFn = getThreadsByIds,
  readRolloutRuntimeStatusFn = readRolloutRuntimeStatus,
  readCodexControlStateFn = readCodexControlState,
  buildStatusBarMessageFn = buildStatusBarMessage,
  makeStatusBarHashFn = makeStatusBarHash,
  editMessageTextFn = editMessageText,
  reserveStatusBarMessageFn = reserveStatusBarMessage,
  logEventFn = logBridgeEvent,
  isStatusBarBindingEligibleFn = isStatusBarBindingEligible,
  nowMsFn = () => Date.now(),
} = {}) {
  if (config.statusBarEnabled === false) {
    return { changed: false, updated: 0 };
  }

  const bindingEntries = Object.entries(state.bindings ?? {}).filter(([bindingKey, binding]) => {
    if (onlyBindingKey && bindingKey !== onlyBindingKey) {
      return false;
    }
    return isStatusBarBindingEligibleFn(binding);
  });
  if (bindingEntries.length === 0) {
    return { changed: false, updated: 0 };
  }

  const threads = await getThreadsByIdsFn(
    config.threadsDbPath,
    bindingEntries.map(([, binding]) => binding.threadId),
  );
  const threadsById = new Map(threads.map((thread) => [String(thread.id), thread]));
  const codexConfig = await readCachedCodexConfig({
    config,
    readCodexControlStateFn,
    logEventFn,
    nowMs: nowMsFn(),
  });
  let changed = false;
  let updated = 0;

  for (const [bindingKey, binding] of bindingEntries) {
    const thread = threadsById.get(String(binding.threadId));
    if (!thread?.rollout_path || Number(thread.archived) !== 0) {
      continue;
    }

    let runtime = null;
    try {
      runtime = await readRolloutRuntimeStatusFn(thread.rollout_path, {
        tailBytes: config.statusBarTailBytes,
      });
    } catch (error) {
      logEventFn("status_bar_runtime_error", {
        bindingKey,
        threadId: binding.threadId,
        rolloutPath: thread.rollout_path,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const message = buildStatusBarMessageFn({
      binding,
      thread,
      runtime,
      config,
      codexConfig,
    });
    const hash = makeStatusBarHashFn(JSON.stringify(message));
    if (binding.statusBarMessageId && binding.statusBarTextHash === hash) {
      continue;
    }

    try {
      if (!binding.statusBarMessageId) {
        await reserveStatusBarMessageFn({ config, bindingKey, binding, message });
      } else {
        try {
          await editMessageTextFn(config.botToken, {
            chatId: binding.chatId,
            messageId: binding.statusBarMessageId,
            text: message.text,
            entities: message.entities,
          });
        } catch (error) {
          if (!isMissingStatusBarMessageError(error)) {
            throw error;
          }
          delete binding.statusBarMessageId;
          await reserveStatusBarMessageFn({ config, bindingKey, binding, message });
        }
      }
      binding.statusBarTextHash = hash;
      binding.statusBarUpdatedAt = new Date().toISOString();
      state.bindings[bindingKey] = binding;
      changed = true;
      updated += 1;
    } catch (error) {
      logEventFn("status_bar_update_error", {
        bindingKey,
        threadId: binding.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { changed, updated };
}
