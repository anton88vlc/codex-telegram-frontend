import test from "node:test";
import assert from "node:assert/strict";

import { buildBindingPayload, formatThreadBullet, isAuthorized } from "../lib/bridge-bindings.mjs";

test("formatThreadBullet renders a compact thread line", () => {
  assert.equal(formatThreadBullet({ id: "thread-1", title: "Investigate repo" }), "- Investigate repo (thread-1)");
});

test("buildBindingPayload creates a stable Telegram to Codex binding payload", () => {
  const before = Date.now();
  const payload = buildBindingPayload({
    message: {
      chat: { id: -1001, title: "Codex Lab" },
      message_thread_id: 42,
    },
    thread: { id: "thread-1", title: "Investigate repo" },
  });
  const after = Date.now();

  assert.equal(payload.threadId, "thread-1");
  assert.equal(payload.transport, "native");
  assert.equal(payload.chatId, "-1001");
  assert.equal(payload.messageThreadId, 42);
  assert.equal(payload.chatTitle, "Codex Lab");
  assert.equal(payload.threadTitle, "Investigate repo");
  assert.ok(Date.parse(payload.createdAt) >= before);
  assert.ok(Date.parse(payload.updatedAt) <= after);
});

test("buildBindingPayload prefers explicit chat title and sanitizes long thread titles", () => {
  const payload = buildBindingPayload({
    message: { chat: { id: 123, first_name: "Anton" } },
    thread: { id: "thread-1", title: "x".repeat(200) },
    chatTitle: "Manual title",
  });
  assert.equal(payload.chatTitle, "Manual title");
  assert.equal(payload.threadTitle.length, 120);
});

test("isAuthorized allows unrestricted config and enforces user/chat allowlists", () => {
  const message = { from: { id: 1 }, chat: { id: -1001 } };
  assert.equal(isAuthorized({ allowedUserIds: [], allowedChatIds: [] }, message), true);
  assert.equal(isAuthorized({ allowedUserIds: [1], allowedChatIds: [] }, message), true);
  assert.equal(isAuthorized({ allowedUserIds: [2], allowedChatIds: [] }, message), false);
  assert.equal(isAuthorized({ allowedUserIds: [], allowedChatIds: ["-1001"] }, message), true);
  assert.equal(isAuthorized({ allowedUserIds: [], allowedChatIds: ["-2002"] }, message), false);
});
