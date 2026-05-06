import { logBridgeEvent } from "./bridge-events.mjs";

const DEFAULT_RETRY_PADDING_MS = 1_000;
const DEFAULT_TRANSIENT_BACKOFF_MS = 10_000;
const MAX_TRANSIENT_BACKOFF_MS = 60_000;
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

export function isTransientTelegramDeliveryError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b(fetch failed|etimedout|econnreset|econnrefused|enotfound|network timeout)\b/i.test(message);
}

export function createTelegramRateLimitGate({
  nowMsFn = () => Date.now(),
  logEventFn = logBridgeEvent,
  retryPaddingMs = DEFAULT_RETRY_PADDING_MS,
  transientBackoffMs = DEFAULT_TRANSIENT_BACKOFF_MS,
} = {}) {
  let untilMs = 0;
  let lastSkipLoggedAtMs = 0;
  let lastRateLimitAtMs = 0;
  let consecutiveRateLimits = 0;
  let lastTransientAtMs = 0;
  let consecutiveTransients = 0;

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
      const nowMs = nowMsFn();
      if (!retryAfterSeconds) {
        if (!isTransientTelegramDeliveryError(error)) {
          return false;
        }
        consecutiveTransients =
          nowMs - lastTransientAtMs <= REPEATED_RATE_LIMIT_WINDOW_MS ? consecutiveTransients + 1 : 1;
        lastTransientAtMs = nowMs;
        const backoffMs = Math.min(
          MAX_TRANSIENT_BACKOFF_MS,
          Math.max(0, Number(transientBackoffMs)) * Math.min(MAX_RETRY_MULTIPLIER, consecutiveTransients),
        );
        if (backoffMs <= 0) {
          return false;
        }
        untilMs = Math.max(untilMs, nowMs + backoffMs + retryPaddingMs);
        logEventFn("telegram_delivery_backoff", {
          ...context,
          backoffMs,
          until: new Date(untilMs).toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
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
