import fs from "node:fs/promises";

import { normalizeBotPrivateTopicReadiness } from "./bot-private-topics.mjs";
import { isThreadDbOptionalBinding } from "./binding-classification.mjs";
import { getMe } from "./telegram.mjs";
import { loadProjectIndex } from "./project-data.mjs";
import { inspectStateDoctor } from "./state-doctor.mjs";
import { getThreadsByIds } from "./thread-db.mjs";

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function inspectDebugEndpoint(debugBaseUrl) {
  try {
    const response = await fetch(`${String(debugBaseUrl).replace(/\/+$/, "")}/json/list`);
    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}`,
      };
    }
    const payload = await response.json();
    const pageTargets = Array.isArray(payload)
      ? payload.filter((item) => item?.type === "page" && item?.webSocketDebuggerUrl)
      : [];
    return {
      ok: true,
      pageTargets: pageTargets.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspectAppServer(appServerUrl, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    let settled = false;
    let ws = null;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ws?.close();
      } catch {}
      resolve({
        ok: false,
        error: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    ws = new WebSocket(appServerUrl);

    function finish(payload) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(payload);
    }

    ws.addEventListener("open", () => {
      finish({ ok: true });
    });

    ws.addEventListener("error", (event) => {
      finish({
        ok: false,
        error: event?.error?.message || event?.message || "websocket error",
      });
    });

    ws.addEventListener("close", (event) => {
      if (!settled) {
        finish({
          ok: false,
          error: `closed early (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
        });
      }
    });
  });
}

export async function buildSelfCheckReport({ config, state }) {
  const [
    botProfileResult,
    statePathExists,
    nativeHelperExists,
    fallbackHelperExists,
    chatStartHelperExists,
    threadsDbExists,
    projectIndexExists,
    debugEndpoint,
    appServer,
  ] = await Promise.all([
    getMe(config.botToken)
      .then((profile) => ({ ok: true, profile }))
      .catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        profile: null,
      })),
    pathExists(config.statePath),
    pathExists(config.nativeHelperPath),
    pathExists(config.nativeFallbackHelperPath),
    pathExists(config.nativeChatStartHelperPath),
    pathExists(config.threadsDbPath),
    pathExists(config.projectIndexPath),
    inspectDebugEndpoint(config.nativeDebugBaseUrl),
    inspectAppServer(config.appServerUrl),
  ]);

  let projectGroups = [];
  let projectIndexError = null;
  if (projectIndexExists) {
    try {
      projectGroups = await loadProjectIndex(config.projectIndexPath);
    } catch (error) {
      projectIndexError = error instanceof Error ? error.message : String(error);
    }
  }

  const bindingEntries = Object.entries(state.bindings ?? {});
  const bindingThreadIds = bindingEntries
    .map(([, binding]) => String(binding?.threadId ?? "").trim())
    .filter(Boolean);

  let threadRows = [];
  let threadsLookupError = null;
  if (threadsDbExists && bindingThreadIds.length > 0) {
    try {
      threadRows = await getThreadsByIds(config.threadsDbPath, bindingThreadIds);
    } catch (error) {
      threadsLookupError = error instanceof Error ? error.message : String(error);
    }
  }
  const threadsById = new Map(threadRows.map((row) => [String(row.id), row]));
  const staleBindings = bindingEntries
    .map(([bindingKey, binding]) => {
      const threadId = String(binding?.threadId ?? "").trim();
      const thread = threadId ? threadsById.get(threadId) ?? null : null;
      if (!threadId) {
        return `${bindingKey}: missing threadId`;
      }
      if (!thread) {
        if (isThreadDbOptionalBinding(binding)) {
          return null;
        }
        return `${bindingKey}: thread ${threadId} missing in threads DB`;
      }
      if (Number(thread.archived) !== 0) {
        return `${bindingKey}: thread ${threadId} archived`;
      }
      return null;
    })
    .filter(Boolean);

  const warnings = [];
  const notes = [];
  let stateDoctor = null;
  let stateDoctorError = null;
  try {
    stateDoctor = await inspectStateDoctor({ config, state });
  } catch (error) {
    stateDoctorError = error instanceof Error ? error.message : String(error);
  }

  const botPrivateTopics = botProfileResult.profile
    ? normalizeBotPrivateTopicReadiness(botProfileResult.profile)
    : null;

  if (!botProfileResult.ok) warnings.push(`telegram bot auth failed: ${botProfileResult.error}`);
  if (botPrivateTopics && !botPrivateTopics.ok) {
    notes.push("bot private topics are off; Codex Desktop Chats will be skipped until this is enabled");
  }
  if (!debugEndpoint.ok && !appServer.ok) {
    warnings.push(`no transport path available: app-control=${debugEndpoint.error}; app-server=${appServer.error}`);
  } else {
    if (!debugEndpoint.ok) notes.push(`app-control unavailable: ${debugEndpoint.error}`);
    if (!appServer.ok) notes.push(`app-server unavailable: ${appServer.error}`);
  }
  if (!projectIndexExists) warnings.push(`project index missing: ${config.projectIndexPath}`);
  if (projectIndexError) warnings.push(`project index invalid: ${projectIndexError}`);
  if (!threadsDbExists) warnings.push(`threads DB missing: ${config.threadsDbPath}`);
  if (threadsLookupError) warnings.push(`threads lookup failed: ${threadsLookupError}`);
  if (staleBindings.length) warnings.push(`stale bindings: ${staleBindings.length}`);
  if (stateDoctorError) warnings.push(`state doctor failed: ${stateDoctorError}`);
  if (stateDoctor?.summary?.findings) {
    warnings.push(`state doctor findings: ${stateDoctor.summary.findings}, safe repairs: ${stateDoctor.summary.repairable}`);
  }

  return {
    ok: warnings.length === 0,
    warnings,
    notes,
    botProfile: botProfileResult.profile,
    botPrivateTopics,
    botAuthError: botProfileResult.ok ? null : botProfileResult.error,
    statePathExists,
    nativeHelperExists,
    fallbackHelperExists,
    chatStartHelperExists,
    threadsDbExists,
    projectIndexExists,
    projectIndexError,
    projectGroups,
    debugEndpoint,
    appServer,
    stateDoctor,
    stateDoctorError,
    bindings: {
      total: bindingEntries.length,
      stale: staleBindings,
      processedMessages: Array.isArray(state.processedMessageKeys) ? state.processedMessageKeys.length : 0,
      lastUpdateId: state.lastUpdateId ?? 0,
    },
  };
}

