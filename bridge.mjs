#!/usr/bin/env node

import process from "node:process";

import { handleCommand } from "./lib/command-handlers.mjs";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./lib/config.mjs";
import {
  makeAppServerLiveStream,
  syncAppServerStreamProgress,
  syncAppServerStreamSubscriptions,
} from "./lib/app-server-stream-runner.mjs";
import { handleApprovalCallbackQuery } from "./lib/app-server-approvals.mjs";
import {
  configureBridgeEventLog,
  logBridgeEvent,
} from "./lib/bridge-events.mjs";
import { isAuthorized } from "./lib/bridge-bindings.mjs";
import { syncAutoCodexChatTopics } from "./lib/codex-chat-sync-runner.mjs";
import { handlePlainText } from "./lib/inbound-turn-runner.mjs";
import { normalizeInboundPrompt, parseCommand } from "./lib/message-routing.mjs";
import { syncDraftStreams } from "./lib/draft-streaming-runner.mjs";
import { rememberOutbound } from "./lib/outbound-memory.mjs";
import { syncOutboundMirrors } from "./lib/outbound-mirror-runner.mjs";
import { syncAutoProjectTopics } from "./lib/project-sync-runner.mjs";
import {
  rememberPrivateTopicTitle,
  shouldAutoCreatePrivateTopicBinding,
} from "./lib/private-topic-bindings.mjs";
import { buildSelfCheckReport, formatSelfCheckReport } from "./lib/runtime-health.mjs";
import { refreshStatusBars } from "./lib/status-bar-runner.mjs";
import {
  getBinding,
  hasProcessedMessage,
  loadState,
  makeBindingKey,
  makeMessageKey,
  markProcessedMessage,
  saveStateMerged as saveState,
} from "./lib/state.mjs";
import { clamp } from "./lib/thread-db.mjs";
import { stopTypingHeartbeats } from "./lib/typing-heartbeat.mjs";
import { syncTypingHeartbeats } from "./lib/typing-heartbeat-runner.mjs";
import { reply } from "./lib/telegram-targets.mjs";
import { rerouteUnboundGroupMessageToFallbackTopic } from "./lib/unbound-group-rescue.mjs";
import { collectTelegramVoiceRefs } from "./lib/voice-transcription.mjs";
import {
  collectTelegramAttachments,
  getMessageIngressText,
  groupTelegramMediaGroupUpdates,
  hasUnsupportedTelegramMedia,
} from "./lib/telegram-attachments.mjs";
import { drainTurnQueues } from "./lib/turn-queue-runner.mjs";
import { captureWorktreeBaseline, loadChangedFilesTextForThread } from "./lib/worktree-summary.mjs";
import { answerCallbackQuery, getMe, getUpdates } from "./lib/telegram.mjs";

const TELEGRAM_SERVICE_MESSAGE_KEYS = [
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "message_auto_delete_timer_changed",
  "pinned_message",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "boost_added",
  "chat_background_set",
];

function fail(message, extra = {}) {
  const payload = { ok: false, error: message, ...extra };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    configPath: DEFAULT_CONFIG_PATH,
    once: false,
    selfCheck: false,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    switch (arg) {
      case "--config":
        out.configPath = argv[++idx];
        break;
      case "--once":
        out.once = true;
        break;
      case "--self-check":
        out.selfCheck = true;
        break;
      default:
        fail(`unknown argument: ${arg}`, { argv });
    }
  }
  return out;
}

function isTelegramServiceMessage(message) {
  return TELEGRAM_SERVICE_MESSAGE_KEYS.some((key) => key in (message || {}));
}

