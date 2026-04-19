import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  captureWorktreeBaseline,
  formatWorktreeSummary,
  loadChangedFilesTextForThread,
  parseGitNumstat,
  parseUntrackedFiles,
  readGitHead,
  readWorktreeSummary,
  subtractWorktreeSummary,
} from "../lib/worktree-summary.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

test("parseGitNumstat collects file totals", () => {
  const summary = parseGitNumstat("5\t1\tbridge.mjs\n-\t-\tpublic/logo.png\n");

  assert.equal(summary.files.length, 2);
  assert.equal(summary.totalAdditions, 5);
  assert.equal(summary.totalDeletions, 1);
  assert.deepEqual(summary.files[0], {
    path: "bridge.mjs",
    additions: 5,
    deletions: 1,
    binary: false,
    untracked: false,
  });
  assert.equal(summary.files[1].binary, true);
});

test("formatWorktreeSummary renders compact Telegram-friendly list", () => {
  const tracked = parseGitNumstat("5\t1\tbridge.mjs\n1\t0\tREADME.md\n");
  const untracked = parseUntrackedFiles("lib/worktree-summary.mjs\n");
  const summary = {
    files: [...tracked.files, ...untracked],
    fileCount: tracked.files.length + untracked.length,
    trackedCount: tracked.files.length,
    untrackedCount: untracked.length,
    totalAdditions: tracked.totalAdditions,
    totalDeletions: tracked.totalDeletions,
  };
  const text = formatWorktreeSummary(summary);

  assert.match(text, /^\*\*Changed files\*\*/);
  assert.match(text, /3 files changed \+6 -1 1 untracked/);
  assert.match(text, /- `bridge\.mjs` \+5 -1/);
  assert.match(text, /- `README\.md` \+1 -0/);
  assert.match(text, /- `lib\/worktree-summary\.mjs` untracked/);
  assert.doesNotMatch(text, /\.\.\. \+\d+ more/);
  assert.match(formatWorktreeSummary(summary, { maxFiles: 2 }), /\.\.\. \+1 more/);
});

test("subtractWorktreeSummary hides files that were already dirty at turn start", () => {
  const baselineTracked = parseGitNumstat("5\t1\tbridge.mjs\n1\t0\tREADME.md\n");
  const currentTracked = parseGitNumstat("7\t1\tbridge.mjs\n1\t0\tREADME.md\n2\t0\tlib/new.mjs\n");
  const baseline = {
    cwd: "/repo",
    files: baselineTracked.files,
    fileCount: baselineTracked.files.length,
    trackedCount: baselineTracked.files.length,
    untrackedCount: 0,
    totalAdditions: baselineTracked.totalAdditions,
    totalDeletions: baselineTracked.totalDeletions,
  };
  const current = {
    cwd: "/repo",
    files: currentTracked.files,
    fileCount: currentTracked.files.length,
    trackedCount: currentTracked.files.length,
    untrackedCount: 0,
    totalAdditions: currentTracked.totalAdditions,
    totalDeletions: currentTracked.totalDeletions,
  };

  const delta = subtractWorktreeSummary(current, baseline);

  assert.equal(delta.fileCount, 2);
  assert.deepEqual(
    delta.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
    [
      { path: "bridge.mjs", additions: 2, deletions: 0 },
      { path: "lib/new.mjs", additions: 2, deletions: 0 },
    ],
  );
});

test("subtractWorktreeSummary returns null when nothing changed after baseline", () => {
  const tracked = parseGitNumstat("5\t1\tbridge.mjs\n");
  const summary = {
    cwd: "/repo",
    files: tracked.files,
    fileCount: tracked.files.length,
    trackedCount: tracked.files.length,
    untrackedCount: 0,
    totalAdditions: tracked.totalAdditions,
    totalDeletions: tracked.totalDeletions,
  };

  assert.equal(subtractWorktreeSummary(summary, summary), null);
});

test("captureWorktreeBaseline reads HEAD and a baseline summary for a thread cwd", async () => {
  const calls = [];
  const summary = { files: [], fileCount: 0 };
  const baseline = await captureWorktreeBaseline(
    { cwd: "/repo" },
    {
      readGitHeadFn: async (cwd) => {
        calls.push(["head", cwd]);
        return "abc123";
      },
      readWorktreeSummaryFn: async (cwd, options) => {
        calls.push(["summary", cwd, options]);
        return summary;
      },
    },
  );

  assert.deepEqual(baseline, { head: "abc123", summary });
  assert.deepEqual(calls, [
    ["head", "/repo"],
    ["summary", "/repo", { baseRef: "abc123" }],
  ]);
});

test("loadChangedFilesTextForThread fills a missing turn baseline and caches formatted text", async () => {
  let reads = 0;
  const baselineSummary = {
    cwd: "/repo",
    files: parseGitNumstat("1\t0\tbridge.mjs\n").files,
    fileCount: 1,
    trackedCount: 1,
    untrackedCount: 0,
    totalAdditions: 1,
    totalDeletions: 0,
  };
  const currentSummary = {
    cwd: "/repo",
    files: parseGitNumstat("3\t0\tbridge.mjs\n1\t0\tREADME.md\n").files,
    fileCount: 2,
    trackedCount: 2,
    untrackedCount: 0,
    totalAdditions: 4,
    totalDeletions: 0,
  };
  const binding = { currentTurn: {} };
  const cache = new Map();

  const first = await loadChangedFilesTextForThread({
    config: { worktreeSummaryMaxFiles: 0 },
    thread: { cwd: "/repo" },
    binding,
    cache,
    captureWorktreeBaselineFn: async () => ({ head: "base", summary: baselineSummary }),
    readWorktreeSummaryFn: async (cwd, options) => {
      reads += 1;
      assert.deepEqual([cwd, options], ["/repo", { baseRef: "base" }]);
      return currentSummary;
    },
  });
  const second = await loadChangedFilesTextForThread({
    config: {},
    thread: { cwd: "/repo" },
    binding,
    cache,
    readWorktreeSummaryFn: async () => {
      throw new Error("cache should avoid a second read");
    },
  });

  assert.equal(reads, 1);
  assert.equal(binding.currentTurn.worktreeBaseHead, "base");
  assert.match(first, /2 files changed \+3/);
  assert.match(first, /`bridge\.mjs` \+2 -0/);
  assert.equal(second, first);
});

test("loadChangedFilesTextForThread respects disabled worktree summaries", async () => {
  assert.equal(
    await loadChangedFilesTextForThread({
      config: { worktreeSummaryEnabled: false },
      thread: { cwd: "/repo" },
      binding: {},
    }),
    null,
  );
});

test("readWorktreeSummary includes committed changes since baseline plus current dirty worktree", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-worktree-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "codex@example.test"]);
  await git(dir, ["config", "user.name", "Codex Test"]);
  await fs.writeFile(path.join(dir, "file.txt"), "one\n", "utf8");
  await git(dir, ["add", "file.txt"]);
  await git(dir, ["commit", "-m", "base"]);
  const baseHead = await readGitHead(dir);

  await fs.writeFile(path.join(dir, "file.txt"), "one\ntwo\n", "utf8");
  await git(dir, ["add", "file.txt"]);
  await git(dir, ["commit", "-m", "first change"]);
  await fs.writeFile(path.join(dir, "file.txt"), "one\ntwo\nthree\n", "utf8");

  const summary = await readWorktreeSummary(dir, { baseRef: baseHead });
  const file = summary.files.find((item) => item.path === "file.txt");

  assert.equal(summary.fileCount, 1);
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 0);
});
