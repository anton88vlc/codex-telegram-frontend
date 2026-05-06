import { spawn } from "node:child_process";
import os from "node:os";

import { AppServerProtocolClient } from "./app-server-client.mjs";

const DEFAULT_CHAT_START_CWD = os.homedir();

export class NativeTransportError extends Error {
  constructor(message, { kind = "send_failed", attempts = [] } = {}) {
    super(message);
    this.name = "NativeTransportError";
    this.kind = kind;
    this.attempts = attempts;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function shouldFallbackToAppServer(error) {
  const text = errorMessage(error);
  return /fetch failed|failed to query .*\/json\/list|no page targets found|couldn't connect|econnrefused|127\.0\.0\.1:9222|window\.electronBridge|debug route did not mount/i.test(
    text,
  );
}

function classifyPrimaryError(error) {
  const text = errorMessage(error);
  if (/timed out|timeout|threads\.read/i.test(text)) {
    return "reply_timeout";
  }
  if (/fetch failed|failed to query .*\/json\/list|no page targets found|couldn't connect|econnrefused|127\.0\.0\.1:9222|window\.electronBridge|debug route did not mount/i.test(text)) {
    return "app_control_unavailable";
  }
  return "send_failed";
}

function makeNativeTransportError({ primaryError, fallbackError = null, fallbackAttempted = false } = {}) {
  const primaryMessage = errorMessage(primaryError);
  const attempts = [
    {
      path: "app-control",
      ok: false,
      error: primaryMessage,
    },
  ];

  if (fallbackAttempted) {
    attempts.push({
      path: "app-server-fallback",
      ok: false,
      error: errorMessage(fallbackError),
    });
  }

  const primaryKind = classifyPrimaryError(primaryError);
  const kind = fallbackAttempted ? "fallback_failed" : primaryKind;
  const message = fallbackAttempted
    ? `app-control failed and app-server fallback failed: app-control=${primaryMessage}; app-server=${errorMessage(fallbackError)}`
    : primaryMessage;
  return new NativeTransportError(message, { kind, attempts });
}

function makeAppServerTransportError(error, { path = "app-server" } = {}) {
  const message = errorMessage(error);
  return new NativeTransportError(`app-server ingress failed: ${message}`, {
    kind: /timed out|timeout/i.test(message) ? "reply_timeout" : "app_server_failed",
    attempts: [
      {
        path,
        ok: false,
        error: message,
      },
    ],
  });
}

function appServerInput(prompt) {
  return [
    {
      type: "text",
      text: prompt,
      text_elements: [],
    },
  ];
}

function isFinalAgentMessage(item) {
  return item?.type === "agentMessage" && item.phase === "final_answer";
}

function compactThread(thread, fallbackThreadId = null) {
  if (!thread && !fallbackThreadId) {
    return null;
  }
  return {
    id: thread?.id || fallbackThreadId,
    status: thread?.status,
    name: thread?.name ?? null,
    cwd: thread?.cwd ?? null,
  };
}

export async function sendTurnViaAppServer({
  threadId,
  prompt,
  timeoutMs = 120_000,
  appServerUrl = null,
  appServerOptions = null,
  waitForReply = false,
  clientFactory = (options) => new AppServerProtocolClient(options),
} = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  const normalizedPrompt = String(prompt || "");
  if (!normalizedThreadId) {
    throw new Error("missing thread id");
  }
  if (!normalizedPrompt) {
    throw new Error("missing prompt");
  }

  let currentTurnId = null;
  let finalAgentMessage = null;
  let completionResolve = null;
  let completionTimer = null;
  const completionPromise = new Promise((resolve) => {
    completionResolve = resolve;
  });
  const client = clientFactory({
    ...(appServerOptions || { url: appServerUrl }),
    clientInfo: {
      name: "codex-telegram-frontend-ingress",
      title: "Codex Telegram Frontend Ingress",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
    connectTimeoutMs: Math.min(timeoutMs, 10_000),
    requestTimeoutMs: timeoutMs,
    onNotification(message) {
      const params = message?.params || {};
      if (message.method === "turn/started" && params.threadId === normalizedThreadId) {
        currentTurnId = params.turn?.id || currentTurnId;
        return;
      }
      if (
        message.method === "item/completed" &&
        params.threadId === normalizedThreadId &&
        (!currentTurnId || params.turnId === currentTurnId) &&
        isFinalAgentMessage(params.item)
      ) {
        finalAgentMessage = params.item;
        return;
      }
      if (
        message.method === "turn/completed" &&
        params.threadId === normalizedThreadId &&
        (!currentTurnId || params.turn?.id === currentTurnId)
      ) {
        completionResolve({
          threadId: params.threadId,
          turn: params.turn || null,
        });
      }
    },
  });

  try {
    const startedAtMs = Date.now();
    await client.connect();
    const resumed = await client.request("thread/resume", {
      threadId: normalizedThreadId,
    });
    const turnStarted = await client.request("turn/start", {
      threadId: normalizedThreadId,
      input: appServerInput(normalizedPrompt),
    });
    currentTurnId = turnStarted?.turn?.id || currentTurnId;

    if (!waitForReply) {
      return {
        ok: true,
        mode: "native-send-only",
        transport: "app-server",
        url: appServerUrl,
        threadId: normalizedThreadId,
        prompt: normalizedPrompt,
        sentAtMs: startedAtMs,
        thread: compactThread(resumed?.thread, normalizedThreadId),
        turn: turnStarted?.turn || null,
      };
    }

    completionTimer = setTimeout(() => {
      completionResolve({ timeout: true });
    }, timeoutMs);

    const completion = await completionPromise;
    if (completion?.timeout) {
      throw new Error("timeout waiting for final reply");
    }

    return {
      ok: true,
      mode: "native-send-and-wait-for-reply",
      transport: "app-server",
      url: appServerUrl,
      threadId: normalizedThreadId,
      prompt: normalizedPrompt,
      sentAtMs: startedAtMs,
      turn: completion.turn || turnStarted?.turn || null,
      reply: finalAgentMessage
        ? {
            text: finalAgentMessage.text ?? "",
            phase: finalAgentMessage.phase ?? null,
            itemId: finalAgentMessage.id ?? null,
          }
        : null,
    };
  } finally {
    if (completionTimer) {
      clearTimeout(completionTimer);
    }
    await client.close?.();
  }
}

function appServerArgs(appServerUrl) {
  return appServerUrl ? ["--url", String(appServerUrl)] : [];
}

function appServerEnv(appServerUrl) {
  return appServerUrl
    ? {
        CODEX_APP_SERVER_URL: String(appServerUrl),
      }
    : {};
}

function runHelper({
  helperPath,
  threadId,
  prompt,
  timeoutMs,
  waitForReply = false,
  extraArgs = [],
  extraEnv = {},
}) {
  return new Promise((resolve, reject) => {
    const args = [
      helperPath,
      "--thread-id",
      threadId,
      "--prompt",
      prompt,
      "--timeout-ms",
      String(timeoutMs),
      ...extraArgs,
    ];
    if (waitForReply) {
      args.splice(5, 0, "--wait-for-reply");
    }

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`codex native send timed out after ${timeoutMs}ms`));
    }, timeoutMs + 5_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }

