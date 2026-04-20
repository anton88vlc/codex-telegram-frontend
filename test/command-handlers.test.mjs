import test from "node:test";
import assert from "node:assert/strict";

import { handleCommand, renderHelp } from "../lib/command-handlers.mjs";

const config = {
  botToken: "token",
  botUsername: "codexbot",
  syncDefaultLimit: 3,
  threadsDbPath: "/repo/state/threads.sqlite",
};

function makeMessage(overrides = {}) {
  return {
    chat: {
      id: -1001,
      type: "supergroup",
      title: "Codex - repo",
    },
    message_id: 10,
    message_thread_id: 3,
    ...overrides,
  };
}

test("renderHelp includes the bot mention hint when privacy mode blocks plain text", () => {
  const text = renderHelp(config);

  assert.match(text, /\/attach <thread-id>/);
  assert.match(text, /\/queue/);
  assert.match(text, /\/steer <text>/);
  assert.match(text, /@codexbot your request/);
});

test("handleCommand attaches a thread and remembers the reply", async () => {
  const state = { bindings: {}, outboundMirrors: {} };
  const remembered = [];
  const replies = [];

  await handleCommand({
    config,
    state,
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding: null,
    parsed: { command: "/attach", args: ["thread-1"] },
    nowFn: () => "2026-04-19T12:00:00.000Z",
    replyFn: async (token, message, text) => {
      replies.push({ token, message, text });
      return [{ message_id: 77 }];
    },
    rememberOutboundFn: (...args) => remembered.push(args),
  });

  const binding = state.bindings["group:-1001:topic:3"];
  assert.equal(binding.threadId, "thread-1");
  assert.equal(binding.chatTitle, "Codex - repo");
  assert.equal(binding.createdAt, "2026-04-19T12:00:00.000Z");
  assert.match(replies[0].text, /Bound this chat to thread thread-1/);
  assert.equal(remembered[0][0], binding);
  assert.deepEqual(remembered[0][1], [{ message_id: 77 }]);
});

test("handleCommand renders status through the injected status renderer", async () => {
  const sent = [];
  const remembered = [];
  const binding = { threadId: "thread-1" };

  await handleCommand({
    config,
    state: {},
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding,
    parsed: { command: "/status", args: [] },
    renderBindingStatusFn: async () => "status text",
    replyFn: async (token, message, text) => {
      sent.push(text);
      return [{ message_id: 78 }];
    },
    rememberOutboundFn: (...args) => remembered.push(args),
  });

  assert.deepEqual(sent, ["status text"]);
  assert.equal(remembered[0][0], binding);
});

test("handleCommand keeps /sync-project dry-run local and does not apply changes", async () => {
  const commandResponses = [];
  let applied = false;

  await handleCommand({
    config,
    state: {},
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding: null,
    parsed: { command: "/sync-project", args: ["dry-run", "5"] },
    parseSyncProjectArgsFn: () => ({ dryRun: true, requestedLimit: 5 }),
    buildSyncContextFn: async () => ({
      projectGroup: { groupTitle: "Codex - repo" },
      plan: {
        summary: { desiredCount: 2 },
      },
    }),
    renderSyncPreviewFn: () => "preview",
    applyProjectSyncPlanFn: async () => {
      applied = true;
    },
    sendCommandResponseFn: async ({ text }) => {
      commandResponses.push(text);
      return [{ message_id: 79 }];
    },
  });

  assert.equal(applied, false);
  assert.match(commandResponses[0], /\*\*Dry-run:\*\* Codex - repo/);
  assert.match(commandResponses[0], /desired thread column: 2/);
  assert.match(commandResponses[0], /preview/);
});

test("handleCommand can bind the newest unbound project thread", async () => {
  const state = {
    bindings: {
      existing: {
        chatId: "-1001",
        messageThreadId: 2,
        threadId: "thread-1",
      },
    },
  };
  const remembered = [];

  await handleCommand({
    config,
    state,
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding: null,
    parsed: { command: "/attach-latest", args: [] },
    loadProjectGroupForMessageFn: async () => ({
      projectGroup: {
        groupTitle: "Codex - repo",
        projectRoot: "/repo",
      },
    }),
    listProjectThreadsFn: async () => [
      { id: "thread-1", title: "Already bound" },
      { id: "thread-2", title: "Fresh thread" },
    ],
    replyFn: async () => [{ message_id: 80 }],
    rememberOutboundFn: (...args) => remembered.push(args),
  });

  const binding = state.bindings["group:-1001:topic:3"];
  assert.equal(binding.threadId, "thread-2");
  assert.equal(binding.threadTitle, "Fresh thread");
  assert.equal(remembered[0][0], binding);
});

test("handleCommand updates native mode on an existing binding", async () => {
  const binding = { threadId: "thread-1", transport: "app-server" };
  const remembered = [];

  await handleCommand({
    config,
    state: {},
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding,
    parsed: { command: "/mode", args: ["native"] },
    nowFn: () => "2026-04-19T13:00:00.000Z",
    replyFn: async () => [{ message_id: 81 }],
    rememberOutboundFn: (...args) => remembered.push(args),
  });

  assert.equal(binding.transport, "native");
  assert.equal(binding.updatedAt, "2026-04-19T13:00:00.000Z");
  assert.equal(remembered[0][0], binding);
});

test("handleCommand renders and clears the topic queue", async () => {
  const binding = {
    threadId: "thread-1",
    currentTurn: { source: "telegram" },
    turnQueue: [{ id: "q1", prompt: "queued work", promptPreview: "queued work" }],
  };
  const replies = [];

  await handleCommand({
    config,
    state: {},
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding,
    parsed: { command: "/queue", args: [] },
    replyFn: async (token, message, text) => {
      replies.push(text);
      return [{ message_id: 82 }];
    },
  });

  assert.match(replies[0], /\*\*Queue\*\*/);
  assert.match(replies[0], /queued work/);

  await handleCommand({
    config,
    state: {},
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding,
    parsed: { command: "/cancel-queue", args: [] },
    replyFn: async (token, message, text) => {
      replies.push(text);
      return [{ message_id: 83 }];
    },
  });

  assert.equal(binding.turnQueue.length, 0);
  assert.match(replies[1], /Canceled 1 queued prompt/);
});

test("handleCommand steers an active turn through app-control only", async () => {
  const binding = {
    threadId: "thread-1",
    currentTurn: { source: "telegram" },
  };
  const suppressions = [];
  const replies = [];
  const nativeCalls = [];

  await handleCommand({
    config: {
      ...config,
      nativeHelperPath: "/tmp/app-control.js",
      nativeTimeoutMs: 120000,
      nativeDebugBaseUrl: "http://127.0.0.1:9222",
      nativePollIntervalMs: 1000,
      appControlShowThread: false,
    },
    state: {},
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding,
    parsed: { command: "/steer", args: ["focus", "tests"] },
    rememberOutboundMirrorSuppressionFn: (...args) => suppressions.push(args),
    replyFn: async (token, message, text) => {
      replies.push(text);
      return [{ message_id: 84 }];
    },
    sendNativeTurnFn: async (...args) => {
      nativeCalls.push(args);
      return { transportPath: "app-control" };
    },
    shouldPreferAppServerFn: () => false,
  });

  assert.equal(nativeCalls[0][0].fallbackHelperPath, null);
  assert.equal(nativeCalls[0][0].prompt, "focus tests");
  assert.equal(binding.currentTurn.steerCount, 1);
  assert.equal(suppressions[0][2], "focus tests");
  assert.equal(replies[0], "Steered into the current turn.");
});
