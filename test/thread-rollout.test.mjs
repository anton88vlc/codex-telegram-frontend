import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  makeOutboundMirrorSignature,
  parseAssistantMirrorChunk,
  readThreadMirrorDelta,
} from "../lib/thread-rollout.mjs";

function makeAssistantLine({ text, phase = "final_answer", timestamp = "2026-04-18T20:00:00.000Z" }) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase,
      content: [
        {
          type: "output_text",
          text,
        },
      ],
    },
  });
}

test("parseAssistantMirrorChunk keeps only assistant final answers", () => {
  const chunk = [
    makeAssistantLine({ text: "промежуточный статус", phase: "commentary" }),
    makeAssistantLine({ text: "Финальный ответ" }),
  ].join("\n");

  const parsed = parseAssistantMirrorChunk(`${chunk}\n`);

  assert.equal(parsed.trailingPartial, "");
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].phase, "final_answer");
  assert.equal(parsed.messages[0].text, "Финальный ответ");
});

test("readThreadMirrorDelta bootstraps to tail and then emits only appended final answers", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-rollout-"));
  const rolloutPath = path.join(tempDir, "rollout.jsonl");

  await fs.writeFile(
    rolloutPath,
    `${makeAssistantLine({ text: "старый статус", phase: "commentary" })}\n${makeAssistantLine({ text: "старый финал" })}\n`,
    "utf8",
  );

  const first = await readThreadMirrorDelta({
    rolloutPath,
    threadId: "thread-1",
  });
  assert.deepEqual(first.messages, []);
  assert.equal(first.mirror.initialized, true);
  assert.equal(first.mirror.lastSignature, null);

  await fs.appendFile(
    rolloutPath,
    `${makeAssistantLine({ text: "ещё один статус", phase: "commentary", timestamp: "2026-04-18T20:01:00.000Z" })}\n${makeAssistantLine({ text: "новый финал", timestamp: "2026-04-18T20:01:01.000Z" })}\n`,
    "utf8",
  );

  const second = await readThreadMirrorDelta({
    rolloutPath,
    mirrorState: first.mirror,
    threadId: "thread-1",
  });
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].text, "новый финал");
  assert.equal(second.mirror.byteOffset > first.mirror.byteOffset, true);
});

test("readThreadMirrorDelta can recover after rollout path changes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-rollout-"));
  const rolloutPathA = path.join(tempDir, "rollout-a.jsonl");
  const rolloutPathB = path.join(tempDir, "rollout-b.jsonl");

  await fs.writeFile(
    rolloutPathA,
    `${makeAssistantLine({ text: "финал A1" })}\n${makeAssistantLine({ text: "финал A2", timestamp: "2026-04-18T20:02:00.000Z" })}\n`,
    "utf8",
  );
  const initial = await readThreadMirrorDelta({
    rolloutPath: rolloutPathA,
    threadId: "thread-2",
  });
  assert.deepEqual(initial.messages, []);

  await fs.writeFile(
    rolloutPathB,
    `${makeAssistantLine({ text: "финал A1" })}\n${makeAssistantLine({ text: "финал A2", timestamp: "2026-04-18T20:02:00.000Z" })}\n${makeAssistantLine({ text: "финал B3", timestamp: "2026-04-18T20:03:00.000Z" })}\n`,
    "utf8",
  );
  const moved = await readThreadMirrorDelta({
    rolloutPath: rolloutPathB,
    mirrorState: {
      ...initial.mirror,
      rolloutPath: rolloutPathA,
      lastSignature: makeOutboundMirrorSignature({ phase: "final_answer", text: "финал A2" }),
    },
    threadId: "thread-2",
  });

  assert.equal(moved.messages.length, 1);
  assert.equal(moved.messages[0].text, "финал B3");
});
