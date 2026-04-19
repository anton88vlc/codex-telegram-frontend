import { normalizeText } from "./message-routing.mjs";

export function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function appControlCooldownUntilMs(binding) {
  return parseTimestampMs(binding?.appControlCooldownUntil);
}

export function shouldPreferAppServer(binding, config, nowMs = Date.now()) {
  if (!config.nativeFallbackHelperPath) {
    return false;
  }
  if (config.nativeIngressTransport === "app-server") {
    return true;
  }
  return Boolean(appControlCooldownUntilMs(binding) > nowMs);
}

export function markAppControlCooldown(binding, config, error, nowMs = Date.now()) {
  const cooldownMs = Math.max(0, Number(config.appControlCooldownMs) || 0);
  if (!cooldownMs) {
    return null;
  }
  const kind = normalizeText(error?.kind) || "send_failed";
  const until = new Date(nowMs + cooldownMs).toISOString();
  binding.appControlCooldownUntil = until;
  binding.lastTransportErrorAt = new Date(nowMs).toISOString();
  binding.lastTransportErrorKind = kind;
  return until;
}

export function markTransportError(binding, error, nowMs = Date.now()) {
  binding.lastTransportErrorAt = new Date(nowMs).toISOString();
  binding.lastTransportErrorKind = normalizeText(error?.kind) || "send_failed";
}