      if (code !== 0) {
        reject(
          new Error(
            parsed?.error ||
              stderr.trim() ||
              stdout.trim() ||
              `codex native send failed with exit code ${code}`,
          ),
        );
        return;
      }

      if (!parsed?.ok) {
        reject(new Error(parsed?.error || "codex native send returned non-ok result"));
        return;
      }

      resolve(parsed);
    });
  });
}

function runChatStartHelper({
  helperPath,
  title,
  cwd = null,
  prompt = null,
  timeoutMs,
  waitForReply = false,
  extraArgs = [],
  extraEnv = {},
}) {
  return new Promise((resolve, reject) => {
    const args = [
      helperPath,
      "--title",
      title,
      "--timeout-ms",
      String(timeoutMs),
      ...extraArgs,
    ];
    if (cwd !== undefined) {
      const resolvedCwd = cwd === null || cwd === "" ? DEFAULT_CHAT_START_CWD : String(cwd);
      args.push("--cwd", resolvedCwd);
    }
    if (prompt) {
      args.push("--prompt", prompt);
    }
    if (waitForReply) {
      args.push("--wait-for-reply");
    }

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`codex native chat start timed out after ${timeoutMs}ms`));
    }, timeoutMs + 5_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }

      if (code !== 0) {
        reject(
          new Error(
            parsed?.error ||
              stderr.trim() ||
              stdout.trim() ||
              `codex native chat start failed with exit code ${code}`,
          ),
        );
        return;
      }

      if (!parsed?.ok) {
        reject(new Error(parsed?.error || "codex native chat start returned non-ok result"));
        return;
      }

      resolve(parsed);
    });
  });
}

function makeAppServerChatStartError(error) {
  const message = errorMessage(error);
  return new NativeTransportError(`app-server chat start failed: ${message}`, {
    kind: "app_server_chat_start_failed",
    attempts: [
      {
        path: "app-server-thread-start",
        ok: false,
        error: message,
      },
    ],
  });
}

