import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyCodexChatSyncPlan,
  buildCodexChatSyncPlan,
  findPrivateChatTopicSurface,
  isLikelyCodexChatThread,
  syncAutoCodexChatTopics,
  upsertPrivateChatTopicsInProjectIndex,
} from "../lib/codex-chat-sync-runner.mjs";

test("isLikelyCodexChatThread keeps projectless and scratch Codex Chats separate from projects", () => {
  const homeDir = "/Users/anton";
  assert.equal(isLikelyCodexChatThread({ cwd: "" }, { homeDir }), true);
  assert.equal(isLikelyCodexChatThread({ cwd: "/Users/anton" }, { homeDir }), true);
  assert.equal(isLikelyCodexChatThread({ cwd: "/Users/anton/Documents/Codex/2026-note" }, { homeDir }), true);
  assert.equal(isLikelyCodexChatThread({ cwd: "/Users/anton/code/repo" }, { homeDir }), false);
});

test("buildCodexChatSyncPlan creates missing chat topics and renames stale titles", () => {
  const state = {
    bindings: {
      "group:607:topic:10": {
        chatId: "607",
        messageThreadId: 10,
        threadId: "chat-1",
        threadTitle: "Old title",
      },
    },
  };
  const nowMs = Date.parse("2026-04-21T10:00:00.000Z");
  const plan = buildCodexChatSyncPlan({
    state,
    chatId: "607",
    nowMs,
    maxThreadAgeMs: 7 * 24 * 60 * 60 * 1000,
    threads: [
      { id: "chat-1", title: "New title", cwd: "", updated_at_ms: nowMs },
      { id: "chat-2", title: "Fresh chat", cwd: os.homedir(), updated_at_ms: nowMs },
      { id: "project-1", title: "Project thread", cwd: "/Users/anton/code/repo", updated_at_ms: nowMs },
      { id: "old-chat", title: "Old chat", cwd: "", updated_at_ms: nowMs - 10 * 24 * 60 * 60 * 1000 },
    ],
    limit: 5,
  });

  assert.equal(plan.summary.desiredCount, 2);
  assert.deepEqual(plan.rename.map((item) => item.thread.id), ["chat-1"]);
  assert.deepEqual(plan.create.map((item) => item.thread.id), ["chat-2"]);

  const noSurfacePlan = buildCodexChatSyncPlan({
    state,
    chatId: null,
    threads: [{ id: "chat-3", title: "Should not plan", cwd: "" }],
  });
  assert.equal(noSurfacePlan.summary.createCount, 0);
});

