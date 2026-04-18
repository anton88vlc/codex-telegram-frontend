import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBootstrapPlan,
  buildGroupTitle,
  buildProjectPlan,
  formatBootstrapPlanSummary,
  projectNameFromRoot,
} from "../lib/onboarding-plan.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("projectNameFromRoot and buildGroupTitle derive readable Telegram names", () => {
  assert.equal(projectNameFromRoot("/Users/me/code/client-portal"), "client-portal");
  assert.equal(projectNameFromRoot("/Users/me/.codex/"), ".codex");
  assert.equal(buildGroupTitle("/Users/me/code/client-portal"), "Codex - client-portal");
  assert.equal(buildGroupTitle("/Users/me/code/client-portal", { groupPrefix: "Codex Lab - " }), "Codex Lab - client-portal");
});

test("buildProjectPlan selects a bounded thread working set", () => {
  const plan = buildProjectPlan(
    "/Users/me/code/app",
    [
      { id: "t1", title: "Первый тред" },
      { id: "t2", title: "Второй тред" },
      { id: "t3", title: "Третий тред" },
    ],
    { threadsPerProject: 2 },
  );

  assert.equal(plan.groupTitle, "Codex - app");
  assert.deepEqual(
    plan.topics.map((topic) => topic.threadId),
    ["t1", "t2"],
  );
});

test("buildBootstrapPlan keeps onboarding defaults near the generated plan", () => {
  const project = buildProjectPlan("/Users/me/code/app", [{ id: "t1", title: "Главная ветка" }], {
    groupPrefix: "Codex Lab - ",
  });
  const plan = buildBootstrapPlan([project], {
    generatedAt: "2026-04-18T20:00:00.000Z",
    threadsPerProject: 1,
    historyMaxMessages: 20,
    folderTitle: "codex-lab",
    groupPrefix: "Codex Lab - ",
    rehearsal: true,
  });

  assert.equal(plan.version, 1);
  assert.equal(plan.onboarding.rehearsal, true);
  assert.equal(plan.onboarding.folderTitle, "codex-lab");
  assert.equal(plan.onboarding.groupPrefix, "Codex Lab - ");
  assert.equal(plan.onboarding.topicDisplay, "tabs");
  assert.equal(plan.onboarding.threadsPerProject, 1);
  assert.equal(plan.onboarding.historyMaxMessages, 20);
  assert.equal(plan.projects.length, 1);
  assert.match(formatBootstrapPlanSummary(plan), /folder codex-lab/);
  assert.match(formatBootstrapPlanSummary(plan), /display as tabs/);
  assert.match(formatBootstrapPlanSummary(plan), /Codex Lab - app/);
});

test("onboard CLI supports top-level help", () => {
  const result = spawnSync(process.execPath, ["scripts/onboard.mjs", "--help"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /wizard/);
  assert.match(result.stdout, /--rehearsal/);
  assert.match(result.stdout, /--cleanup-dry-run/);
});

test("onboard wizard can write a non-interactive rehearsal plan", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-onboard-"));
  const dbPath = path.join(tmpDir, "state.sqlite");
  const outputPath = path.join(tmpDir, "bootstrap-plan.rehearsal.json");
  const sql = `
    create table threads (
      id text,
      title text,
      cwd text,
      archived integer,
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
    insert into threads values ('t1', 'Setup thread', '/tmp/project-a', 0, 20, 20000, 'local', '/tmp/rollout-a.jsonl', '', 'gpt-5.4', 'high', 10, '', '');
    insert into threads values ('t2', 'Second thread', '/tmp/project-a', 0, 10, 10000, 'local', '/tmp/rollout-b.jsonl', '', 'gpt-5.4', 'high', 10, '', '');
  `;
  const sqlite = spawnSync("sqlite3", [dbPath, sql], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(sqlite.status, 0, sqlite.stderr);

  const result = spawnSync(
    process.execPath,
    [
      "scripts/onboard.mjs",
      "wizard",
      "--rehearsal",
      "--no-input",
      "--write",
      "--threads-db",
      dbPath,
      "--output",
      outputPath,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(plan.onboarding.rehearsal, true);
  assert.equal(plan.onboarding.folderTitle, "codex-lab");
  assert.equal(plan.projects[0].groupTitle, "Codex Lab - project-a");
  assert.deepEqual(
    plan.projects[0].topics.map((topic) => topic.threadId),
    ["t1", "t2"],
  );
});
