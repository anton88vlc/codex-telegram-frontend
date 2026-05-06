import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  appendAppServerStreamBuffer,
  categorizeAppServerMethod,
  extractAppServerMedia,
  formatAppServerStreamProgressLine,
  normalizeAppServerNotification,
  normalizeAppServerRequest,
  shouldKeepAppServerStreamEvent,
  summarizeAppServerStreamEvents,
} from "../lib/app-server-stream.mjs";

test("categorizeAppServerMethod groups stream events by Telegram UX use", () => {
  assert.equal(categorizeAppServerMethod("item/agentMessage/delta"), "agent_delta");
  assert.equal(categorizeAppServerMethod("item/reasoning/textDelta"), "reasoning");
  assert.equal(categorizeAppServerMethod("turn/plan/updated"), "plan");
  assert.equal(categorizeAppServerMethod("turn/diff/updated"), "diff");
  assert.equal(categorizeAppServerMethod("thread/tokenUsage/updated"), "token_usage");
  assert.equal(categorizeAppServerMethod("account/rateLimits/updated"), "rate_limits");
});

test("normalizeAppServerNotification extracts stable event fields", () => {
  const event = normalizeAppServerNotification(
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "hello",
      },
    },
    { ts: "2026-04-19T00:00:00.000Z" },
  );

  assert.equal(event.type, "app_server_stream_event");
  assert.equal(event.ts, "2026-04-19T00:00:00.000Z");
  assert.equal(event.category, "agent_delta");
  assert.equal(event.threadId, "thread-1");
  assert.equal(event.turnId, "turn-1");
  assert.equal(event.itemId, "item-1");
  assert.equal(event.deltaText, "hello");
  assert.equal(event.deltaChars, 5);
  assert.equal(event.textPreview, "hello");
});

test("normalizeAppServerNotification extracts generated image media from app-server items", () => {
  const event = normalizeAppServerNotification({
    method: "item/completed",
    params: {
      threadId: "thread-image",
      turnId: "turn-1",
      item: {
        id: "ig_123",
        type: "image_generation_call",
        result: "opaque-result-marker",
      },
    },
  });

  assert.equal(event.category, "media");
  assert.equal(event.textPreview, "Generated image");
  assert.deepEqual(event.media, [
    {
      type: "photo",
      source: "codex_image_generation",
      imageId: "ig_123",
      path: path.join(os.homedir(), ".codex", "generated_images", "thread-image", "ig_123.png"),
      mimeType: "image/png",
    },
  ]);
  assert.equal(formatAppServerStreamProgressLine(event), "Media ready: Generated image");
});

test("extractAppServerMedia keeps explicit local image attachments", () => {
  const media = extractAppServerMedia({
    threadId: "thread-1",
    attachments: [
      {
        type: "output_image",
        path: "/tmp/codex-output.jpg",
        mimeType: "image/jpeg",
      },
      {
        type: "file",
        path: "/tmp/not-image.txt",
        mimeType: "text/plain",
      },
    ],
  });

  assert.deepEqual(media, [
    {
      type: "photo",
      source: "app_server",
      imageId: null,
      path: "/tmp/codex-output.jpg",
      mimeType: "image/jpeg",
    },
  ]);
});

test("normalizeAppServerRequest extracts command approval requests", () => {
  const event = normalizeAppServerRequest(
    {
      id: 77,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        approvalReason: "Need to inspect local processes.",
        commandActions: [{ cmd: "ps -ax -o pid,start,etime,command | rg Codex" }],
        proposedExecpolicyAmendment: ["ps"],
      },
    },
    { ts: "2026-04-21T18:47:30.000Z" },
  );

  assert.equal(event.type, "app_server_request");
  assert.equal(event.category, "approval");
  assert.equal(event.requestKind, "command");
  assert.equal(event.requestId, "77");
  assert.equal(event.threadId, "thread-1");
  assert.equal(event.commandText, "ps -ax -o pid,start,etime,command | rg Codex");
  assert.deepEqual(event.proposedExecpolicyAmendment, ["ps"]);
});

test("normalizeAppServerRequest extracts permissions approval requests", () => {
  const event = normalizeAppServerRequest({
    id: 78,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      reason: "Need filesystem access.",
      permissions: {
        fileSystem: { enabled: true, access: "read", paths: ["/repo"] },
      },
    },
  });

  assert.equal(event.category, "approval");
  assert.equal(event.requestKind, "permissions");
  assert.deepEqual(event.permissions.fileSystem.paths, ["/repo"]);
});

test("normalizeAppServerRequest extracts user-input requests", () => {
  const event = normalizeAppServerRequest({
    id: 79,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-1",
      questions: [
        {
          id: "choice",
          header: "Mode",
          question: "Which route should I take?",
          options: [{ label: "Safe", description: "Avoid risky writes." }],
        },
      ],
    },
  });

  assert.equal(event.category, "user_input");
  assert.equal(event.requestKind, "user_input");
  assert.equal(event.questions[0].id, "choice");
  assert.equal(event.questions[0].options[0].label, "Safe");
});

