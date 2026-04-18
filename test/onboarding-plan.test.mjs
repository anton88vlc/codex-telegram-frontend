import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBootstrapPlan,
  buildGroupTitle,
  buildProjectPlan,
  formatBootstrapPlanSummary,
  projectNameFromRoot,
} from "../lib/onboarding-plan.mjs";

test("projectNameFromRoot and buildGroupTitle derive readable Telegram names", () => {
  assert.equal(projectNameFromRoot("/Users/me/code/client-portal"), "client-portal");
  assert.equal(projectNameFromRoot("/Users/me/.codex/"), ".codex");
  assert.equal(buildGroupTitle("/Users/me/code/client-portal"), "Codex - client-portal");
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
  const project = buildProjectPlan("/Users/me/code/app", [{ id: "t1", title: "Главная ветка" }]);
  const plan = buildBootstrapPlan([project], {
    generatedAt: "2026-04-18T20:00:00.000Z",
    threadsPerProject: 1,
    historyMaxMessages: 20,
  });

  assert.equal(plan.version, 1);
  assert.equal(plan.onboarding.threadsPerProject, 1);
  assert.equal(plan.onboarding.historyMaxMessages, 20);
  assert.equal(plan.projects.length, 1);
  assert.match(formatBootstrapPlanSummary(plan), /Codex - app/);
});
