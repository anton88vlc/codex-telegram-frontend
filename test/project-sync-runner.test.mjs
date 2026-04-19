import test from "node:test";
import assert from "node:assert/strict";

import {
  applyProjectSyncPlan,
  countSyncPlanActions,
  formatSyncApplyResult,
  parseSyncProjectArgs,
  renderProjectStatus,
  renderSyncPreview,
  syncAutoProjectTopics,
} from "../lib/project-sync-runner.mjs";

function makeThread(id, title) {
  return { id, title };
}

function makeEntry(bindingKey, binding) {
  return { bindingKey, binding };
}

function emptyPlan(overrides = {}) {
  return {
    desiredThreads: [],
    activeEntries: [],
    parkedEntries: [],
    keep: [],
    rename: [],
    reopen: [],
    create: [],
    park: [],
    summary: {
      desiredCount: 0,
      activeCount: 0,
      parkedCount: 0,
      keepCount: 0,
      renameCount: 0,
      reopenCount: 0,
      createCount: 0,
      parkCount: 0,
    },
    ...overrides,
  };
}

test("parseSyncProjectArgs extracts dry-run and a bounded limit", () => {
  assert.deepEqual(parseSyncProjectArgs(["dry-run", "50"], 3), {
    dryRun: true,
    requestedLimit: 10,
  });
  assert.deepEqual(parseSyncProjectArgs(["--dry-run"], 4), {
    dryRun: true,
    requestedLimit: 4,
  });
});

test("renderSyncPreview shows topic actions and aligned state", () => {
  const preview = renderSyncPreview(
    emptyPlan({
      rename: [{ entry: makeEntry("rename", { messageThreadId: 10, threadTitle: "Old", threadId: "t1" }), thread: makeThread("t1", "New") }],
      reopen: [{ entry: makeEntry("reopen", { messageThreadId: 11, threadId: "t2" }), thread: makeThread("t2", "Back"), renameNeeded: true }],
      create: [{ thread: makeThread("t3", "Fresh") }],
      park: [{ entry: makeEntry("park", { messageThreadId: 12, threadTitle: "Stale", threadId: "t4" }), reason: "out_of_working_set" }],
      summary: {
        keepCount: 0,
        renameCount: 1,
        reopenCount: 1,
        createCount: 1,
        parkCount: 1,
      },
    }),
  );

  assert.match(preview, /Rename sync topics/);
  assert.match(preview, /reopen \+ rename -> Back/);
  assert.match(preview, /Fresh/);
  assert.match(preview, /out_of_working_set/);
  assert.match(renderSyncPreview(emptyPlan()), /already aligned/);
});

test("renderProjectStatus formats desired, active, parked and stale bindings", async () => {
  const text = await renderProjectStatus(
    {},
    {},
    { chat: { id: -1001 } },
    3,
    {
      buildSyncContextFn: async () => ({
        projectGroup: {
          groupTitle: "Codex - repo",
          projectRoot: "/repo",
          topics: [{}, {}],
        },
        diagnostics: {
          issues: ["- stale: thread missing"],
          threadsById: new Map([
            ["t1", { id: "t1", title: "Active thread" }],
            ["t2", { id: "t2", title: "Parked thread" }],
          ]),
        },
        plan: emptyPlan({
          desiredThreads: [makeThread("t1", "Active thread")],
          activeEntries: [
            makeEntry("active", {
              messageThreadId: 10,
              threadId: "t1",
              transport: "native",
            }),
          ],
          parkedEntries: [
            makeEntry("parked", {
              messageThreadId: 11,
              threadId: "t2",
              threadTitle: "Parked thread",
              syncManaged: true,
              syncState: "closed",
            }),
          ],
          summary: {
            desiredCount: 1,
            activeCount: 1,
            parkedCount: 1,
            keepCount: 1,
            renameCount: 0,
            reopenCount: 0,
            createCount: 0,
            parkCount: 0,
          },
        }),
      }),
    },
  );

  assert.match(text, /\*\*Project status:\*\* Codex - repo/);
  assert.match(text, /Desired thread column/);
  assert.match(text, /Current active topics/);
  assert.match(text, /Parked sync topics/);
  assert.match(text, /Stale bindings/);
});