test("normalizeAppServerRequest extracts MCP elicitation requests", () => {
  const event = normalizeAppServerRequest({
    id: 80,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      mode: "form",
      serverName: "Linear",
      message: "Install Linear?",
      _meta: {
        codex_approval_kind: "tool_suggestion",
        tool_type: "plugin",
        suggest_type: "install",
        tool_name: "Linear",
        suggest_reason: "Track project work.",
      },
    },
  });

  assert.equal(event.category, "elicitation");
  assert.equal(event.requestKind, "mcp_elicitation");
  assert.equal(event.kind, "tool_suggestion");
  assert.equal(event.toolName, "Linear");
});

test("normalizeAppServerNotification formats plan updates for Telegram progress", () => {
  const event = normalizeAppServerNotification({
    method: "turn/plan/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      plan: [
        { step: "Inspect stream", status: "completed" },
        { step: "Patch bridge", status: "in_progress" },
      ],
    },
  });

  assert.equal(event.category, "plan");
  assert.match(event.planText, /\*\*Todo\*\*/);
  assert.match(event.planText, /1\/2 done/);
  assert.match(event.planText, /2\. \[>\] Patch bridge/);
});

test("normalizeAppServerNotification keeps final agent text for direct delivery", () => {
  const event = normalizeAppServerNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "item-final",
        type: "agentMessage",
        phase: "final_answer",
        text: "This is the final answer, not just a tiny preview.",
      },
    },
  });

  assert.equal(event.category, "lifecycle");
  assert.equal(event.itemType, "agentMessage");
  assert.equal(event.phase, "final_answer");
  assert.equal(event.itemText, "This is the final answer, not just a tiny preview.");
});

test("appendAppServerStreamBuffer coalesces tiny reasoning deltas", () => {
  const turn = {};
  const first = normalizeAppServerNotification({
    method: "item/reasoning/textDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "Checking " },
  });
  const second = normalizeAppServerNotification({
    method: "item/reasoning/textDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "the bridge" },
  });

  appendAppServerStreamBuffer(turn, first);
  const buffer = appendAppServerStreamBuffer(turn, second);

  assert.equal(buffer, "Checking the bridge");
  assert.equal(formatAppServerStreamProgressLine(second, { bufferText: buffer }), "Thinking: Checking the bridge");
});

test("formatAppServerStreamProgressLine keeps bare status ticks out of chat", () => {
  const threadStatus = normalizeAppServerNotification({
    method: "thread/status/changed",
    params: { threadId: "thread-1" },
  });
  const modelRoute = normalizeAppServerNotification({
    method: "model/rerouted",
    params: { threadId: "thread-1", message: "rate limit" },
  });

  assert.equal(formatAppServerStreamProgressLine(threadStatus), null);
  assert.equal(formatAppServerStreamProgressLine(modelRoute), "Status: rate limit");
  assert.equal(
    formatAppServerStreamProgressLine(
      normalizeAppServerNotification({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1" } },
      }),
    ),
    null,
  );
});

test("shouldKeepAppServerStreamEvent filters by thread and turn while keeping global rate limits", () => {
  const target = normalizeAppServerNotification({
    method: "turn/plan/updated",
    params: { threadId: "thread-1", turnId: "turn-1", plan: [{ step: "ship", status: "in_progress" }] },
  });
  const other = normalizeAppServerNotification({
    method: "turn/plan/updated",
    params: { threadId: "thread-2", turnId: "turn-1", plan: [] },
  });
  const rate = normalizeAppServerNotification({
    method: "account/rateLimits/updated",
    params: { rateLimits: {} },
  });

  assert.equal(shouldKeepAppServerStreamEvent(target, { threadId: "thread-1", turnId: "turn-1" }), true);
  assert.equal(shouldKeepAppServerStreamEvent(other, { threadId: "thread-1", turnId: "turn-1" }), false);
  assert.equal(shouldKeepAppServerStreamEvent(rate, { threadId: "thread-1", turnId: "turn-1" }), true);
});

test("summarizeAppServerStreamEvents reports useful probe signals", () => {
  const events = [
    normalizeAppServerNotification({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    }),
    normalizeAppServerNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "abc" },
    }),
    normalizeAppServerNotification({
      method: "item/reasoning/textDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2", delta: "think" },
    }),
    normalizeAppServerNotification({
      method: "turn/diff/updated",
      params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git" },
    }),
    normalizeAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-3", text: "done", phase: "final_answer" },
      },
    }),
    normalizeAppServerNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    }),
  ];

  const summary = summarizeAppServerStreamEvents(events);

  assert.equal(summary.total, 6);
  assert.equal(summary.agentDeltaChars, 3);
  assert.equal(summary.reasoningDeltaChars, 5);
  assert.equal(summary.diffDeltaChars, 10);
  assert.equal(summary.finalAgentMessages, 1);
  assert.equal(summary.completedTurns, 1);
  assert.equal(summary.latestTurnId, "turn-1");
  assert.equal(summary.sawStreamingSignal, true);
});
