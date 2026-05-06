import { logBridgeEvent } from "./bridge-events.mjs";

const DEFAULT_RETRY_PADDING_MS = 1_000;
const SKIP_LOG_COOLDOWN_MS = 30_000;
const REPEATED_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_RETRY_MULTIPLIER = 5;

export function parseTelegramRetryAfterSeconds(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = message.match(/retry after\s+(\d+)/i);
  if (!match) {
    return null;
  }
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function createTelegramRateLimitGate({
  nowMsFn = () => Date.now(),
  logEventFn = logBridgeEvent,
  retryPaddingMs = DEFAULT_RETRY_PADDING_MS,
} = {}) {
  let untilMs = 0;
  let lastSkipLoggedAtMs = 0;
  let lastRateLimitAtMs = 0;
  let consecutiveRateLimits = 0;

  function remainingMs(nowMs = nowMsFn()) {
    return Math.max(0, untilMs - nowMs);
  }

  return {
    isActive(nowMs = nowMsFn()) {
      return remainingMs(nowMs) > 0;
    },
    remainingMs,
    mark(error, context = {}) {
      const retryAfterSeconds = parseTelegramRetryAfterSeconds(error);
      if (!retryAfterSeconds) {
        return false;
      }
      const nowMs = nowMsFn();
      consecutiveRateLimits =
        nowMs - lastRateLimitAtMs <= REPEATED_RATE_LIMIT_WINDOW_MS ? consecutiveRateLimits + 1 : 1;
      lastRateLimitAtMs = nowMs;
      const retryMultiplier = Math.min(MAX_RETRY_MULTIPLIER, consecutiveRateLimits);
      untilMs = Math.max(untilMs, nowMs + retryAfterSeconds * 1000 * retryMultiplier + retryPaddingMs);
      logEventFn("telegram_rate_limit", {
        ...context,
        retryAfterSeconds,
        retryMultiplier,
        until: new Date(untilMs).toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    },
    logSkip(stage, context = {}) {
      const nowMs = nowMsFn();
      if (!this.isActive(nowMs)) {
        return false;
      }
      if (nowMs - lastSkipLoggedAtMs >= SKIP_LOG_COOLDOWN_MS) {
        lastSkipLoggedAtMs = nowMs;
        logEventFn("telegram_rate_limit_skip", {
          ...context,
          stage,
          remainingMs: remainingMs(nowMs),
          until: new Date(untilMs).toISOString(),
        });
      }
      return true;
    },
  };
}