test("applyProjectSyncPlan applies topic changes through injected Telegram helpers", async () => {
  const calls = [];
  const state = {
    bindings: {
      rename: { messageThreadId: 10, threadId: "t1", threadTitle: "Old" },
      reopen: { messageThreadId: 11, threadId: "t2", threadTitle: "Old closed", syncState: "closed" },
      park: { messageThreadId: 12, threadId: "t4", threadTitle: "Stale" },
    },
  };
  const plan = emptyPlan({
    rename: [{ entry: makeEntry("rename", state.bindings.rename), thread: makeThread("t1", "New") }],
    reopen: [{ entry: makeEntry("reopen", state.bindings.reopen), thread: makeThread("t2", "Back"), renameNeeded: true }],
    create: [{ thread: makeThread("t3", "Fresh") }],
    park: [{ entry: makeEntry("park", state.bindings.park), reason: "out_of_working_set" }],
  });

  const result = await applyProjectSyncPlan({
    config: { botToken: "token" },
    state,
    chatId: "-1001",
    projectGroup: { groupTitle: "Codex - repo" },
    plan,
    now: "2026-04-19T12:00:00.000Z",
    editForumTopicFn: async (token, payload) => calls.push(["edit", token, payload]),
    reopenForumTopicFn: async (token, payload) => calls.push(["reopen", token, payload]),
    createForumTopicFn: async (token, payload) => {
      calls.push(["create", token, payload]);
      return { message_thread_id: 99 };
    },
    closeForumTopicFn: async (token, payload) => calls.push(["close", token, payload]),
  });

  assert.equal(result.changed, true);
  assert.equal(result.actionCount, 4);
  assert.deepEqual(calls.map((call) => call[0]), ["edit", "reopen", "edit", "create", "close"]);
  assert.equal(state.bindings.rename.threadTitle, "New");
  assert.equal(state.bindings.reopen.threadTitle, "Back");
  assert.equal(state.bindings.park.syncState, "closed");
  assert.equal(state.bindings["group:-1001:topic:99"].threadId, "t3");
  assert.equal(state.bindings["group:-1001:topic:99"].createdBy, "sync-project");
});

test("applyProjectSyncPlan replies before parking the current topic", async () => {
  const calls = [];
  const state = {
    bindings: {
      current: { messageThreadId: 12, threadId: "t4", threadTitle: "Current stale" },
    },
  };
  await applyProjectSyncPlan({
    config: { botToken: "token" },
    state,
    chatId: "-1001",
    projectGroup: { groupTitle: "Codex - repo" },
    plan: emptyPlan({
      park: [{ entry: makeEntry("current", state.bindings.current), reason: "out_of_working_set" }],
    }),
    currentBindingKey: "current",
    sendResponse: async (text) => calls.push(["response", text]),
    closeForumTopicFn: async () => calls.push(["close"]),
  });

  assert.deepEqual(calls.map((call) => call[0]), ["response", "close"]);
  assert.match(calls[0][1], /Parked/);
});

test("formatSyncApplyResult reports no-op plans plainly", () => {
  assert.equal(countSyncPlanActions(emptyPlan()), 0);
  assert.match(
    formatSyncApplyResult({
      projectGroup: { groupTitle: "Codex - repo" },
      changed: { renamed: [], reopened: [], created: [], parked: [], parkPending: [] },
      plan: emptyPlan(),
    }),
    /Already aligned/,
  );
});

test("syncAutoProjectTopics applies projects within the action budget and logs skipped projects", async () => {
  const events = [];
  const result = await syncAutoProjectTopics({
    config: {
      topicAutoSyncEnabled: true,
      topicAutoSyncLimit: 3,
      syncDefaultLimit: 3,
      topicAutoSyncMaxActionsPerTick: 1,
    },
    state: {},
    loadProjectIndexFn: async () => [
      { chatId: "-1001", projectRoot: "/repo-a" },
      { chatId: "-1002", projectRoot: "/repo-b" },
    ],
    buildSyncContextForProjectGroupFn: async (config, state, projectGroup) => ({
      plan: emptyPlan({
        create: [{ thread: makeThread(`${projectGroup.chatId}-thread`, "Thread") }],
        summary: {
          desiredCount: 1,
          activeCount: 0,
          parkedCount: 0,
          keepCount: 0,
          renameCount: 0,
          reopenCount: 0,
          createCount: 1,
          parkCount: 0,
        },
      }),
    }),
    applyProjectSyncPlanFn: async () => ({ changed: true, actionCount: 1 }),
    logEventFn: (...args) => events.push(args),
  });

  assert.deepEqual(result, { changed: true, checked: 1, actionCount: 1 });
  assert.equal(events[0][0], "topic_auto_sync_project_applied");
});
