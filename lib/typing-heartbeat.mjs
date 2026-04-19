export const DEFAULT_TYPING_HEARTBEAT_INTERVAL_MS = 4_000;

const MIN_TYPING_HEARTBEAT_INTERVAL_MS = 1_000;
const MAX_TYPING_HEARTBEAT_INTERVAL_MS = 5_000;

function isUsableTarget(target) {
  return target?.chatId !== undefined && target?.chatId !== null && String(target.chatId).trim() !== "";
}

export function normalizeTypingHeartbeatIntervalMs(
  value,
  fallback = DEFAULT_TYPING_HEARTBEAT_INTERVAL_MS,
) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.max(
    MIN_TYPING_HEARTBEAT_INTERVAL_MS,
    Math.min(MAX_TYPING_HEARTBEAT_INTERVAL_MS, Math.round(number)),
  );
}

export function startTypingHeartbeat({
  token,
  target,
  sendTyping,
  intervalMs = DEFAULT_TYPING_HEARTBEAT_INTERVAL_MS,
  sendImmediately = true,
  onError = null,
} = {}) {
  if (!token || !isUsableTarget(target) || typeof sendTyping !== "function") {
    return {
      active: false,
      stop() {},
    };
  }

  let stopped = false;
  let inFlight = false;
  const normalizedIntervalMs = normalizeTypingHeartbeatIntervalMs(intervalMs);

  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      await sendTyping(token, target);
    } catch (error) {
      if (typeof onError === "function") {
        onError(error);
      }
    } finally {
      inFlight = false;
    }
  };

  if (sendImmediately) {
    void tick();
  }

  const timer = setInterval(tick, normalizedIntervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    active: true,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function stopTypingHeartbeats(heartbeats) {
  if (!heartbeats || typeof heartbeats.entries !== "function") {
    return 0;
  }

  let stopped = 0;
  for (const [key, heartbeat] of heartbeats.entries()) {
    try {
      heartbeat?.stop?.();
    } finally {
      heartbeats.delete(key);
      stopped += 1;
    }
  }
  return stopped;
}
