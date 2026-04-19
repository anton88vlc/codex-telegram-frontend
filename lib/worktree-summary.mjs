import { spawn } from "node:child_process";

import { normalizeText } from "./message-routing.mjs";

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MAX_FILES = 0;

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

export async function readGitHead(cwd, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const projectRoot = normalizeText(cwd);
  if (!projectRoot) {
    return null;
  }
  try {
    return normalizeText(await runGit(projectRoot, ["rev-parse", "--verify", "HEAD"], { timeoutMs })) || null;
  } catch {
    return null;
  }
}

function mergeTrackedFiles(groups) {
  const byPath = new Map();
  for (const group of groups) {
    for (const file of Array.isArray(group?.files) ? group.files : []) {
      if (file?.untracked) {
        continue;
      }
      const filePath = normalizeText(file?.path);
      if (!filePath) {
        continue;
      }
      const existing = byPath.get(filePath) || {
        path: filePath,
        additions: 0,
        deletions: 0,
        binary: false,
        untracked: false,
      };
      if (file?.binary || file?.additions === null || file?.deletions === null) {
        existing.binary = true;
        existing.additions = null;
        existing.deletions = null;
      } else if (!existing.binary) {
        existing.additions += Number(file?.additions) || 0;
        existing.deletions += Number(file?.deletions) || 0;
      }
      byPath.set(filePath, existing);
    }
  }
  return Array.from(byPath.values());
}

function summarizeFiles({ cwd, trackedFiles, untrackedFiles }) {
  const files = [...trackedFiles, ...untrackedFiles];
  if (!files.length) {
    return null;
  }
  return {
    cwd,
    files,
    fileCount: files.length,
    trackedCount: trackedFiles.length,
    untrackedCount: untrackedFiles.length,
    totalAdditions: trackedFiles.reduce(
      (total, file) => total + (Number.isInteger(file.additions) ? file.additions : 0),
      0,
    ),
    totalDeletions: trackedFiles.reduce(
      (total, file) => total + (Number.isInteger(file.deletions) ? file.deletions : 0),
      0,
    ),
  };
}

