import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cleanupMirrorAssistantText,
  cleanupMirrorUserText,
  makeOutboundMirrorSignature,
  parseAssistantMirrorChunk,
  parseThreadMirrorChunk,
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

test("parseThreadMirrorChunk can include commentary for live chat mirror", () => {
  const chunk = [
    makeAssistantLine({ text: "Промежуточный апдейт", phase: "commentary" }),
    makeAssistantLine({ text: "Финальный ответ" }),
  ].join("\n");

  const parsed = parseThreadMirrorChunk(`${chunk}\n`, {
    phases: ["commentary", "final_answer"],
  });

  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].phase, "commentary");
  assert.equal(parsed.messages[0].text, "Промежуточный апдейт");
  assert.equal(parsed.messages[1].phase, "final_answer");
  assert.equal(parsed.messages[1].text, "Финальный ответ");
});

test("cleanupMirrorUserText strips file/image wrapper noise", () => {
  const cleaned = cleanupMirrorUserText(`# Files mentioned by the user:

## image.png:
/tmp/image.png

## My request for Codex:
Нужен ответ
<image name=[Image #1]>
</image>`);

  assert.equal(cleaned, "[files]\n- image.png\n\n[attached images omitted: 1]\n\nНужен ответ");
});

test("cleanupMirrorAssistantText strips Codex app directives", () => {
  const cleaned = cleanupMirrorAssistantText(`Сделано.

::git-stage{cwd="/repo"}
::git-commit{cwd="/repo"}

Финал.`);

  assert.equal(cleaned, "Сделано.\n\nФинал.");
});

test("parseThreadMirrorChunk keeps user mirrors and assistant final answers in order", () => {
  const chunk = [
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-04-18T20:10:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Привет из Codex Desktop" }],
      },
    }),
    makeAssistantLine({ text: "Финал после user turn", timestamp: "2026-04-18T20:10:05.000Z" }),
  ].join("\n");

  const parsed = parseThreadMirrorChunk(`${chunk}\n`);

  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].role, "user");
  assert.equal(parsed.messages[0].text, "Привет из Codex Desktop");
  assert.equal(parsed.messages[0].signature, makeOutboundMirrorSignature({ role: "user", text: "Привет из Codex Desktop" }));
  assert.equal(parsed.messages[1].role, "assistant");
  assert.equal(parsed.messages[1].text, "Финал после user turn");
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