export function formatSelfCheckReport(report, config) {
  const lines = [
    report.ok ? "SELF-CHECK OK" : "SELF-CHECK WARN",
    `bot: ${report.botProfile?.username ? `@${report.botProfile.username}` : "unresolved"}`,
    `bot private topics: ${
      report.botPrivateTopics
        ? `${report.botPrivateTopics.hasTopicsEnabled ? "on" : "off"}, user topics ${
            report.botPrivateTopics.allowsUsersToCreateTopics ? "allowed" : "bot-managed"
          }`
        : "unknown"
    }`,
    `state: ${config.statePath} (${report.statePathExists ? "ok" : "missing"})`,
    `bindings: ${report.bindings.total} total, ${report.bindings.stale.length} stale, processed keys ${report.bindings.processedMessages}, lastUpdateId ${report.bindings.lastUpdateId}`,
    `state doctor: ${
      report.stateDoctor
        ? `${report.stateDoctor.summary.findings} findings, ${report.stateDoctor.summary.repairable} safe repairs`
        : report.stateDoctorError || "not run"
    }`,
    `project index: ${config.projectIndexPath} (${report.projectIndexExists ? `${report.projectGroups.length} groups` : "missing"})`,
    `threads DB: ${config.threadsDbPath} (${report.threadsDbExists ? "ok" : "missing"})`,
    `native helper: ${config.nativeHelperPath} (${report.nativeHelperExists ? "ok" : "missing"})`,
    `fallback helper: ${config.nativeFallbackHelperPath} (${report.fallbackHelperExists ? "ok" : "missing"})`,
    `chat-start helper: ${config.nativeChatStartHelperPath} (${report.chatStartHelperExists ? "ok" : "missing"})`,
    `app-control: ${config.nativeDebugBaseUrl} (${report.debugEndpoint.ok ? `${report.debugEndpoint.pageTargets} page target(s)` : report.debugEndpoint.error})`,
    `app-server: ${config.appServerUrl} (${report.appServer.ok ? "reachable" : report.appServer.error})`,
    `event log: ${config.eventLogPath || config.bridgeLogPath || "logs/bridge.events.ndjson"}`,
  ];

  if (report.projectIndexError) {
    lines.push(`project index error: ${report.projectIndexError}`);
  }
  for (const staleBinding of report.bindings.stale) {
    lines.push(`stale binding: ${staleBinding}`);
  }
  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const note of report.notes ?? []) {
    lines.push(`note: ${note}`);
  }

  return lines.join("\n");
}