async function processMessage({ config, state, message, appServerStream = null, typingHeartbeats = null }) {
  if (!message?.chat?.id) {
    return false;
  }
  if (message?.from?.is_bot) {
    return false;
  }
  if (!isAuthorized(config, message)) {
    return false;
  }
  const rememberedPrivateTopicTitle = rememberPrivateTopicTitle(state, message);
  if (isTelegramServiceMessage(message)) {
    logBridgeEvent("skip_service_message", {
      chatId: message.chat.id,
      messageId: message.message_id ?? null,
      messageThreadId: message.message_thread_id ?? null,
      rememberedPrivateTopicTitle,
      serviceKeys: TELEGRAM_SERVICE_MESSAGE_KEYS.filter((key) => key in message),
    });
    return false;
  }
  const ingressText = getMessageIngressText(message);
  const attachmentRefs = collectTelegramAttachments(message, {
    maxCount: config.attachmentMaxCount,
  });
  const voiceRefs = collectTelegramVoiceRefs(message, {
    maxCount: config.voiceTranscriptionMaxCount,
  });
  if (!ingressText.trim() && !attachmentRefs.length && !voiceRefs.length) {
    await reply(
      config.botToken,
      message,
      hasUnsupportedTelegramMedia(message)
        ? "I can handle text, images, files and voice now. Video/stickers are still next."
        : "I can handle text, images and files now. Send a caption if the attachment needs instructions.",
    );
    return true;
  }

  const bindingKey = makeBindingKey({
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id ?? null,
  });
  const binding = getBinding(state, bindingKey);
  const parsed = ingressText.trim() ? parseCommand(ingressText) : null;
  try {
    if (parsed) {
      return await handleCommand({
        config,
        state,
        message,
        bindingKey,
        binding,
        parsed,
        rememberOutboundFn: rememberOutbound,
      });
    }
    let effectiveMessage = message;
    let effectiveBindingKey = bindingKey;
    let effectiveBinding = binding;
    if (!effectiveBinding) {
      const promptText = normalizeInboundPrompt(ingressText, { botUsername: config.botUsername });
      if (!shouldAutoCreatePrivateTopicBinding({ config, message, binding: effectiveBinding })) {
        const rerouted = await rerouteUnboundGroupMessageToFallbackTopic({
          config,
          state,
          message,
          promptText,
          attachmentRefs,
          voiceRefs,
          rememberOutboundFn: rememberOutbound,
        });
        if (rerouted) {
          effectiveMessage = rerouted.message;
          effectiveBindingKey = rerouted.bindingKey;
          effectiveBinding = rerouted.binding;
        }
      }
    }
    return await handlePlainText({
      config,
      state,
      message: effectiveMessage,
      bindingKey: effectiveBindingKey,
      binding: effectiveBinding,
      appServerStream,
      typingHeartbeats,
    });
  } catch (error) {
    logBridgeEvent("process_message_error", {
      chatId: message.chat.id,
      messageId: message.message_id ?? null,
      bindingKey,
      command: parsed?.command || null,
      error: error instanceof Error ? error.message : String(error),
    });
    await reply(
      config.botToken,
      message,
      parsed
        ? "I could not run that command. Short version is here; technical details are in the log."
        : "I could not process this message. The bridge is alive, but this request stumbled; details are in the log.",
    );
    return true;
  }
}

async function processCallbackQuery({ config, state, callbackQuery, appServerStream = null }) {
  if (!callbackQuery?.id) {
    return false;
  }
  const pseudoMessage = {
    chat: callbackQuery.message?.chat,
    from: callbackQuery.from,
  };
  if (!isAuthorized(config, pseudoMessage)) {
    await answerCallbackQuery(config.botToken, {
      callbackQueryId: callbackQuery.id,
      text: "Not authorized.",
      showAlert: true,
    });
    return true;
  }
  return handleApprovalCallbackQuery({
    config,
    state,
    callbackQuery,
    appServerStream,
  });
}

async function checkpointMessage(statePath, state, update) {
  const updateId = Number.isInteger(update?.update_id) ? update.update_id : state.lastUpdateId;
  const messageKey = makeMessageKey(update.message);
  if (hasProcessedMessage(state, messageKey)) {
    state.lastUpdateId = Math.max(state.lastUpdateId, updateId);
    await saveState(statePath, state);
    return { messageKey, alreadyProcessed: true };
  }

  state.lastUpdateId = Math.max(state.lastUpdateId, updateId);
  markProcessedMessage(state, messageKey);
  await saveState(statePath, state);
  return { messageKey, alreadyProcessed: false };
}