function makeEmptySummary(cwd) {
  return {
    cwd,
    files: [],
    fileCount: 0,
    trackedCount: 0,
    untrackedCount: 0,
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

export async function readWorktreeSummary(cwd, { timeoutMs = DEFAULT_TIMEOUT_MS, baseRef = null } = {}) {
  const projectRoot = normalizeText(cwd);
  if (!projectRoot) {
    return null;
  }

  try {
    const normalizedBaseRef = normalizeText(baseRef);
    const committedPromise = normalizedBaseRef
      ? runGit(projectRoot, ["diff", "--numstat", normalizedBaseRef, "HEAD", "--"], { timeoutMs }).catch(() => "")
      : Promise.resolve("");
    const [committedText, numstatText, untrackedText] = await Promise.all([
      committedPromise,
      runGit(projectRoot, ["diff", "--numstat", "HEAD", "--"], { timeoutMs }),
      runGit(projectRoot, ["ls-files", "--others", "--exclude-standard"], { timeoutMs }),
    ]);
    const committed = parseGitNumstat(committedText);
    const tracked = parseGitNumstat(numstatText);
    const untrackedFiles = parseUntrackedFiles(untrackedText);
    return summarizeFiles({
      cwd: projectRoot,
      trackedFiles: mergeTrackedFiles([committed, tracked]),
      untrackedFiles,
    });
  } catch {
    return null;
  }
}

export async function captureWorktreeBaseline(
  thread,
  {
    readGitHeadFn = readGitHead,
    readWorktreeSummaryFn = readWorktreeSummary,
  } = {},
) {
  const cwd = normalizeText(thread?.cwd);
  if (!cwd) {
    return {
      head: null,
      summary: null,
    };
  }
  const head = await readGitHeadFn(cwd);
  const summary = await readWorktreeSummaryFn(cwd, { baseRef: head });
  return {
    head,
    summary,
  };
}

function normalizeFileDelta(current, baseline) {
  if (!baseline) {
    return current;
  }
  if (current?.untracked && baseline?.untracked) {
    return null;
  }
  if (current?.untracked || baseline?.untracked || current?.binary || baseline?.binary) {
    const currentSignature = JSON.stringify({
      untracked: Boolean(current?.untracked),
      binary: Boolean(current?.binary),
      additions: current?.additions ?? null,
      deletions: current?.deletions ?? null,
    });
    const baselineSignature = JSON.stringify({
      untracked: Boolean(baseline?.untracked),
      binary: Boolean(baseline?.binary),
      additions: baseline?.additions ?? null,
      deletions: baseline?.deletions ?? null,
    });
    return currentSignature === baselineSignature ? null : current;
  }

  const additions = (Number(current?.additions) || 0) - (Number(baseline?.additions) || 0);
  const deletions = (Number(current?.deletions) || 0) - (Number(baseline?.deletions) || 0);
  if (additions === 0 && deletions === 0) {
    return null;
  }
  return {
    ...current,
    additions,
    deletions,
  };
}

export function subtractWorktreeSummary(current, baseline = null) {
  if (!current?.fileCount || !Array.isArray(current.files) || current.files.length === 0) {
    return null;
  }
  if (!baseline?.fileCount || !Array.isArray(baseline.files) || baseline.files.length === 0) {
    return current;
  }

  const baselineByPath = new Map();
  for (const file of baseline.files) {
    const filePath = normalizeText(file?.path);
    if (filePath) {
      baselineByPath.set(filePath, file);
    }
  }

  const files = current.files.map((file) => normalizeFileDelta(file, baselineByPath.get(normalizeText(file?.path)))).filter(Boolean);
  if (!files.length) {
    return null;
  }

  const trackedFiles = files.filter((file) => !file.untracked);
  const untrackedFiles = files.filter((file) => file.untracked);
  return summarizeFiles({
    cwd: current.cwd || baseline.cwd,
    trackedFiles,
    untrackedFiles,
  }) || makeEmptySummary(current.cwd || baseline.cwd);
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
  if ((Number(file?.additions) || 0) < 0 || (Number(file?.deletions) || 0) < 0) {
    return `- ${pathText} changed`;
  }
  return `- ${pathText} +${Number(file?.additions) || 0} -${Number(file?.deletions) || 0}`;
}

export function formatWorktreeSummary(summary, { maxFiles = DEFAULT_MAX_FILES } = {}) {
  if (!summary?.fileCount || !Array.isArray(summary.files) || summary.files.length === 0) {
    return null;
  }

  const parsedMaxFiles = Number.parseInt(String(maxFiles), 10);
  const visibleLimit = Number.isFinite(parsedMaxFiles) && parsedMaxFiles > 0 ? parsedMaxFiles : summary.files.length;
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

export async function loadChangedFilesTextForThread({
  config = {},
  thread,
  binding,
  cache = new Map(),
  captureWorktreeBaselineFn = captureWorktreeBaseline,
  readWorktreeSummaryFn = readWorktreeSummary,
  subtractWorktreeSummaryFn = subtractWorktreeSummary,
  formatWorktreeSummaryFn = formatWorktreeSummary,
} = {}) {
  if (config.worktreeSummaryEnabled === false) {
    return null;
  }
  const cwd = normalizeText(thread?.cwd);
  if (!cwd) {
    return null;
  }
  let baseRef = normalizeText(binding?.currentTurn?.worktreeBaseHead);
  let baselineSummary = binding?.currentTurn?.worktreeBaseSummary || null;
  if (!baseRef && binding?.currentTurn) {
    const baseline = await captureWorktreeBaselineFn(thread);
    baseRef = baseline.head;
    baselineSummary = baseline.summary;
    if (baseRef || baselineSummary) {
      binding.currentTurn.worktreeBaseHead = baseRef;
      binding.currentTurn.worktreeBaseSummary = baselineSummary;
    }
  }
  const cacheKey = `${cwd}\0${baseRef || ""}\0${JSON.stringify(baselineSummary?.files || [])}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) || null;
  }
  const summary = subtractWorktreeSummaryFn(await readWorktreeSummaryFn(cwd, { baseRef }), baselineSummary);
  const text = formatWorktreeSummaryFn(summary, {
    maxFiles: config.worktreeSummaryMaxFiles,
  });
  cache.set(cacheKey, text);
  return text || null;
}
