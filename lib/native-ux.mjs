import { normalizeText } from "./message-routing.mjs";

function attemptError(error, path) {
  const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
  return normalizeText(attempts.find((attempt) => attempt?.path === path)?.error);
}

export function renderNativeSendError(error) {
  const raw = normalizeText(error instanceof Error ? error.message : String(error));
  const kind = normalizeText(error?.kind);
  const appControlError = attemptError(error, "app-control");
  const appServerError = attemptError(error, "app-server-fallback");

  if (kind === "reply_timeout" || /timed out|timeout/i.test(raw)) {
    return [
      "Codex did not return a final reply before timeout.",
      "The bridge is alive. Check Codex Desktop: if the request is still running there, wait there; otherwise retry from Telegram.",
    ].join("\n");
  }

  if (kind === "fallback_failed") {
    return [
      "Codex Desktop is not reachable from Telegram right now.",
      "app-control failed, and the app-server fallback failed too. Open Codex.app, preferably with `--remote-debugging-port=9222`, then retry.",
      appControlError ? `app-control: ${appControlError}` : null,
      appServerError ? `fallback: ${appServerError}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (kind === "app_control_unavailable" || /fetch failed|econnrefused|no page targets found|couldn't connect/i.test(raw)) {
    return [
      "Codex Desktop app-control is unavailable.",
      "The bridge is alive, but the preferred path is down. Open Codex.app with `--remote-debugging-port=9222`, then retry.",
    ].join("\n");
  }

  return "I could not deliver this message to Codex. It was not sent; technical details are in `/health` and the bridge log.";
}

export function appendTransportNotice(replyText, result = {}) {
  const text = normalizeText(replyText) || "(empty reply)";
  if (result?.transportPath !== "app-server-fallback") {
    return text;
  }
  return [
    text,
    "",
    "Transport note: delivered through app-server fallback. For the normal UI-aware path, restart Codex.app with `--remote-debugging-port=9222`.",
  ].join("\n");
}
