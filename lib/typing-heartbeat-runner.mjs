import { logBridgeEvent } from "./bridge-events.mjs";
import { isOutboundMirrorBindingEligible } from "./outbound-binding-eligibility.mjs";
import { buildTargetFromBinding } from "./telegram-targets.mjs";
import { sendTyping } from "./telegram.mjs";
import { startTypingHeartbeat, stopTypingHeartbeats } from "./typing-heartbeat.mjs";

export function isTypingHeartbeatBindingEligible(config, binding) {
  return (
    config.sendTyping !== false &&
    config.typingHeartbeatEnabled !== false &&
    isOutboundMirrorBindingEligible(binding) &&
    Boolean(binding?.currentTurn)
  );
}

export function syncTypingHeartbeats({
  config,
  state,
  heartbeats,
  onlyBindingKey = null,
  startTypingHeartbeatFn = startTypingHeartbeat,
  stopTypingHeartbeatsFn = stopTypingHeartbeats,
  sendTypingFn = sendTyping,
  logEventFn = logBridgeEvent,
} = {}) {
  if (!heartbeats) {
    return { started: 0, stopped: 0, running: 0 };
  }

  if (config.sendTyping === false || config.typingHeartbeatEnabled === false) {
    if (onlyBindingKey) {
      const heartbeat = heartbeats.get(onlyBindingKey);
      if (heartbeat) {
        heartbeat.stop();
        heartbeats.delete(onlyBindingKey);
        logEventFn("typing_heartbeat_stop", { bindingKey: onlyBindingKey, reason: "disabled" });
        return { started: 0, stopped: 1, running: heartbeats.size };
      }
      return { started: 0, stopped: 0, running: heartbeats.size };
    }
    const stopped = stopTypingHeartbeatsFn(heartbeats);
    if (stopped) {
      logEventFn("typing_heartbeats_stop_all", { stopped, reason: "disabled" });
    }
    return { started: 0, stopped, running: 0 };
  }

  const eligibleKeys = new Set();
  let started = 0;
  let stopped = 0;
  const bindingEntries = Object.entries(state.bindings ?? {}).filter(([bindingKey]) => {
    return !onlyBindingKey || bindingKey === onlyBindingKey;
  });

  for (const [bindingKey, binding] of bindingEntries) {
    if (!isTypingHeartbeatBindingEligible(config, binding)) {
      continue;
    }
    eligibleKeys.add(bindingKey);
    if (heartbeats.has(bindingKey)) {
      continue;
    }
    const heartbeat = startTypingHeartbeatFn({
      token: config.botToken,
      target: buildTargetFromBinding(binding),
      sendTyping: sendTypingFn,
      intervalMs: config.typingHeartbeatIntervalMs,
      onError(error) {
        logEventFn("typing_heartbeat_error", {
          bindingKey,
          threadId: binding.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    if (heartbeat.active) {
      heartbeats.set(bindingKey, heartbeat);
      started += 1;
      logEventFn("typing_heartbeat_start", {
        bindingKey,
        threadId: binding.threadId,
        intervalMs: config.typingHeartbeatIntervalMs,
      });
    }
  }

  for (const [bindingKey, heartbeat] of heartbeats.entries()) {
    if (onlyBindingKey && bindingKey !== onlyBindingKey) {
      continue;
    }
    if (eligibleKeys.has(bindingKey)) {
      continue;
    }
    heartbeat.stop();
    heartbeats.delete(bindingKey);
    stopped += 1;
    logEventFn("typing_heartbeat_stop", { bindingKey, reason: "idle" });
  }

  return { started, stopped, running: heartbeats.size };
}
