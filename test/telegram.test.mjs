import test from "node:test";
import assert from "node:assert/strict";

import { splitTelegramText } from "../lib/telegram.mjs";

test("splitTelegramText keeps short text in one chunk", () => {
  assert.deepEqual(splitTelegramText("короткий текст"), ["короткий текст"]);
});

test("splitTelegramText splits long paragraphs without losing content", () => {
  const text = `Первый абзац.\n\n${"x".repeat(4000)}\n\nФинал.`;
  const chunks = splitTelegramText(text);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
  assert.equal(chunks[0], "Первый абзац.");
  assert.ok(chunks.at(-1).endsWith("Финал."));
  const xCount = chunks.join("").split("").filter((char) => char === "x").length;
  assert.equal(xCount, 4000);
});
