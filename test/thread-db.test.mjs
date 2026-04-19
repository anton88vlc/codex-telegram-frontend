import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getThreadsByIds } from "../lib/thread-db.mjs";

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
