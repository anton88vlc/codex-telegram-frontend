import { isClosedSyncBinding } from "./project-sync.mjs";

export const DEFAULT_BINDING_HOT_MAX_AGE_MS = 30 * 60 * 1000;
export const DEFAULT_BINDING_WARM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function timestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestProgressItemMs(binding) {
  const items = Array.isArray(binding?.currentTurn?.progressItems) ? binding.currentTurn.progressItems : [];
  return items.reduce((latest, item) => Math.max(latest, timestampMs(item?.timestamp)), 0);
}

export function getBindingRuntimeActivityMs(binding) {
  if (!binding || typeof binding !== "object") {
    return 0;
  }
  return Math.max(
    latestProgressItemMs(binding),
    timestampMs(binding.currentTurn?.startedAt),
    timestampMs(binding.currentTurn?.lastActivityAt),
    timestampMs(binding.currentTurn?.planUpdatedAt),
    timestampMs(binding.currentTurn?.finalAnswerAt),
    timestampMs(binding.currentTurn?.completedAt),
    timestampMs(binding.lastInboundAt),
    timestampMs(binding.lastMirroredAt),
    timestampMs(binding.lastAppServerStreamAt),
  );
}

export function hasActiveBindingWork(
  binding,
  {
    nowMs = Date.now(),
    hotMaxAgeMs = DEFAULT_BINDING_HOT_MAX_AGE_MS,
  } = {},
) {
  if (Array.isArray(binding?.turnQueue) && binding.turnQueue.length > 0) {
    return true;
  }
  if (!binding?.currentTurn) {
    return false;
  }
  const activityMs = getBindingRuntimeActivityMs(binding);
  if (!activityMs) {
    return false;
  }
  if (Number(hotMaxAgeMs) <= 0) {
    return true;
  }
  return Math.max(0, Number(nowMs) - activityMs) <= Number(hotMaxAgeMs);
}

export function getBindingRuntimeTier(
  binding,
  {
    nowMs = Date.now(),
    hotMaxAgeMs = DEFAULT_BINDING_HOT_MAX_AGE_MS,
    warmMaxAgeMs = DEFAULT_BINDING_WARM_MAX_AGE_MS,
  } = {},
) {
  if (hasActiveBindingWork(binding, { nowMs, hotMaxAgeMs })) {
    return "hot";
  }
  const activityMs = getBindingRuntimeActivityMs(binding);
  if (!activityMs) {
    return "cold";
  }
  const ageMs = Math.max(0, Number(nowMs) - activityMs);
  if (Number(hotMaxAgeMs) <= 0 || ageMs <= Number(hotMaxAgeMs)) {
    return "hot";
  }
  if (Number(warmMaxAgeMs) <= 0 || ageMs <= Number(warmMaxAgeMs)) {
    return "warm";
  }
  return "cold";
}

export function isOutboundMirrorBindingEligible(binding) {
  if (!binding?.threadId) {
    return false;
  }
  if ((binding.transport || "native") !== "native") {
    return false;
  }
  if (isClosedSyncBinding(binding)) {
    return false;
  }
  if (!binding.chatId) {
    return false;
  }
  return true;
}

export function isHotOutboundBinding(binding, config = {}, { nowMs = Date.now() } = {}) {
  if (!isOutboundMirrorBindingEligible(binding)) {
    return false;
  }
  return (
    getBindingRuntimeTier(binding, {
      nowMs,
      hotMaxAgeMs: config.bindingHotMaxAgeMs,
      warmMaxAgeMs: config.bindingWarmMaxAgeMs,
    }) === "hot"
  );
}

export function isAppServerStreamBindingEligible(binding, config = {}, { nowMs = Date.now() } = {}) {
  if (!isOutboundMirrorBindingEligible(binding)) {
    return false;
  }
  if (config.appServerStreamSubscribeHotOnly === false) {
    return true;
  }
  return isHotOutboundBinding(binding, config, { nowMs });
}

export function isStatusBarBindingEligible(binding) {
  if (!isOutboundMirrorBindingEligible(binding)) {
    return false;
  }
  return binding.messageThreadId != null;
}
