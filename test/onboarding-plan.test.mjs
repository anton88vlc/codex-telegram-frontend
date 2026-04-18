import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.match(result.stdout, /--rehearsal/);
});
