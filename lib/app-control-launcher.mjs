import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

export const DEFAULT_CODEX_APP_BINARY = "/Applications/Codex.app/Contents/MacOS/Codex";
export const DEFAULT_APP_CONTROL_BASE_URL = "http://127.0.0.1:9222";

const execFileAsync = promisify(execFile);

export function normalizeAppControlBaseUrl(baseUrl = DEFAULT_APP_CONTROL_BASE_URL) {
  const raw = String(baseUrl || DEFAULT_APP_CONTROL_BASE_URL).trim();
  if (!raw) {
    return DEFAULT_APP_CONTROL_BASE_URL;
  }
  return raw.replace(/\/+$/, "");
}

export function appControlJsonListUrl(baseUrl = DEFAULT_APP_CONTROL_BASE_URL) {
  return `${normalizeAppControlBaseUrl(baseUrl)}/json/list`;
}

export function parseAppControlPort(baseUrl = DEFAULT_APP_CONTROL_BASE_URL) {
  const parsed = new URL(normalizeAppControlBaseUrl(baseUrl));
  const port = Number.parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "80"), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`cannot parse app-control port from ${baseUrl}`);
  }
  return port;
}

export function buildCodexLaunchArgs(baseUrl = DEFAULT_APP_CONTROL_BASE_URL) {
  return [`--remote-debugging-port=${parseAppControlPort(baseUrl)}`];
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function checkAppControl(baseUrl = DEFAULT_APP_CONTROL_BASE_URL, { timeoutMs = 1000, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(appControlJsonListUrl(baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    }
    let targets = null;
    try {
      targets = await response.json();
    } catch {
      targets = null;
    }
    return {
      ok: true,
      status: response.status,
      targetCount: Array.isArray(targets) ? targets.length : null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parsePgrepOutput(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function isCodexAppRunning({ execFileImpl = execFileAsync } = {}) {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    const { stdout } = await execFileImpl("/usr/bin/pgrep", [
      "-f",
      "Codex\\.app/Contents/MacOS/Codex|/Applications/Codex\\.app/Contents/MacOS/Codex",
    ]);
    return parsePgrepOutput(stdout).length > 0;
  } catch {
    return false;
  }
}

export async function launchCodexAppControl({
  binaryPath = DEFAULT_CODEX_APP_BINARY,
  baseUrl = DEFAULT_APP_CONTROL_BASE_URL,
  spawnImpl = spawn,
  dryRun = false,
} = {}) {
  const args = buildCodexLaunchArgs(baseUrl);
  if (dryRun) {
    return {
      launched: false,
      dryRun: true,
      command: binaryPath,
      args,
    };
  }

  const child = spawnImpl(binaryPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();
  return {
    launched: true,
    pid: child.pid ?? null,
    command: binaryPath,
    args,
  };
}

export async function waitForAppControl(
  baseUrl = DEFAULT_APP_CONTROL_BASE_URL,
  { timeoutMs = 15_000, intervalMs = 500, checkImpl = checkAppControl } = {},
) {
  const startedAt = Date.now();
  let lastCheck = null;
  while (Date.now() - startedAt <= timeoutMs) {
    lastCheck = await checkImpl(baseUrl);
    if (lastCheck.ok) {
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        check: lastCheck,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    check: lastCheck,
  };
}

