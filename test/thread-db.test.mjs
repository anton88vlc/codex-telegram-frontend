import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { findActiveThreadSuccessors, getThreadsByIds, listQuickstartWorkItems } from "../lib/thread-db.mjs";

function runSqlite(dbPath, sql) {
  const result = spawnSync("sqlite3", [dbPath, sql], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

test("getThreadsByIds treats empty sqlite output as no rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codex-thread-db-"));
  try {
    const dbPath = path.join(tmpDir, "state.sqlite");
    runSqlite(
      dbPath,
      `
        create table threads (
          id text primary key,
          title text,
          cwd text,
          archived integer default 0,
          updated_at integer,
          updated_at_ms integer,
          source text,
          rollout_path text,
          model_provider text,
          model text,
          reasoning_effort text,
          tokens_used integer
        );
      `,
    );

    const rows = await getThreadsByIds(dbPath, ["thread-that-is-not-here"]);
    assert.deepEqual(rows, []);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("findActiveThreadSuccessors finds the latest active same-title same-cwd thread", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codex-thread-db-"));
  try {
    const dbPath = path.join(tmpDir, "state.sqlite");
    runSqlite(
      dbPath,
      `
        create table threads (
          id text primary key,
          title text,
          cwd text,
          archived integer default 0,
          updated_at integer,
          updated_at_ms integer,
          source text,
          rollout_path text,
          model_provider text,
          model text,
          reasoning_effort text,
          tokens_used integer,
          agent_nickname text,
          agent_role text
        );
        insert into threads values ('old', 'Main thread', '/tmp/project', 1, 10, 10000, 'local', '/tmp/old.jsonl', '', 'gpt-5.4', 'xhigh', 10, '', '');
        insert into threads values ('candidate-old', 'Main thread', '/tmp/project', 0, 20, 20000, 'local', '/tmp/candidate-old.jsonl', '', 'gpt-5.4', 'xhigh', 20, '', '');
        insert into threads values ('candidate-new', 'Main thread', '/tmp/project', 0, 30, 30000, 'local', '/tmp/candidate-new.jsonl', '', 'gpt-5.4', 'xhigh', 30, '', '');
        insert into threads values ('wrong-title', 'Other thread', '/tmp/project', 0, 40, 40000, 'local', '/tmp/wrong-title.jsonl', '', 'gpt-5.4', 'xhigh', 40, '', '');
        insert into threads values ('wrong-cwd', 'Main thread', '/tmp/other', 0, 50, 50000, 'local', '/tmp/wrong-cwd.jsonl', '', 'gpt-5.4', 'xhigh', 50, '', '');
      `,
    );

    const rows = await findActiveThreadSuccessors(dbPath, {
      id: "old",
      title: "Main thread",
      cwd: "/tmp/project",
    });

    assert.deepEqual(
      rows.map((row) => row.id),
      ["candidate-new", "candidate-old"],
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("listQuickstartWorkItems includes pinned Codex threads before the recent tail", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codex-thread-db-pinned-"));
  try {
    const dbPath = path.join(tmpDir, "state.sqlite");
    const globalStatePath = path.join(tmpDir, ".codex-global-state.json");
    runSqlite(
      dbPath,
      `
        create table threads (
          id text primary key,
          title text,
          cwd text,
          archived integer default 0,
          updated_at integer,
          updated_at_ms integer,
          source text,
          rollout_path text,
          model_provider text,
          model text,
          reasoning_effort text,
          tokens_used integer,
          agent_nickname text,
          agent_role text
        );
        insert into threads values ('recent', 'Recent thread', '/tmp/app', 0, 30, 30000, 'local', '/tmp/recent.jsonl', '', 'gpt-5.4', 'xhigh', 30, '', '');
        insert into threads values ('pinned', 'Pinned thread', '/tmp/app', 0, 10, 10000, 'local', '/tmp/pinned.jsonl', '', 'gpt-5.4', 'xhigh', 10, '', '');
        insert into threads values ('archived-pinned', 'Archived pinned thread', '/tmp/app', 1, 40, 40000, 'local', '/tmp/archived.jsonl', '', 'gpt-5.4', 'xhigh', 40, '', '');
      `,
    );
    await writeFile(
      globalStatePath,
      `${JSON.stringify({ "pinned-thread-ids": ["pinned", "archived-pinned"] }, null, 2)}\n`,
      "utf8",
    );

    const result = await listQuickstartWorkItems(dbPath, { limit: 2, globalStatePath });

    assert.deepEqual(
      result.threads.map((thread) => thread.id),
      ["pinned", "recent"],
    );
    assert.deepEqual(
      result.threads.map((thread) => thread.codexPinned),
      [true, false],
    );
    assert.equal(result.selectedPinnedThreadCount, 1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