test("applyCodexChatSyncPlan updates Telegram topics, bindings and project index", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chat-sync-"));
  const projectIndexPath = path.join(tmpDir, "bootstrap-result.json");
  await fsp.writeFile(
    projectIndexPath,
    `${JSON.stringify(
      {
        groups: [
          {
            surface: "private-chat-topics",
            groupTitle: "Codex - Chats",
            botApiChatId: "607",
            topics: [{ title: "Old title", topicId: 10, threadId: "chat-1" }],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const state = {
    bindings: {
      "group:607:topic:10": {
        chatId: "607",
        messageThreadId: 10,
        threadId: "chat-1",
        threadTitle: "Old title",
      },
    },
  };
  const plan = buildCodexChatSyncPlan({
    state,
    chatId: "607",
    threads: [
      { id: "chat-1", title: "New title", cwd: "" },
      { id: "chat-2", title: "Fresh chat", cwd: "" },
    ],
    limit: 5,
  });
  const edited = [];
  const created = [];

  const result = await applyCodexChatSyncPlan({
    config: { botToken: "token", projectIndexPath },
    state,
    chatGroup: {
      surface: "private-chat-topics",
      groupTitle: "Codex - Chats",
      botApiChatId: "607",
    },
    plan,
    now: "2026-04-21T10:00:00.000Z",
    editForumTopicFn: async (_token, args) => {
      edited.push(args);
      return true;
    },
    createForumTopicFn: async (_token, args) => {
      created.push(args);
      return { message_thread_id: 22 };
    },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(edited, [{ chatId: "607", messageThreadId: 10, name: "New title" }]);
  assert.deepEqual(created, [{ chatId: "607", name: "Fresh chat" }]);
  assert.equal(state.bindings["group:607:topic:10"].threadTitle, "New title");
  assert.equal(state.bindings["group:607:topic:22"].threadId, "chat-2");
  assert.equal(state.bindings["group:607:topic:22"].surface, "codex-chats");

  const index = JSON.parse(await fsp.readFile(projectIndexPath, "utf8"));
  assert.deepEqual(
    index.groups[0].topics.map((topic) => [topic.threadId, topic.title, topic.topicId]),
    [
      ["chat-1", "New title", 10],
      ["chat-2", "Fresh chat", 22],
    ],
  );
});

test("syncAutoCodexChatTopics only runs when a private chat topic surface exists", async () => {
  const applied = [];
  const result = await syncAutoCodexChatTopics({
    config: {
      botToken: "token",
      threadsDbPath: "/tmp/threads.sqlite",
      projectIndexPath: "/tmp/bootstrap-result.json",
      privateTopicAutoSyncEnabled: true,
      privateTopicAutoSyncLimit: 5,
      privateTopicAutoSyncMaxActionsPerTick: 3,
    },
    state: { bindings: {} },
    loadProjectIndexFn: async () => [
      {
        surface: "private-chat-topics",
        groupTitle: "Codex - Chats",
        botApiChatId: "607",
      },
    ],
    listQuickstartWorkItemsFn: async () => ({
      threads: [{ id: "chat-1", title: "Mail triage", cwd: "" }],
    }),
    applyCodexChatSyncPlanFn: async ({ plan }) => {
      applied.push(plan);
      return { changed: true, actionCount: 1, created: [{ threadId: "chat-1" }], renamed: [] };
    },
    logEventFn: () => {},
  });

  assert.equal(result.changed, true);
  assert.equal(result.checked, 1);
  assert.equal(applied[0].summary.createCount, 1);

  assert.equal(findPrivateChatTopicSurface([{ surface: "project-group" }]), null);
});

test("syncAutoCodexChatTopics reads private surfaces from the bootstrap index shape", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chat-sync-index-"));
  const projectIndexPath = path.join(tmpDir, "bootstrap-result.json");
  await fsp.writeFile(
    projectIndexPath,
    `${JSON.stringify(
      {
        groups: [
          {
            surface: "private-chat-topics",
            groupTitle: "Codex - Chats",
            botApiChatId: "607",
            topics: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const applied = [];
  const result = await syncAutoCodexChatTopics({
    config: {
      botToken: "token",
      threadsDbPath: "/tmp/threads.sqlite",
      projectIndexPath,
      privateTopicAutoSyncEnabled: true,
      privateTopicAutoSyncLimit: 5,
      privateTopicAutoSyncMaxActionsPerTick: 3,
    },
    state: { bindings: {} },
    listQuickstartWorkItemsFn: async () => ({
      threads: [{ id: "chat-1", title: "Mail triage", cwd: "" }],
    }),
    applyCodexChatSyncPlanFn: async ({ chatGroup, plan }) => {
      applied.push({ chatGroup, plan });
      return { changed: true, actionCount: 1, created: [{ threadId: "chat-1" }], renamed: [] };
    },
    logEventFn: () => {},
  });

  assert.equal(result.changed, true);
  assert.equal(applied[0].chatGroup.botApiChatId, "607");
  assert.equal(applied[0].plan.summary.createCount, 1);
});

test("syncAutoCodexChatTopics applies oversized plans in small batches", async () => {
  const logs = [];
  const applied = [];
  const result = await syncAutoCodexChatTopics({
    config: {
      botToken: "token",
      threadsDbPath: "/tmp/threads.sqlite",
      projectIndexPath: "/tmp/bootstrap-result.json",
      privateTopicAutoSyncEnabled: true,
      privateTopicAutoSyncLimit: 5,
      privateTopicAutoSyncMaxActionsPerTick: 1,
    },
    state: {
      bindings: {
        "group:607:topic:10": {
          chatId: "607",
          messageThreadId: 10,
          threadId: "chat-1",
          threadTitle: "Old title",
        },
      },
    },
    loadProjectIndexFn: async () => [
      {
        surface: "private-chat-topics",
        groupTitle: "Codex - Chats",
        botApiChatId: "607",
      },
    ],
    listQuickstartWorkItemsFn: async () => ({
      threads: [
        { id: "chat-2", title: "Fresh chat", cwd: "" },
        { id: "chat-1", title: "New title", cwd: "" },
      ],
    }),
    applyCodexChatSyncPlanFn: async ({ plan }) => {
      applied.push(plan);
      return { changed: true, actionCount: 1, created: [{ threadId: "chat-2" }], renamed: [] };
    },
    logEventFn: (type, payload) => logs.push({ type, payload }),
  });

  assert.equal(result.changed, true);
  assert.equal(applied[0].summary.createCount, 1);
  assert.equal(applied[0].summary.renameCount, 0);
  assert.equal(logs[0].type, "codex_chat_auto_sync_deferred");
  assert.equal(logs[0].payload.deferredCount, 1);
});

test("upsertPrivateChatTopicsInProjectIndex is a no-op without a private surface", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chat-sync-noop-"));
  const projectIndexPath = path.join(tmpDir, "bootstrap-result.json");
  await fsp.writeFile(projectIndexPath, `${JSON.stringify({ groups: [] }, null, 2)}\n`);

  assert.equal(
    await upsertPrivateChatTopicsInProjectIndex(projectIndexPath, { botApiChatId: "607" }, [
      { topicId: 1, title: "Nope", threadId: "chat-1" },
    ]),
    false,
  );
});
