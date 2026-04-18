import { spawn } from "node:child_process";

function shouldFallbackToAppServer(error) {
  const text = error instanceof Error ? error.message : String(error);
  return /fetch failed|failed to query .*\/json\/list|no page targets found|couldn't connect|econnrefused|127\.0\.0\.1:9222|window\.electronBridge/i.test(
    text,
  );
}

function runHelper({
  helperPath,
  threadId,
  prompt,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      helperPath,
      "--thread-id",
      threadId,
      "--prompt",
      prompt,
      "--wait-for-reply",
      "--timeout-ms",
      String(timeoutMs),
    ];

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
}) {
  try {
    const result = await runHelper({
      helperPath,
      threadId,
      prompt,
      timeoutMs,
    });
    return {
      ...result,
      transportPath: "app-control",
      helperPath,
    };
  } catch (error) {
    if (!fallbackHelperPath || !shouldFallbackToAppServer(error)) {
      throw error;
    }
    const result = await runHelper({
      helperPath: fallbackHelperPath,
      threadId,
      prompt,
      timeoutMs,
    });
    return {
      ...result,
      transportPath: "app-server-fallback",
      primaryError: error instanceof Error ? error.message : String(error),
      helperPath: fallbackHelperPath,
    };
  }
}
