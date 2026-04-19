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
    historyMaxUserPrompts: 3,
    historyAssistantPhases: ["final_answer", "commentary"],
    historyIncludeHeartbeats: true,
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
  assert.equal(plan.onboarding.historyMaxUserPrompts, 3);
  assert.deepEqual(plan.onboarding.historyAssistantPhases, ["final_answer", "commentary"]);
  assert.equal(plan.onboarding.historyIncludeHeartbeats, true);
  assert.equal(plan.projects.length, 1);
  assert.match(formatBootstrapPlanSummary(plan), /folder codex-lab/);
  assert.match(formatBootstrapPlanSummary(plan), /display as tabs/);
  assert.match(formatBootstrapPlanSummary(plan), /history user prompt cap: 3/);
  assert.match(formatBootstrapPlanSummary(plan), /Codex Lab - app/);
});

test("onboard CLI supports top-level help", () => {
  const result = spawnSync(process.execPath, ["scripts/onboard.mjs", "--help"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /wizard/);
  assert.match(result.stdout, /quickstart/);
  assert.match(result.stdout, /--rehearsal/);
  assert.match(result.stdout, /--cleanup-dry-run/);
  assert.match(result.stdout, /prepare/);
});

test("onboard prepare creates local config and admin env from safe templates", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-onboard-prepare-"));
  const configPath = path.join(tmpDir, "config.local.json");
  const adminEnvPath = path.join(tmpDir, "admin", ".env");
  const adminPythonPath = path.join(tmpDir, "admin", ".venv", "bin", "python");

  const result = spawnSync(
    process.execPath,
    [
      "scripts/onboard.mjs",
      "prepare",
      "--no-input",
      "--skip-admin-deps",
      "--config",
      configPath,
      "--admin-env",
      adminEnvPath,
      "--admin-python",
      adminPythonPath,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /created config/);
  assert.match(result.stdout, /created admin env/);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(config.allowedUserIds, []);
  assert.equal(config.botUsername, null);
  const envText = fs.readFileSync(adminEnvPath, "utf8");
  assert.match(envText, /API_ID=/);
  assert.match(envText, /API_HASH=/);
});

test("onboard doctor prints actionable recovery steps", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-onboard-doctor-"));
  const result = spawnSync(
    process.execPath,
    [
      "scripts/onboard.mjs",
      "doctor",
      "--config",
      path.join(tmpDir, "config.local.json"),
      "--admin-env",
      path.join(tmpDir, "admin", ".env"),
      "--admin-python",
      path.join(tmpDir, "admin", ".venv", "bin", "python"),
      "--admin-session",
      path.join(tmpDir, "state", "telegram_user.session"),
      "--threads-db",
      path.join(tmpDir, "state.sqlite"),
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Recovery plan:/);
  assert.match(result.stdout, /npm run onboard:prepare/);
  assert.match(result.stdout, /--login-qr/);
});

test("onboard doctor treats placeholder admin env as incomplete", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-onboard-doctor-env-"));
  const adminDir = path.join(tmpDir, "admin");
  fs.mkdirSync(adminDir, { recursive: true });
  const adminEnvPath = path.join(adminDir, ".env");
  fs.writeFileSync(adminEnvPath, "API_ID=\nAPI_HASH=\nCODEX_TELEGRAM_BOT_USERNAME=your_bot_username_without_at\n");

  const result = spawnSync(
    process.execPath,
    [
      "scripts/onboard.mjs",
      "doctor",
      "--config",
      path.join(tmpDir, "config.local.json"),
      "--admin-env",
      adminEnvPath,
      "--admin-python",
      path.join(tmpDir, "admin", ".venv", "bin", "python"),
      "--admin-session",
      path.join(tmpDir, "state", "telegram_user.session"),
      "--threads-db",
      path.join(tmpDir, "state.sqlite"),
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /admin \.env with Telegram API_ID\/API_HASH/);
  assert.match(result.stdout, /API_ID\/API_HASH required/);
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

test("onboard quickstart writes latest active threads without manual selection", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-onboard-quickstart-"));
  const dbPath = path.join(tmpDir, "state.sqlite");
  const outputPath = path.join(tmpDir, "bootstrap-plan.json");
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
    insert into threads values ('t1', 'Latest A', '/tmp/project-a', 0, 40, 40000, 'local', '/tmp/rollout-a.jsonl', '', 'gpt-5.4', 'xhigh', 40, '', '');
    insert into threads values ('t2', 'Latest B', '/tmp/project-b', 0, 30, 30000, 'local', '/tmp/rollout-b.jsonl', '', 'gpt-5.4', 'high', 30, '', '');
    insert into threads values ('t3', 'Older A', '/tmp/project-a', 0, 20, 20000, 'local', '/tmp/rollout-c.jsonl', '', 'gpt-5.4', 'high', 20, '', '');
    insert into threads values ('t4', 'Too old C', '/tmp/project-c', 0, 10, 10000, 'local', '/tmp/rollout-d.jsonl', '', 'gpt-5.4', 'high', 10, '', '');
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
      "quickstart",
      "--preview",
      "--write",
      "--thread-limit",
      "3",
      "--no-input",
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
  assert.match(result.stdout, /Quickstart selected 3 latest active thread/);
  const plan = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(plan.onboarding.historyMaxMessages, 10);
  assert.equal(plan.onboarding.threadsPerProject, 3);
  assert.deepEqual(
    plan.projects.map((project) => project.projectRoot),
    ["/tmp/project-a", "/tmp/project-b"],
  );
  assert.deepEqual(
    plan.projects[0].topics.map((topic) => topic.threadId),
    ["t1", "t3"],
  );
  assert.deepEqual(
    plan.projects[1].topics.map((topic) => topic.threadId),
    ["t2"],
  );
});

test("onboard wizard previews existing Telegram surface reuse", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-onboard-reuse-"));
  const dbPath = path.join(tmpDir, "state.sqlite");
  const outputPath = path.join(tmpDir, "bootstrap-plan.rehearsal.json");
  const configPath = path.join(tmpDir, "config.local.json");
  const projectIndexPath = path.join(tmpDir, "bootstrap-result.json");
  const bridgeStatePath = path.join(tmpDir, "state.json");
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
  `;
  const sqlite = spawnSync("sqlite3", [dbPath, sql], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(sqlite.status, 0, sqlite.stderr);
  fs.writeFileSync(configPath, JSON.stringify({ projectIndexPath }, null, 2));
  fs.writeFileSync(
    projectIndexPath,
    JSON.stringify(
      {
        groups: [
          {
            projectRoot: "/tmp/project-a",
            groupTitle: "Codex Lab - project-a",
            botApiChatId: "-1001",
            topics: [{ title: "Setup thread", topicId: 5, threadId: "t1" }],
          },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    bridgeStatePath,
    JSON.stringify(
      {
        bindings: {
          "group:-1001:topic:5": {
            chatId: "-1001",
            messageThreadId: 5,
            threadId: "t1",
          },
        },
      },
      null,
      2,
    ),
  );

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
      "--config",
      configPath,
      "--bridge-state",
      bridgeStatePath,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reuse preview:/);
  assert.match(result.stdout, /group Codex Lab - project-a: reuse -1001/);
  assert.match(result.stdout, /topic Setup thread: reuse 5; binding already present/);
});

test("onboard wizard reads clean history defaults from config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-onboard-config-"));
  const dbPath = path.join(tmpDir, "state.sqlite");
  const outputPath = path.join(tmpDir, "bootstrap-plan.json");
  const configPath = path.join(tmpDir, "config.local.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        historyMaxMessages: 12,
        historyMaxUserPrompts: 4,
        historyAssistantPhases: ["final_answer", "commentary"],
        historyIncludeHeartbeats: true,
      },
      null,
      2,
    ),
  );
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
      "--no-input",
      "--write",
      "--threads-db",
      dbPath,
      "--output",
      outputPath,
      "--config",
      configPath,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(plan.onboarding.historyMaxMessages, 12);
  assert.equal(plan.onboarding.historyMaxUserPrompts, 4);
  assert.deepEqual(plan.onboarding.historyAssistantPhases, ["final_answer", "commentary"]);
  assert.equal(plan.onboarding.historyIncludeHeartbeats, true);
});