async function hydrateBotIdentity(config) {
  if (config.botUsername) {
    return;
  }
  try {
    const me = await getMe(config.botToken);
    if (me?.username) {
      config.botUsername = String(me.username).replace(/^@+/, "");
    }
  } catch (error) {
    logBridgeEvent("telegram_me_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.configPath);
  configureBridgeEventLog(config);
  const state = await loadState(config.statePath);
  const appServerStream = makeAppServerLiveStream(config);
  const typingHeartbeats = new Map();
  const effectivePollTimeoutSeconds =
    config.outboundSyncEnabled === false
      ? config.pollTimeoutSeconds
      : Math.min(config.pollTimeoutSeconds, clamp(Math.ceil(config.outboundPollIntervalMs / 1000), 1, 10));

  await hydrateBotIdentity(config);

  if (args.selfCheck) {
    const report = await buildSelfCheckReport({ config, state });
    process.stdout.write(`${formatSelfCheckReport(report, config)}\n`);
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  let consecutivePollErrors = 0;
  let lastTopicAutoSyncAt = 0;
  let lastPrivateTopicAutoSyncAt = 0;
  while (true) {
    let updates = [];
    try {
      updates = await getUpdates(config.botToken, {
        offset: state.lastUpdateId > 0 ? state.lastUpdateId + 1 : 0,
        timeoutSeconds: effectivePollTimeoutSeconds,
        limit: 50,
      });
      consecutivePollErrors = 0;
    } catch (error) {
      consecutivePollErrors += 1;
      logBridgeEvent("poll_error", {
        consecutivePollErrors,
        error: error instanceof Error ? error.message : String(error),
      });
      await saveState(config.statePath, state);
      if (args.once) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 1000 * consecutivePollErrors)));
      continue;
    }

    for (const item of groupTelegramMediaGroupUpdates(updates)) {
      if (item?.message) {
        let allAlreadyProcessed = true;
        for (const update of item.updates) {
          const checkpoint = await checkpointMessage(config.statePath, state, update);
          if (!checkpoint.alreadyProcessed) {
            allAlreadyProcessed = false;
          }
        }
        if (allAlreadyProcessed) {
          continue;
        }
        await processMessage({ config, state, message: item.message, appServerStream, typingHeartbeats });
        await saveState(config.statePath, state);
      } else {
        const update = item.updates[0];
        if (update?.callback_query) {
          await processCallbackQuery({
            config,
            state,
            callbackQuery: update.callback_query,
            appServerStream,
          });
        }
        state.lastUpdateId = Number.isInteger(update.update_id) ? update.update_id : state.lastUpdateId;
        await saveState(config.statePath, state);
      }
    }

    let topicAutoSyncResult = { changed: false };
    if (
      config.topicAutoSyncEnabled === true &&
      Date.now() - lastTopicAutoSyncAt >= config.topicAutoSyncPollIntervalMs
    ) {
      lastTopicAutoSyncAt = Date.now();
      try {
        topicAutoSyncResult = await syncAutoProjectTopics({ config, state, nowMs: lastTopicAutoSyncAt });
      } catch (error) {
        logBridgeEvent("topic_auto_sync_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let privateTopicAutoSyncResult = { changed: false };
    if (
      config.privateTopicAutoSyncEnabled !== false &&
      Date.now() - lastPrivateTopicAutoSyncAt >= config.privateTopicAutoSyncPollIntervalMs
    ) {
      lastPrivateTopicAutoSyncAt = Date.now();
      try {
        privateTopicAutoSyncResult = await syncAutoCodexChatTopics({
          config,
          state,
          nowMs: lastPrivateTopicAutoSyncAt,
        });
      } catch (error) {
        logBridgeEvent("codex_chat_auto_sync_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let appServerStreamResult = { changed: false };
    try {
      await syncAppServerStreamSubscriptions({ config, state, stream: appServerStream });
      appServerStreamResult = await syncAppServerStreamProgress({
        config,
        state,
        stream: appServerStream,
        loadChangedFilesTextForThreadFn: loadChangedFilesTextForThread,
        rememberOutboundFn: rememberOutbound,
      });
    } catch (error) {
      logBridgeEvent("app_server_stream_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let syncResult = { changed: false };
    try {
      syncResult = await syncOutboundMirrors({
        config,
        state,
        loadChangedFilesTextForThreadFn: loadChangedFilesTextForThread,
        captureWorktreeBaselineFn: captureWorktreeBaseline,
        rememberOutboundFn: rememberOutbound,
      });
    } catch (error) {
      logBridgeEvent("outbound_mirror_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let queueResult = { changed: false };
    try {
      queueResult = await drainTurnQueues({
        config,
        state,
        appServerStream,
        typingHeartbeats,
      });
    } catch (error) {
      logBridgeEvent("turn_queue_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let statusBarResult = { changed: false };
    try {
      statusBarResult = await refreshStatusBars({ config, state });
    } catch (error) {
      logBridgeEvent("status_bar_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let draftStreamResult = { changed: false };
    try {
      draftStreamResult = await syncDraftStreams({ config, state });
    } catch (error) {
      logBridgeEvent("draft_stream_sync_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      syncTypingHeartbeats({ config, state, heartbeats: typingHeartbeats });
    } catch (error) {
      logBridgeEvent("typing_heartbeat_sync_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (
      topicAutoSyncResult.changed ||
      privateTopicAutoSyncResult.changed ||
      appServerStreamResult.changed ||
      syncResult.changed ||
      queueResult.changed ||
      statusBarResult.changed ||
      draftStreamResult.changed
    ) {
      await saveState(config.statePath, state);
    }

    if (args.once) {
      stopTypingHeartbeats(typingHeartbeats);
      break;
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
