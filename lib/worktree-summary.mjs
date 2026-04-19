import { spawn } from "node:child_process";

import { normalizeText } from "./message-routing.mjs";

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MAX_FILES = 8;

function runGit(cwd, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`git timed out after ${timeoutMs}ms`));
    }, timeoutMs);

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
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `git failed with exit code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseNumstatNumber(value) {
  if (value === "-") {
    return null;
  }
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseGitNumstat(text) {
  const files = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const additions = parseNumstatNumber(parts[0]);
    const deletions = parseNumstatNumber(parts[1]);
    const filePath = normalizeText(parts.slice(2).join("\t"));
    if (!filePath) {
      continue;
    }
    if (Number.isInteger(additions)) {
      totalAdditions += additions;
    }
    if (Number.isInteger(deletions)) {
      totalDeletions += deletions;
    }
    files.push({
      path: filePath,
      additions,
      deletions,
      binary: additions === null || deletions === null,
      untracked: false,
    });
  }

  return {
    files,
    totalAdditions,
    totalDeletions,
  };
}

export function parseUntrackedFiles(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .map((filePath) => ({
      path: filePath,
      additions: null,
      deletions: null,
      binary: false,
      untracked: true,
    }));
}

export async function readWorktreeSummary(cwd, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const projectRoot = normalizeText(cwd);
  if (!projectRoot) {
    return null;
  }

  try {
    const [numstatText, untrackedText] = await Promise.all([
      runGit(projectRoot, ["diff", "--numstat", "HEAD", "--"], { timeoutMs }),
      runGit(projectRoot, ["ls-files", "--others", "--exclude-standard"], { timeoutMs }),
    ]);
    const tracked = parseGitNumstat(numstatText);
    const untrackedFiles = parseUntrackedFiles(untrackedText);
    const files = [...tracked.files, ...untrackedFiles];
    if (!files.length) {
      return null;
    }
    return {
      cwd: projectRoot,
      files,
      fileCount: files.length,
      trackedCount: tracked.files.length,
      untrackedCount: untrackedFiles.length,
      totalAdditions: tracked.totalAdditions,
      totalDeletions: tracked.totalDeletions,
    };
  } catch {
    return null;
  }
}

function pluralizeFile(count) {
  return count === 1 ? "file" : "files";
}

function formatPathForCode(path) {
  return normalizeText(path).replaceAll("`", "'");
}

function formatFileLine(file) {
  const pathText = `\`${formatPathForCode(file?.path)}\``;
  if (file?.untracked) {
    return `- ${pathText} untracked`;
  }
  if (file?.binary) {
    return `- ${pathText} binary`;
  }
  return `- ${pathText} +${Number(file?.additions) || 0} -${Number(file?.deletions) || 0}`;
}

export function formatWorktreeSummary(summary, { maxFiles = DEFAULT_MAX_FILES } = {}) {
  if (!summary?.fileCount || !Array.isArray(summary.files) || summary.files.length === 0) {
    return null;
  }

  const visibleLimit = Math.max(1, Number.parseInt(String(maxFiles), 10) || DEFAULT_MAX_FILES);
  const visibleFiles = summary.files.slice(0, visibleLimit);
  const remaining = Math.max(0, summary.files.length - visibleFiles.length);
  const totals = [];
  if (Number(summary.totalAdditions) > 0) {
    totals.push(`+${summary.totalAdditions}`);
  }
  if (Number(summary.totalDeletions) > 0) {
    totals.push(`-${summary.totalDeletions}`);
  }
  if (Number(summary.untrackedCount) > 0) {
    totals.push(`${summary.untrackedCount} untracked`);
  }

  const lines = [
    "**Changed files**",
    `${summary.fileCount} ${pluralizeFile(summary.fileCount)} changed${totals.length ? ` ${totals.join(" ")}` : ""}`,
    ...visibleFiles.map(formatFileLine),
  ];
  if (remaining > 0) {
    lines.push(`... +${remaining} more`);
  }
  return lines.join("\n");
}
