import test from "node:test";
import assert from "node:assert/strict";

import { buildProjectSyncPlan } from "../lib/project-sync.mjs";

function makeThread(id, title) {
  return {
    id,
    title,
  };
}

function makeEntry(bindingKey, binding) {
  return {
    bindingKey,
    binding,
  };
}

test("buildProjectSyncPlan creates topics for desired threads when nothing is bound", () => {
  const plan = buildProjectSyncPlan({
    entries: [],
    threads: [makeThread("t1", "Первый"), makeThread("t2", "Второй")],
    requestedLimit: 2,
  });

  assert.equal(plan.summary.createCount, 2);
  assert.equal(plan.summary.renameCount, 0);
  assert.equal(plan.summary.reopenCount, 0);
  assert.equal(plan.summary.parkCount, 0);
  assert.deepEqual(
    plan.create.map((item) => item.thread.id),
    ["t1", "t2"],
  );
});

test("buildProjectSyncPlan prefers manual binding and parks duplicate sync topic", () => {
  const plan = buildProjectSyncPlan({
    entries: [
      makeEntry("manual:t1", {
        chatId: "-1001",
        messageThreadId: 3,
        threadId: "t1",
        transport: "native",
      }),
      makeEntry("sync:t1", {
        chatId: "-1001",
        messageThreadId: 7,
        threadId: "t1",
        createdBy: "sync-project",
        syncManaged: true,
        threadTitle: "Старое имя",
      }),
    ],
    threads: [makeThread("t1", "Рабочий тред")],
    requestedLimit: 1,
  });

  assert.equal(plan.summary.keepCount, 1);
  assert.equal(plan.keep[0].coverage, "manual");
  assert.equal(plan.summary.parkCount, 1);
  assert.equal(plan.park[0].reason, "manual_binding_exists");
});

test("buildProjectSyncPlan renames active sync, reopens parked sync and parks stale sync", () => {
  const plan = buildProjectSyncPlan({
    entries: [
      makeEntry("sync:t1", {
        chatId: "-1001",
        messageThreadId: 10,
        threadId: "t1",
        createdBy: "sync-project",
        syncManaged: true,
        threadTitle: "Очень старое имя",
      }),
      makeEntry("sync:t2:closed", {
        chatId: "-1001",
        messageThreadId: 11,
        threadId: "t2",
        createdBy: "sync-project",
        syncManaged: true,
        syncState: "closed",
        threadTitle: "Закрытый topic",
      }),
      makeEntry("sync:t3", {
        chatId: "-1001",
        messageThreadId: 12,
        threadId: "t3",
        createdBy: "sync-project",
        syncManaged: true,
        threadTitle: "Лишний topic",
      }),
    ],
    threads: [makeThread("t1", "Свежий тред"), makeThread("t2", "Вернулся наверх")],
    requestedLimit: 2,
  });

  assert.equal(plan.summary.renameCount, 1);
  assert.equal(plan.rename[0].entry.bindingKey, "sync:t1");
  assert.equal(plan.summary.reopenCount, 1);
  assert.equal(plan.reopen[0].entry.bindingKey, "sync:t2:closed");
  assert.equal(plan.summary.parkCount, 1);
  assert.equal(plan.park[0].entry.bindingKey, "sync:t3");
  assert.equal(plan.park[0].reason, "out_of_working_set");
});
