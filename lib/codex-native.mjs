import { spawn } from "node:child_process";

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
  return /fetch failed|failed to query .*\/json\/list|no page targets found|couldn't connect|econnrefused|127\.0\.0\.1:9222|window\.electronBridge/i.test(
    text,
  );
}

function classifyPrimaryError(error) {
  const text = errorMessage(error);
  if (/timed out|timeout|threads\.read/i.test(text)) {
    return "reply_timeout";
  }
  if (/fetch failed|failed to query .*\/json\/list|no page targets found|couldn't connect|econnrefused|127\.0\.0\.1:9222|window\.electronBridge/i.test(text)) {
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

function makeAppServerTransportError(error) {
  const message = errorMessage(error);
  return new NativeTransportError(`app-server ingress failed: ${message}`, {
    kind: "app_server_failed",
    attempts: [
      {
        path: "app-server-fallback",
        ok: false,
        error: message,
      },
    ],
  });
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

export async function sendNativeTurn({
  helperPath,
  fallbackHelperPath = null,
  threadId,
  prompt,
  timeoutMs = 120_000,
  debugBaseUrl = null,
  appServerUrl = null,
  pollIntervalMs = null,
  preferAppServer = false,
  appControlSkipReason = null,
  waitForReply = false,
  appControlShowThread = false,
}) {
  if (preferAppServer) {
    if (!fallbackHelperPath) {
      throw new NativeTransportError("app-server fallback helper is not configured", {
        kind: "fallback_unavailable",
        attempts: [],
      });
    }
    const primaryError = appControlSkipReason || "app-control skipped by circuit breaker";
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
      throw makeAppServerTransportError(error);
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
    if (!fallbackHelperPath || !shouldFallbackToAppServer(error)) {
      throw makeNativeTransportError({ primaryError: error });
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
