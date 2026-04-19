import { sendCommandResponse } from "./command-response.mjs";
import { buildBindingPayload } from "./bridge-bindings.mjs";
import { renderBindingStatus, renderHealth } from "./health-report.mjs";
import { normalizeText } from "./message-routing.mjs";
import { rememberOutbound } from "./outbound-memory.mjs";
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
  getBindingFn = getBinding,
  getBoundThreadIdsForChatFn = getBoundThreadIdsForChat,
  listProjectThreadsFn = listProjectThreads,
  loadProjectGroupForMessageFn = loadProjectGroupForMessage,
  nowFn = () => new Date().toISOString(),
  parsePositiveIntFn = parsePositiveInt,
  parseSyncProjectArgsFn = parseSyncProjectArgs,
  rememberOutboundFn = rememberOutbound,
  removeBindingFn = removeBinding,
  removeOutboundMirrorFn = removeOutboundMirror,
  renderBindingStatusFn = renderBindingStatus,
  renderHealthFn = renderHealth,
  renderHelpFn = renderHelp,
  renderProjectStatusFn = renderProjectStatus,
  renderSyncPreviewFn = renderSyncPreview,
  replyFn = reply,
  sendCommandResponseFn = sendCommandResponse,
  setBindingFn = setBinding,
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
