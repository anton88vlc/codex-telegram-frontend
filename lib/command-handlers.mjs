import { sendCommandResponse } from "./command-response.mjs";
import { buildBindingPayload } from "./bridge-bindings.mjs";
import {
  currentFastMode,
  findModel,
  normalizeFastMode,
  normalizeReasoningEffort,
  readCodexControlState,
  renderCodexControlError,
  renderFastStatus,
  renderModelStatus,
  renderReasoningStatus,
  setCodexFastMode,
  setCodexModel,
  setCodexReasoning,
  startCodexThreadCompact,
  supportedReasoningEfforts,
} from "./codex-controls.mjs";
import { sendNativeTurn } from "./codex-native.mjs";
import { renderBindingStatus, renderHealth } from "./health-report.mjs";
import { normalizeText } from "./message-routing.mjs";
import {
  markAppControlCooldown,
  markTransportError,
  shouldPreferAppServer,
} from "./native-transport-state.mjs";
import { renderNativeSendError } from "./native-ux.mjs";
import {
  rememberOutbound,
  rememberOutboundMirrorSuppressionForText,
} from "./outbound-memory.mjs";
import { getBoundThreadIdsForChat } from "./project-data.mjs";
import { sanitizeTopicTitle } from "./project-sync.mjs";
import {
  applyProjectSyncPlan,
  buildSyncContext,
  loadProjectGroupForMessage,
  parseSyncProjectArgs,
  renderProjectStatus,
  renderSyncPreview,
} from "./project-sync-runner.mjs";
import { buildSettingsReport } from "./settings-report.mjs";
import {
  getBinding,
  removeBinding,
  removeOutboundMirror,
  setBinding,
} from "./state.mjs";
import { clamp, listProjectThreads, parsePositiveInt } from "./thread-db.mjs";
import { reply } from "./telegram-targets.mjs";
import {
  clearTurnQueue,
  formatQueueList,
  getTurnQueueLength,
} from "./turn-queue.mjs";

export function renderHelp(config) {
  const mentionHint = config.botUsername
    ? `If group privacy still blocks plain text, mention the bot: \`@${config.botUsername} your request\`.`
    : "If group privacy still blocks plain text, temporarily mention the bot in your message.";
  return [
    "**Commands**",
    "`/attach <thread-id>` - bind this chat or topic to a Codex thread",
    "`/attach-latest` - bind this topic to the newest unbound thread in this project",
    "`/detach` - remove the binding",
    "`/status` - show the current binding and thread",
    "`/health` - show bridge health for this chat/topic and transport paths",
    "`/settings` - show safe read-only runtime settings",
    "`/model [model-id]` - show or change the default Codex model",
    "`/think [low|medium|high|xhigh]` - show or change default reasoning",
    "`/fast [on|off]` - toggle the fast tier",
    "`/compact` - compact the bound Codex thread",
    "`/queue` - show queued prompts for this topic",
    "`/pause` - pause the topic queue after the current turn",
    "`/resume` - resume the topic queue",
    "`/cancel-queue` - drop queued prompts in this topic",
    "`/steer <text>` - explicitly add guidance to the currently running Codex turn",
    "`/project-status [count]` - show desired thread column, active topics and sync preview",
    "`/sync-project [count] [dry-run]` - sync managed topics to the current project working set",
    "`/mode native` - explicitly use native transport",
    "`/help` - show this message",
    "",
    "After `/attach`, normal text from this chat goes to the bound Codex thread.",
    mentionHint,
    "v1 is intentionally narrow: **native transport** only. Heartbeat/UI-visible transport is phase 2.",
    "Final answers from the Codex thread are mirrored back into the bound Telegram chat/topic.",
  ].join("\n");
}