export async function createNativeChat({
  helperPath,
  title,
  cwd = null,
  prompt = null,
  timeoutMs = 45_000,
  appServerUrl = null,
  appServerOptions = null,
  waitForReply = false,
}) {
  if (!helperPath) {
    throw new NativeTransportError("app-server chat start helper is not configured", {
      kind: "chat_start_unavailable",
      attempts: [],
    });
  }
  try {
    const result = await runChatStartHelper({
      helperPath,
      title,
      cwd,
      prompt,
      timeoutMs,
      waitForReply,
      extraArgs: appServerArgs(appServerUrl),
      extraEnv: appServerEnv(appServerUrl),
    });
    return {
      ...result,
      transportPath: "app-server-thread-start",
      helperPath,
    };
  } catch (error) {
    throw makeAppServerChatStartError(error);
  }
}

export async function sendNativeTurn({
  helperPath,
  fallbackHelperPath = null,
  threadId,
  prompt,
  timeoutMs = 120_000,
  debugBaseUrl = null,
  appServerUrl = null,
  appServerOptions = null,
  pollIntervalMs = null,
  preferAppServer = false,
  appControlSkipReason = null,
  waitForReply = false,
  appControlShowThread = false,
  appServerClientFactory = null,
}) {
  const resolvedAppServerOptions = appServerOptions || (appServerUrl ? { url: appServerUrl } : null);
  const canUseAppServerProtocol = Boolean(resolvedAppServerOptions || appServerClientFactory);
  async function sendWithAppServerProtocol({ transportPath, primaryError = null } = {}) {
    const result = await sendTurnViaAppServer({
      threadId,
      prompt,
      timeoutMs,
      appServerUrl,
      appServerOptions: resolvedAppServerOptions,
      waitForReply,
      clientFactory: appServerClientFactory || ((options) => new AppServerProtocolClient(options)),
    });
    return {
      ...result,
      transportPath,
      primaryError,
      helperPath: null,
    };
  }

  if (preferAppServer) {
    const primaryError = appControlSkipReason || "app-control skipped by circuit breaker";
    if (canUseAppServerProtocol) {
      try {
        return await sendWithAppServerProtocol({
          transportPath: "app-server",
          primaryError,
        });
      } catch (error) {
        throw makeAppServerTransportError(error, { path: "app-server" });
      }
    }
    if (!fallbackHelperPath) {
      throw new NativeTransportError("app-server fallback helper is not configured", {
        kind: "fallback_unavailable",
        attempts: [],
      });
    }
    try {
      const result = await runHelper({
        helperPath: fallbackHelperPath,
        threadId,
        prompt,
        timeoutMs,
        waitForReply,
        extraArgs: appServerArgs(appServerUrl),
        extraEnv: appServerEnv(appServerUrl),
      });
      return {
        ...result,
        transportPath: "app-server-fallback",
        primaryError,
        helperPath: fallbackHelperPath,
      };
    } catch (error) {
      throw makeAppServerTransportError(error, { path: "app-server-fallback" });
    }
  }

  const primaryExtraArgs = [];
  const primaryExtraEnv = {};
  if (debugBaseUrl) {
    primaryExtraArgs.push("--debug-base-url", String(debugBaseUrl));
    primaryExtraEnv.CODEX_REMOTE_DEBUG_URL = String(debugBaseUrl);
  }
  if (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) {
    primaryExtraArgs.push("--poll-interval-ms", String(pollIntervalMs));
  }
  if (appControlShowThread) {
    primaryExtraArgs.push("--show-thread");
  }

  try {
    const result = await runHelper({
      helperPath,
      threadId,
      prompt,
      timeoutMs,
      waitForReply,
      extraArgs: primaryExtraArgs,
      extraEnv: primaryExtraEnv,
    });
    return {
      ...result,
      transportPath: "app-control",
      helperPath,
    };
  } catch (error) {
    if ((!fallbackHelperPath && !canUseAppServerProtocol) || !shouldFallbackToAppServer(error)) {
      throw makeNativeTransportError({ primaryError: error });
    }
    if (canUseAppServerProtocol) {
      try {
        return await sendWithAppServerProtocol({
          transportPath: "app-server-fallback",
          primaryError: errorMessage(error),
        });
      } catch (fallbackError) {
        throw makeNativeTransportError({ primaryError: error, fallbackError, fallbackAttempted: true });
      }
    }
    try {
      const result = await runHelper({
        helperPath: fallbackHelperPath,
        threadId,
        prompt,
        timeoutMs,
        waitForReply,
        extraArgs: appServerArgs(appServerUrl),
        extraEnv: appServerEnv(appServerUrl),
      });
      return {
        ...result,
        transportPath: "app-server-fallback",
        primaryError: errorMessage(error),
        helperPath: fallbackHelperPath,
      };
    } catch (fallbackError) {
      throw makeNativeTransportError({ primaryError: error, fallbackError, fallbackAttempted: true });
    }
  }
}
