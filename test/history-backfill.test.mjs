import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadCleanThreadHistoryFromRollout,
  sendHistoryBackfill,
} from "../lib/history-backfill.mjs";

function makeUserLine({ text, timestamp = "2026-04-21T10:00:00.000Z" }) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function makeAssistantLine({ text, phase = "final_answer", timestamp = "2026-04-21T10:00:01.000Z" }) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase,
      content: [{ type: "output_text", text }],
    },
  });
}

test("loadCleanThreadHistoryFromRollout keeps a clean recent user/final-answer tail", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-history-backfill-"));
  const rolloutPath = path.join(tempDir, "rollout.jsonl");
  await fs.writeFile(
    rolloutPath,
    [
      makeUserLine({ text: "old prompt" }),
      makeAssistantLine({ text: "working", phase: "commentary" }),
      makeAssistantLine({ text: "old final" }),
      makeUserLine({ text: "fresh prompt" }),
      makeAssistantLine({ text: "fresh final" }),
    ].join("\n") + "\n",
    "utf8",
  );

  const messages = await loadCleanThreadHistoryFromRollout(rolloutPath, {
    maxHistoryMessages: 3,
    assistantPhases: ["final_answer"],
  });

  assert.deepEqual(
    messages.map((item) => [item.role, item.text]),
    [
      ["user", "fresh prompt"],
      ["assistant", "fresh final"],
    ],
  );
});

test("sendHistoryBackfill sends labeled formatted history into the target topic", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-history-send-"));
  const rolloutPath = path.join(tempDir, "rollout.jsonl");
  await fs.writeFile(
    rolloutPath,
    `${makeUserLine({ text: "hello" })}\n${makeAssistantLine({ text: "done" })}\n`,
    "utf8",
  );
  const calls = [];

  const result = await sendHistoryBackfill({
    config: { botToken: "token" },
    thread: { rollout_path: rolloutPath },
    chatId: "607",
    messageThreadId: 22,
    sendMessageFn: async (token, args) => {
      calls.push({ token, args });
      return { ok: true };
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.messages, 2);
  assert.equal(result.sent, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].token, "token");
  assert.equal(calls[0].args.chatId, "607");
  assert.equal(calls[0].args.messageThreadId, 22);
  assert.equal(calls[0].args.parseMode, "HTML");
  assert.match(calls[0].args.text, /User/);
  assert.match(calls[0].args.text, /hello/);
});