export async function handleCommand({
  config,
  state,
  message,
  bindingKey,
  binding,
  parsed,
  applyProjectSyncPlanFn = applyProjectSyncPlan,
  buildBindingPayloadFn = buildBindingPayload,
  buildSettingsReportFn = buildSettingsReport,
  buildSyncContextFn = buildSyncContext,
  clampFn = clamp,
  clearTurnQueueFn = clearTurnQueue,
  formatQueueListFn = formatQueueList,
  getBindingFn = getBinding,
  getBoundThreadIdsForChatFn = getBoundThreadIdsForChat,
  getTurnQueueLengthFn = getTurnQueueLength,
  listProjectThreadsFn = listProjectThreads,
  loadProjectGroupForMessageFn = loadProjectGroupForMessage,
  nowFn = () => new Date().toISOString(),
  parsePositiveIntFn = parsePositiveInt,
  parseSyncProjectArgsFn = parseSyncProjectArgs,
  rememberOutboundFn = rememberOutbound,
  rememberOutboundMirrorSuppressionFn = rememberOutboundMirrorSuppressionForText,
  removeBindingFn = removeBinding,
  removeOutboundMirrorFn = removeOutboundMirror,
  renderBindingStatusFn = renderBindingStatus,
  renderHealthFn = renderHealth,
  renderHelpFn = renderHelp,
  renderNativeSendErrorFn = renderNativeSendError,
  renderProjectStatusFn = renderProjectStatus,
  renderSyncPreviewFn = renderSyncPreview,
  replyFn = reply,
  sendCommandResponseFn = sendCommandResponse,
  sendNativeTurnFn = sendNativeTurn,
  readCodexControlStateFn = readCodexControlState,
  renderCodexControlErrorFn = renderCodexControlError,
  setCodexFastModeFn = setCodexFastMode,
  setCodexModelFn = setCodexModel,
  setCodexReasoningFn = setCodexReasoning,
  startCodexThreadCompactFn = startCodexThreadCompact,
  setBindingFn = setBinding,
  shouldPreferAppServerFn = shouldPreferAppServer,
  markAppControlCooldownFn = markAppControlCooldown,
  markTransportErrorFn = markTransportError,
}) {
  switch (parsed.command) {
    case "/help":
    case "/start":
      await sendCommandResponseFn({
        config,
        message,
        text: renderHelpFn(config),
      });
      return true;

    case "/attach": {
      const threadId = parsed.args[0];
      if (!threadId) {
        await replyFn(config.botToken, message, "Missing thread id: /attach <thread-id>");
        return true;
      }
      const now = nowFn();
      removeOutboundMirrorFn(state, bindingKey);
      setBindingFn(state, bindingKey, {
        threadId,
        transport: "native",
        chatId: String(message.chat.id),
        messageThreadId: message.message_thread_id ?? null,
        chatTitle: normalizeText(message.chat.title || message.chat.username || message.chat.first_name || ""),
        createdAt: now,
        updatedAt: now,
      });
      const nextBinding = getBindingFn(state, bindingKey);
      const sent = await replyFn(config.botToken, message, `Bound this chat to thread ${threadId} via native transport.`);
      rememberOutboundFn(nextBinding, sent);
      return true;
    }

    case "/attach-latest": {
      if (message.message_thread_id == null) {
        await replyFn(config.botToken, message, "This command only makes sense inside a forum topic.");
        return true;
      }
      if (binding) {
        await replyFn(
          config.botToken,
          message,
          `This topic is already bound to ${binding.threadId}. If you want to move it, run /detach first.`,
        );
        return true;
      }

      const { projectGroup } = await loadProjectGroupForMessageFn(config, message);
      if (!projectGroup) {
        await replyFn(
          config.botToken,
          message,
          "I cannot find a project mapping for this group. Run bootstrap first, or bind manually.",
        );
        return true;
      }

      const boundThreadIds = getBoundThreadIdsForChatFn(state, message.chat.id);
      const candidates = await listProjectThreadsFn(config.threadsDbPath, projectGroup.projectRoot, { limit: 12 });
      const nextThread = candidates.find((thread) => !boundThreadIds.has(String(thread.id)));

      if (!nextThread) {
        await replyFn(config.botToken, message, "I do not see any fresh unbound threads here right now.");
        return true;
      }

      const nextBinding = setBindingFn(
        state,
        bindingKey,
        buildBindingPayloadFn({
          message,
          thread: nextThread,
          chatTitle: projectGroup.groupTitle,
        }),
      );
      removeOutboundMirrorFn(state, bindingKey);
      const sent = await replyFn(
        config.botToken,
        message,
        `Bound this topic to a fresh thread.\nthread: ${nextThread.id}\ntitle: ${sanitizeTopicTitle(nextThread.title, nextThread.id)}`,
      );
      rememberOutboundFn(nextBinding, sent);
      return true;
    }

    case "/detach":
      if (!binding) {
        await replyFn(config.botToken, message, "There is no binding here already.");
        return true;
      }
      removeBindingFn(state, bindingKey);
      removeOutboundMirrorFn(state, bindingKey);
      await replyFn(config.botToken, message, `Detached thread ${binding.threadId}.`);
      return true;

    case "/status":
      if (!binding) {
        await replyFn(config.botToken, message, "No binding here. Use /attach <thread-id>.");
        return true;
      }
      rememberOutboundFn(
        binding,
        await replyFn(config.botToken, message, await renderBindingStatusFn(config, bindingKey, binding)),
      );
      return true;

    case "/health":
      rememberOutboundFn(
        binding,
        await sendCommandResponseFn({
          config,
          message,
          text: await renderHealthFn(config, state, message, bindingKey, binding),
        }),
      );
      return true;

    case "/settings":
    case "/config":
      rememberOutboundFn(
        binding,
        await sendCommandResponseFn({
          config,
          message,
          text: buildSettingsReportFn({ config, state, bindingKey, binding }),
        }),
      );
      return true;

    case "/model": {
      try {
        const requestedModel = normalizeText(parsed.args.join(" "));
        const controlState = await readCodexControlStateFn(config);
        if (!requestedModel) {
          await sendCommandResponseFn({
            config,
            message,
            text: renderModelStatus(controlState),
          });
          return true;
        }
        const model = findModel(controlState.models, requestedModel);
        if (!model) {
          await sendCommandResponseFn({
            config,
            message,
            text: `Unknown model: \`${requestedModel}\`.\n\n${renderModelStatus(controlState)}`,
          });
          return true;
        }
        await setCodexModelFn(config, model.id);
        await replyFn(config.botToken, message, `Model set to \`${model.id}\`. New turns will use it.`);
      } catch (error) {
        await replyFn(config.botToken, message, renderCodexControlErrorFn(error));
      }
      return true;
    }

    case "/think":
    case "/reasoning": {
      try {
        const requestedEffort = normalizeReasoningEffort(parsed.args.join(" "));
        const controlState = await readCodexControlStateFn(config);
        if (!parsed.args.length) {
          await sendCommandResponseFn({
            config,
            message,
            text: renderReasoningStatus(controlState),
          });
          return true;
        }
        if (!requestedEffort) {
          await sendCommandResponseFn({
            config,
            message,
            text: `Unknown reasoning level: \`${parsed.args.join(" ")}\`.\n\n${renderReasoningStatus(controlState)}`,
          });
          return true;
        }
        const currentModel = findModel(controlState.models, controlState.config?.model);
        const supported = supportedReasoningEfforts(currentModel);
        if (supported.length && !supported.includes(requestedEffort)) {
          await sendCommandResponseFn({
            config,
            message,
            text: `\`${requestedEffort}\` is not available for \`${currentModel.id}\`.\n\n${renderReasoningStatus(controlState)}`,
          });
          return true;
        }
        await setCodexReasoningFn(config, requestedEffort);
        await replyFn(config.botToken, message, `Reasoning set to \`${requestedEffort}\`. New turns will use it.`);
      } catch (error) {
        await replyFn(config.botToken, message, renderCodexControlErrorFn(error));
      }
      return true;
    }

    case "/fast": {
      try {
        const controlState = await readCodexControlStateFn(config);
        if (parsed.args[0] && /^status$/i.test(parsed.args[0])) {
          await sendCommandResponseFn({
            config,
            message,
            text: renderFastStatus(controlState),
          });
          return true;
        }
        const nextMode = normalizeFastMode(parsed.args.join(" "), {
          current: currentFastMode(controlState.config),
        });
        if (nextMode === null) {
          await sendCommandResponseFn({
            config,
            message,
            text: `Unknown fast mode: \`${parsed.args.join(" ")}\`.\n\n${renderFastStatus(controlState)}`,
          });
          return true;
        }
        await setCodexFastModeFn(config, nextMode);
        await replyFn(config.botToken, message, `Fast mode ${nextMode ? "on" : "off"}. New turns will use it.`);
      } catch (error) {
        await replyFn(config.botToken, message, renderCodexControlErrorFn(error));
      }
      return true;
    }

    case "/compact": {
      if (!binding) {
        await replyFn(config.botToken, message, "No binding here. Use this inside a bound Codex topic.");
        return true;
      }
      try {
        await startCodexThreadCompactFn(config, binding.threadId);
        await replyFn(config.botToken, message, "Compaction started for this Codex thread.");
      } catch (error) {
        await replyFn(config.botToken, message, renderCodexControlErrorFn(error));
      }
      return true;
    }

    case "/queue":
      if (!binding) {
        await replyFn(config.botToken, message, "No binding here. Use /attach <thread-id> first.");
        return true;
      }
      rememberOutboundFn(binding, await replyFn(config.botToken, message, formatQueueListFn(binding)));
      return true;

    case "/pause":
      if (!binding) {
        await replyFn(config.botToken, message, "No binding here. Use /attach <thread-id> first.");
        return true;
      }
      binding.queuePaused = true;
      binding.updatedAt = new Date().toISOString();
      await replyFn(
        config.botToken,
        message,
        "Queue paused. The current turn can finish, but I will not start the next queued prompt.",
      );
      return true;

    case "/resume":
      if (!binding) {
        await replyFn(config.botToken, message, "No binding here. Use /attach <thread-id> first.");
        return true;
      }
      binding.queuePaused = false;
      delete binding.queueLastError;
      delete binding.queueLastErrorAt;
      binding.updatedAt = new Date().toISOString();
      await replyFn(
        config.botToken,
        message,
        getTurnQueueLengthFn(binding)
          ? "Queue resumed. I will run the next prompt when this topic is idle."
          : "Queue resumed. Nothing is queued.",
      );
      return true;

    case "/cancel-queue": {
      if (!binding) {
        await replyFn(config.botToken, message, "No binding here. Use /attach <thread-id> first.");
        return true;
      }
      const count = clearTurnQueueFn(binding);
      binding.updatedAt = new Date().toISOString();
      await replyFn(
        config.botToken,
        message,
        count ? `Canceled ${count} queued prompt${count === 1 ? "" : "s"}.` : "Queue is already empty.",
      );
      return true;
    }

    case "/steer": {
      if (!binding) {
        await replyFn(config.botToken, message, "No binding here. Use /attach <thread-id> first.");
        return true;
      }
      if (!binding.currentTurn) {
        await replyFn(
          config.botToken,
          message,
          "No active Codex turn here. Send normal text instead; no need to steer an idle thread.",
        );
        return true;
      }
      const prompt = normalizeText(parsed.args.join(" "));
      if (!prompt) {
        await replyFn(config.botToken, message, "Missing steer text: /steer <guidance>");
        return true;
      }
      if (shouldPreferAppServerFn(binding, config)) {
        await replyFn(
          config.botToken,
          message,
          "Steer needs the live app-control path. This topic is currently on app-server/cooldown; send normal text and I will queue it instead.",
        );
        return true;
      }
      try {
        const result = await sendNativeTurnFn({
          helperPath: config.nativeHelperPath,
          fallbackHelperPath: null,
          threadId: binding.threadId,
          prompt,
          timeoutMs: config.nativeTimeoutMs,
          debugBaseUrl: config.nativeDebugBaseUrl,
          pollIntervalMs: config.nativePollIntervalMs,
          waitForReply: false,
          appControlShowThread: config.appControlShowThread,
        });
        binding.currentTurn = {
          ...(binding.currentTurn || {}),
          steerCount: Number(binding.currentTurn?.steerCount || 0) + 1,
          lastSteerAt: new Date().toISOString(),
        };
        binding.lastTransportPath = result.transportPath || "app-control";
        binding.updatedAt = new Date().toISOString();
        delete binding.lastTransportErrorAt;
        delete binding.lastTransportErrorKind;
        delete binding.appControlCooldownUntil;
        rememberOutboundMirrorSuppressionFn(state, bindingKey, prompt, {
          role: "user",
          phase: null,
        });
        await replyFn(config.botToken, message, "Steered into the current turn.");
      } catch (error) {
        const appControlCooldownUntil = markAppControlCooldownFn(binding, config, error);
        if (!appControlCooldownUntil) {
          markTransportErrorFn(binding, error);
        }
        binding.updatedAt = new Date().toISOString();
        await replyFn(
          config.botToken,
          message,
          `${renderNativeSendErrorFn(error)}\n\nSteer was not queued. Send it as normal text if you want it to run next.`,
        );
      }
      return true;
    }

    case "/project-status": {
      const requestedLimit = clampFn(parsePositiveIntFn(parsed.args[0], config.syncDefaultLimit), 1, 10);
      rememberOutboundFn(
        binding,
        await sendCommandResponseFn({
          config,
          message,
          text: await renderProjectStatusFn(config, state, message, requestedLimit),
        }),
      );
      return true;
    }

    case "/sync-project": {
      const { dryRun, requestedLimit } = parseSyncProjectArgsFn(parsed.args, config.syncDefaultLimit);
      const { projectGroup, plan } = await buildSyncContextFn(config, state, message, requestedLimit);
      if (!projectGroup || !plan) {
        await replyFn(
          config.botToken,
          message,
          "I cannot find a project mapping for this group. Bootstrap is incomplete, or this chat id is different.",
        );
        return true;
      }

      const previewText = [
        dryRun ? `**Dry-run:** ${projectGroup.groupTitle}` : `**Sync plan:** ${projectGroup.groupTitle}`,
        `desired thread column: ${plan.summary.desiredCount}`,
        renderSyncPreviewFn(plan),
      ].join("\n\n");

      if (dryRun) {
        await sendCommandResponseFn({
          config,
          message,
          text: previewText,
        });
        return true;
      }

      await applyProjectSyncPlanFn({
        config,
        state,
        chatId: message.chat.id,
        projectGroup,
        plan,
        currentBindingKey: bindingKey,
        sendResponse: (text) =>
          sendCommandResponseFn({
            config,
            message,
            text,
          }),
      });
      return true;
    }

    case "/mode": {
      const mode = normalizeText(parsed.args[0] || "");
      if (!binding) {
        await replyFn(config.botToken, message, "Bind a thread first: /attach <thread-id>.");
        return true;
      }
      if (mode !== "native") {
        await replyFn(
          config.botToken,
          message,
          "v1 only supports native transport. Heartbeat transport is intentionally left for phase 2.",
        );
        return true;
      }
      binding.transport = "native";
      binding.updatedAt = nowFn();
      rememberOutboundFn(binding, await replyFn(config.botToken, message, "OK, transport = native."));
      return true;
    }

    default:
      await replyFn(config.botToken, message, "Unknown command. /help shows the available options.");
      return true;
  }
}
