import test from "node:test";
import assert from "node:assert/strict";

import {
  findFallbackTopicBindingForUnboundGroupMessage,
  getTopicBindingActivityMs,
  normalizeInboundPrompt,
  parseCommand,
  stripLeadingBotMention,
} from "../lib/message-routing.mjs";

test("parseCommand strips bot target from commands", () => {
  assert.deepEqual(parseCommand("/health@examplebot now"), {
    command: "/health",
    args: ["now"],
  });
});

test("parseCommand maps Telegram-menu-safe aliases to canonical commands", () => {
  assert.deepEqual(parseCommand("/sync_project 4 dry-run"), {
    command: "/sync-project",
    args: ["4", "dry-run"],
  });
  assert.deepEqual(parseCommand("/project_status"), {
    command: "/project-status",
    args: [],
  });
  assert.deepEqual(parseCommand("/attach_latest"), {
    command: "/attach-latest",
    args: [],
  });
  assert.deepEqual(parseCommand("/mode_native"), {
    command: "/mode",
    args: ["native"],
  });
});

test("stripLeadingBotMention removes a leading bot mention", () => {
  assert.equal(
    stripLeadingBotMention("@examplebot проверь health", "examplebot"),
    "проверь health",
  );
});

test("normalizeInboundPrompt keeps plain text intact", () => {
  assert.equal(
    normalizeInboundPrompt("обычный текст без mention", { botUsername: "examplebot" }),
    "обычный текст без mention",
  );
});

test("normalizeInboundPrompt returns empty string for mention-only message", () => {
  assert.equal(
    normalizeInboundPrompt("@examplebot", { botUsername: "examplebot" }),
    "",
  );
});

test("getTopicBindingActivityMs uses live turn and mirror timestamps before stale status bar noise", () => {
  assert.equal(
    getTopicBindingActivityMs({
      createdAt: "2026-04-19T09:00:00.000Z",
      updatedAt: "2026-04-19T10:00:00.000Z",
      statusBarUpdatedAt: "2026-04-19T12:00:00.000Z",
      lastMirroredAt: "2026-04-19T10:30:00.000Z",
      currentTurn: {
        startedAt: "2026-04-19T11:00:00.000Z",
        progressItems: [{ timestamp: "2026-04-19T11:05:00.000Z" }],
      },
    }),
    Date.parse("2026-04-19T11:05:00.000Z"),
  );
});

test("findFallbackTopicBindingForUnboundGroupMessage picks the most active topic in the same group", () => {
  const state = {
    bindings: {
      "group:-1001:topic:3": {
        chatId: "-1001",
        messageThreadId: 3,
        threadId: "thread-old",
        updatedAt: "2026-04-19T09:00:00.000Z",
      },
      "group:-1001:topic:5": {
        chatId: "-1001",
        messageThreadId: 5,
        threadId: "thread-new",
        lastMirroredAt: "2026-04-19T10:00:00.000Z",
      },
      "group:-1002:topic:9": {
        chatId: "-1002",
        messageThreadId: 9,
        threadId: "other-group",
        updatedAt: "2026-04-19T11:00:00.000Z",
      },
      "direct:123": {
        chatId: "123",
        messageThreadId: null,
        threadId: "direct-thread",
        updatedAt: "2026-04-19T12:00:00.000Z",
      },
    },
  };

  const fallback = findFallbackTopicBindingForUnboundGroupMessage(
    state,
    {
      chat: { id: -1001, type: "supergroup" },
      message_thread_id: 1,
    },
    { nowMs: Date.parse("2026-04-19T10:05:00.000Z") },
  );

  assert.equal(fallback.bindingKey, "group:-1001:topic:5");
  assert.equal(fallback.binding.threadId, "thread-new");
});

test("findFallbackTopicBindingForUnboundGroupMessage ignores stale, parked, current and direct bindings", () => {
  const state = {
    bindings: {
      "group:-1001:topic:1": {
        chatId: "-1001",
        messageThreadId: 1,
        threadId: "current-unbound-surface",
        updatedAt: "2026-04-19T10:00:00.000Z",
      },
      "group:-1001:topic:2": {
        chatId: "-1001",
        messageThreadId: 2,
        threadId: "parked",
        parked: true,
        updatedAt: "2026-04-19T10:00:00.000Z",
      },
      "group:-1001:topic:3": {
        chatId: "-1001",
        messageThreadId: 3,
        threadId: "stale",
        updatedAt: "2026-04-18T10:00:00.000Z",
      },
      "direct:-1001": {
        chatId: "-1001",
        messageThreadId: null,
        threadId: "direct",
        updatedAt: "2026-04-19T10:00:00.000Z",
      },
    },
  };

  const fallback = findFallbackTopicBindingForUnboundGroupMessage(
    state,
    {
      chat: { id: -1001, type: "supergroup" },
      message_thread_id: 1,
    },
    {
      nowMs: Date.parse("2026-04-19T10:05:00.000Z"),
      maxAgeMs: 60 * 60 * 1000,
    },
  );

  assert.equal(fallback, null);
});
