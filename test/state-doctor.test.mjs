import test from "node:test";
import assert from "node:assert/strict";

import {
  applyStateDoctorActions,
  buildStateDoctorReport,
  formatStateDoctorReport,
} from "../lib/state-doctor.mjs";

test("buildStateDoctorReport finds stale bindings, dead topics and stale bootstrap entries", () => {
  const state = {
    bindings: {
      "group:-1001:topic:3": {
        chatId: "-1001",
        messageThreadId: 3,
        threadId: "thread-live",
        updatedAt: "2026-04-19T10:00:00.000Z",
      },
      "group:-1001:topic:4": {
        chatId: "-1001",
        messageThreadId: 4,
        threadId: "thread-dead-topic",
        updatedAt: "2026-04-19T10:05:00.000Z",
      },
      "group:-1001:topic:5": {
        chatId: "-1001",
        messageThreadId: 5,
        threadId: "thread-missing",
        updatedAt: "2026-04-19T10:06:00.000Z",
      },
      "group:-1001:topic:6": {
        chatId: "-1001",
        messageThreadId: 6,
        threadId: "thread-archived",
        updatedAt: "2026-04-19T10:07:00.000Z",
      },
      "group:-1001:topic:7": {
        chatId: "-1001",
        messageThreadId: 7,
        threadId: "thread-live",
        updatedAt: "2026-04-19T10:08:00.000Z",
      },
    },
    outboundMirrors: {
      "group:-1001:topic:3": {},
      "group:-9999:topic:1": {},
    },
  };
  const projectIndex = {
    groups: [
      {
        groupTitle: "Codex - app",
        botApiChatId: "-1001",
        topics: [
          { topicId: 3, threadId: "thread-live" },
          { topicId: 4, threadId: "thread-dead-topic" },
          { topicId: 99, threadId: "thread-old" },
        ],
      },
      {
        groupTitle: "Codex - old",
        botApiChatId: "-2002",
        topics: [{ topicId: 2, threadId: "thread-old" }],
      },
    ],
  };

  const report = buildStateDoctorReport({
    state,
    projectIndex,
    threads: [
      { id: "thread-live", archived: 0 },
      { id: "thread-dead-topic", archived: 0 },
      { id: "thread-archived", archived: 1 },
    ],
    recentEvents: [
      {
        type: "status_bar_update_error",
        bindingKey: "group:-1001:topic:4",
        error: "telegram sendMessage failed: Bad Request: message thread not found",
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.equal(report.findings.some((finding) => finding.kind === "binding-dead-telegram-topic"), true);
  assert.equal(report.findings.some((finding) => finding.kind === "binding-missing-thread"), true);
  assert.equal(report.findings.some((finding) => finding.kind === "binding-archived-thread"), true);
  assert.equal(report.findings.some((finding) => finding.kind === "duplicate-active-topic-binding"), true);
  assert.equal(report.findings.some((finding) => finding.kind === "orphan-outbound-mirror"), true);
  assert.equal(report.findings.some((finding) => finding.kind === "bootstrap-topic-without-binding"), true);
  assert.equal(report.findings.some((finding) => finding.kind === "bootstrap-group-without-bindings"), true);
  assert.equal(report.actions.some((action) => action.id === "tombstone-binding:group:-1001:topic:4"), true);
  assert.equal(report.actions.some((action) => action.id === "tombstone-binding:group:-1001:topic:5"), true);
  assert.equal(report.actions.some((action) => action.id === "tombstone-binding:group:-1001:topic:6"), true);
  assert.equal(report.actions.some((action) => action.id === "remove-outbound-mirror:group:-9999:topic:1"), true);
  assert.equal(report.actions.some((action) => action.id === "prune-bootstrap-topic:-1001:99"), true);
  assert.equal(report.actions.some((action) => action.id === "prune-bootstrap-group:-2002"), true);
  assert.match(formatStateDoctorReport(report), /STATE DOCTOR NEEDS REPAIR/);
});

test("applyStateDoctorActions only edits local state and bootstrap index", () => {
  const state = {
    bindings: {
      "group:-1001:topic:3": { threadId: "thread-live" },
      "group:-1001:topic:4": { threadId: "thread-dead" },
    },
    bindingTombstones: {},
    outboundMirrors: {
      "group:-1001:topic:4": {},
      "group:-9999:topic:1": {},
    },
  };
  const projectIndex = {
    groups: [
      {
        botApiChatId: "-1001",
        topics: [
          { topicId: 3, threadId: "thread-live" },
          { topicId: 4, threadId: "thread-dead" },
        ],
      },
      {
        botApiChatId: "-2002",
        topics: [{ topicId: 2, threadId: "thread-old" }],
      },
    ],
  };

  const result = applyStateDoctorActions({
    state,
    projectIndex,
    actions: [
      {
        id: "tombstone-binding:group:-1001:topic:4",
        type: "tombstone-binding",
        bindingKey: "group:-1001:topic:4",
        reason: "dead topic",
        safe: true,
      },
      {
        id: "remove-outbound-mirror:group:-9999:topic:1",
        type: "remove-outbound-mirror",
        bindingKey: "group:-9999:topic:1",
        reason: "orphan mirror",
        safe: true,
      },
      {
        id: "prune-bootstrap-topic:-1001:4",
        type: "prune-bootstrap-topic",
        chatId: "-1001",
        messageThreadId: 4,
        reason: "stale topic",
        safe: true,
      },
      {
        id: "prune-bootstrap-group:-2002",
        type: "prune-bootstrap-group",
        chatId: "-2002",
        reason: "stale group",
        safe: true,
      },
    ],
  });

  assert.equal(result.state.bindings["group:-1001:topic:3"].threadId, "thread-live");
  assert.equal(result.state.bindings["group:-1001:topic:4"], undefined);
  assert.match(result.state.bindingTombstones["group:-1001:topic:4"], /^20/);
  assert.equal(result.state.outboundMirrors["group:-1001:topic:4"], undefined);
  assert.equal(result.state.outboundMirrors["group:-9999:topic:1"], undefined);
  assert.deepEqual(result.projectIndex.groups.map((group) => group.botApiChatId), ["-1001"]);
  assert.deepEqual(result.projectIndex.groups[0].topics.map((topic) => topic.topicId), [3]);
  assert.equal(result.applied.length, 4);
  assert.equal(result.skipped.length, 0);
});

test("buildStateDoctorReport keeps app-server-created private Chat bindings quiet while thread DB catches up", () => {
  const state = {
    bindings: {
      "group:6074160741:topic:120646": {
        chatId: "6074160741",
        messageThreadId: 120646,
        threadId: "019da645-8252-7313-9d7c-16163f36e6de",
        createdBy: "private-topic-auto-create",
        surface: "codex-chats",
        updatedAt: "2026-04-19T15:04:31.000Z",
      },
    },
  };

  const report = buildStateDoctorReport({
    state,
    projectIndex: { groups: [] },
    threads: [],
    recentEvents: [],
  });

  assert.equal(report.ok, true);
  assert.equal(report.findings.some((finding) => finding.kind === "binding-missing-thread"), false);
  assert.equal(report.actions.some((action) => action.type === "tombstone-binding"), false);
  assert.match(formatStateDoctorReport(report), /STATE DOCTOR OK/);
});
