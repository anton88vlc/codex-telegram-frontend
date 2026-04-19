import test from "node:test";
import assert from "node:assert/strict";

import { formatWorktreeSummary, parseGitNumstat, parseUntrackedFiles } from "../lib/worktree-summary.mjs";

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
  const text = formatWorktreeSummary(
    {
      files: [...tracked.files, ...untracked],
      fileCount: tracked.files.length + untracked.length,
      trackedCount: tracked.files.length,
      untrackedCount: untracked.length,
      totalAdditions: tracked.totalAdditions,
      totalDeletions: tracked.totalDeletions,
    },
    { maxFiles: 2 },
  );

  assert.match(text, /^\*\*Changed files\*\*/);
  assert.match(text, /3 files changed \+6 -1 1 untracked/);
  assert.match(text, /- `bridge\.mjs` \+5 -1/);
  assert.match(text, /- `README\.md` \+1 -0/);
  assert.match(text, /\.\.\. \+1 more/);
});
