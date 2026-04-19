import { readRecentBridgeEvents, summarizeBridgeEvents } from "./bridge-events.mjs";
import { appControlCooldownUntilMs } from "./native-transport-state.mjs";
import { sanitizeTopicTitle } from "./project-sync.mjs";
import { loadProjectGroupForMessage } from "./project-sync-runner.mjs";
import { inspectStateDoctor } from "./state-doctor.mjs";
import { getThreadById } from "./thread-db.mjs";

export async function renderBindingStatus(
  config,
  bindingKey,
  binding,
  { getThreadByIdFn = getThreadById } = {},
) {
  const lines = [
    "**Current binding**",
    `thread: \`${binding.threadId}\``,
    `transport: \`${binding.transport || "native"}\``,
    `key: \`${bindingKey}\``,
  ];
  if (binding.threadTitle) {
    lines.push(`thread title: ${binding.threadTitle}`);
  }
  if (binding.lastInboundMessageId != null) {
    lines.push(`last inbound message: \`${binding.lastInboundMessageId}\``);
  }
  if (Array.isArray(binding.lastOutboundMessageIds) && binding.lastOutboundMessageIds.length) {
    lines.push(`last outbound messages: \`${binding.lastOutboundMessageIds.join(", ")}\``);
  }
  if (binding.lastMirroredAt) {
    lines.push(`last mirrored at: \`${binding.lastMirroredAt}\` (${binding.lastMirroredPhase || "assistant"})`);
  }
  if (binding.statusBarMessageId) {
    lines.push(`status bar message: \`${binding.statusBarMessageId}\``);
  }

  try {
    const thread = await getThreadByIdFn(config.threadsDbPath, binding.threadId);
    if (!thread) {
      lines.push("warning: thread not found in the local threads DB");
    } else {
      lines.push(`thread cwd: \`${thread.cwd}\``);
      lines.push(`thread archived: ${Number(thread.archived) !== 0 ? "yes" : "no"}`);
      lines.push(`thread title db: ${sanitizeTopicTitle(thread.title, thread.id)}`);
    }
  } catch (error) {
    lines.push(`warning: threads DB lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return lines.join("\n");
}

export async function renderHealth(
  config,
  state,
  message,
  bindingKey,
  binding,
  {
    readRecentBridgeEventsFn = readRecentBridgeEvents,
    summarizeBridgeEventsFn = summarizeBridgeEvents,
    inspectStateDoctorFn = inspectStateDoctor,
    loadProjectGroupForMessageFn = loadProjectGroupForMessage,
    getThreadByIdFn = getThreadById,
    nowMs = Date.now(),
  } = {},
) {
  const eventLogPath = config.eventLogPath || config.bridgeLogPath;
  const recentEvents = await readRecentBridgeEventsFn(eventLogPath).catch((error) => [
    {
      type: "health_event_log_error",
      error: error instanceof Error ? error.message : String(error),
    },
  ]);
  const eventSummary = summarizeBridgeEventsFn(recentEvents);
  let stateDoctor = null;
  let stateDoctorError = null;
  try {
    stateDoctor = await inspectStateDoctorFn({ config, state, recentEvents });
  } catch (error) {
    stateDoctorError = error instanceof Error ? error.message : String(error);
  }
  const lines = [
    "**Bridge health**",
    `bot: ${config.botUsername ? `\`@${config.botUsername}\`` : "unknown username"}`,
    `chat: \`${String(message.chat.id)}\` (${message.chat.type || "unknown"})`,
    `topic: \`${message.message_thread_id ?? "direct/no-topic"}\``,
    `binding key: \`${bindingKey}\``,
    `native debug: \`${config.nativeDebugBaseUrl}\``,
    `app server: \`${config.appServerUrl}\``,
    `outbound mirror: ${config.outboundSyncEnabled === false ? "off" : `on (${config.outboundPollIntervalMs}ms poll)`}`,
    `status bar: ${config.statusBarEnabled === false ? "off" : "on"}`,
    `event log: \`${eventLogPath}\` (${eventSummary.total} sampled)`,
    `delivery: app-control ${eventSummary.appControlSends}, app-server fallback ${eventSummary.appServerFallbackSends}, native errors ${eventSummary.nativeSendErrors}, ops dm fallbacks ${eventSummary.opsDmFallbacks}`,
    stateDoctor
      ? `state doctor: ${stateDoctor.summary.findings} findings, ${stateDoctor.summary.repairable} safe repairs`
      : `state doctor: unavailable (${stateDoctorError || "unknown"})`,
  ];

  if (binding) {
    lines.push(`binding thread: ${binding.threadId}`);
    if (binding.threadTitle) {
      lines.push(`binding title: ${binding.threadTitle}`);
    }
    if (binding.lastMirroredAt) {
      lines.push(`last mirrored: \`${binding.lastMirroredAt}\` (${binding.lastMirroredPhase || "assistant"})`);
    }
    if (binding.lastInboundMessageId != null) {
      lines.push(`last inbound message: \`${binding.lastInboundMessageId}\``);
    }
    if (Array.isArray(binding.lastOutboundMessageIds) && binding.lastOutboundMessageIds.length) {
      lines.push(`last outbound messages: \`${binding.lastOutboundMessageIds.join(", ")}\``);
    }
    if (binding.statusBarMessageId) {
      lines.push(`status bar message: \`${binding.statusBarMessageId}\``);
    }
    if (binding.statusBarUpdatedAt) {
      lines.push(`status bar updated: \`${binding.statusBarUpdatedAt}\``);
    }
    if (binding.lastTransportPath) {
      lines.push(`last transport path: \`${binding.lastTransportPath}\``);
    }
    if (binding.appControlCooldownUntil && appControlCooldownUntilMs(binding) > nowMs) {
      lines.push(`app-control cooldown until: \`${binding.appControlCooldownUntil}\``);
    }
    if (binding.lastTransportErrorAt) {
      lines.push(
        `last transport error: \`${binding.lastTransportErrorKind || "send_failed"}\` at \`${binding.lastTransportErrorAt}\``,
      );
    }
  } else {
    lines.push("binding: none");
  }

  if (stateDoctor?.summary?.repairable) {
    lines.push("state repair hint: run `npm run state:doctor -- --apply` locally. It only edits local state/index files.");
  }

  try {
    const { projectGroup } = await loadProjectGroupForMessageFn(config, message);
    if (projectGroup) {
      lines.push(`project group: ${projectGroup.groupTitle}`);
      lines.push(`project root: \`${projectGroup.projectRoot}\``);
      lines.push(`bootstrap topics: ${projectGroup.topics.length}`);
    } else {
      lines.push("warning: chat not found in bootstrap result");
    }
  } catch (error) {
    lines.push(`warning: project index unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (binding) {
    try {
      const thread = await getThreadByIdFn(config.threadsDbPath, binding.threadId);
      if (!thread) {
        lines.push(`warning: thread ${binding.threadId} missing in threads DB`);
      } else {
        lines.push(`thread cwd: \`${thread.cwd}\``);
        lines.push(`thread archived: ${Number(thread.archived) !== 0 ? "yes" : "no"}`);
      }
    } catch (error) {
      lines.push(`warning: threads lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (message.chat.type === "supergroup" || message.chat.type === "group") {
    lines.push(
      config.botUsername
        ? `hint: if plain text in the topic does not reach the bot, check bot privacy mode or write @${config.botUsername} your request`
        : "hint: if plain text in the topic does not reach the bot, check bot privacy mode",
    );
  }

  if (eventSummary.recentFailures.length) {
    lines.push("recent failures:");
    for (const event of eventSummary.recentFailures) {
      const at = event.ts ? ` ${event.ts}` : "";
      const key = event.bindingKey ? ` ${event.bindingKey}` : "";
      const detail = event.error ? ` - ${String(event.error).replace(/\s+/g, " ").slice(0, 180)}` : "";
      lines.push(`- ${event.type}${at}${key}${detail}`);
    }
  } else {
    lines.push("recent failures: none in sampled log");
  }

  return lines.join("\n");
}
