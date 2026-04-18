import test from "node:test";
import assert from "node:assert/strict";

import { renderTelegramChunks } from "../lib/telegram-format.mjs";

test("renderTelegramChunks formats bold, code and links into HTML", () => {
  const [chunk] = renderTelegramChunks("**Жирно** и `code`, плюс [ссылка](https://example.com)");

  assert.match(chunk.html, /<b>Жирно<\/b>/);
  assert.match(chunk.html, /<code>code<\/code>/);
  assert.match(chunk.html, /<a href="https:\/\/example.com">ссылка<\/a>/);
  assert.equal(chunk.plain, "Жирно и code, плюс ссылка (https://example.com)");
});

test("renderTelegramChunks keeps code fences as pre blocks", () => {
  const [chunk] = renderTelegramChunks("```js\nconst x = 1;\n```");

  assert.match(chunk.html, /<pre>const x = 1;<\/pre>/);
  assert.equal(chunk.plain, "const x = 1;");
});
