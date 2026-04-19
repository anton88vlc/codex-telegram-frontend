import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderTelegramChunks } from "../lib/telegram-format.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("renderTelegramChunks formats bold, code and links into HTML", () => {
  const [chunk] = renderTelegramChunks("**Жирно** и `code`, плюс [ссылка](https://example.com)");

  assert.match(chunk.html, /<b>Жирно<\/b>/);
  assert.match(chunk.html, /<code>code<\/code>/);
  assert.match(chunk.html, /<a href="https:\/\/example.com">ссылка<\/a>/);
  assert.equal(chunk.plain, "Жирно и code, плюс ссылка (https://example.com)");
});

test("renderTelegramChunks formats lists, quotes and extra inline styles", () => {
  const [chunk] = renderTelegramChunks(`## Итог

- **готово**
- [x] проверить _курсив_ и *ещё курсив*
1. ссылка https://example.com/docs.

> Важная цитата с ~~мусором~~ и ||секретом||`);

  assert.match(chunk.html, /<b>Итог<\/b>/);
  assert.match(chunk.html, /• <b>готово<\/b>/);
  assert.match(chunk.html, /☑ проверить <i>курсив<\/i> и <i>ещё курсив<\/i>/);
  assert.match(chunk.html, /<b>1\.<\/b> ссылка <a href="https:\/\/example.com\/docs">https:\/\/example.com\/docs<\/a>\./);
  assert.match(chunk.html, /<blockquote>Важная цитата с <s>мусором<\/s> и <tg-spoiler>секретом<\/tg-spoiler><\/blockquote>/);
  assert.equal(
    chunk.plain,
    "Итог\n\n• готово\n☑ проверить курсив и ещё курсив\n1. ссылка https://example.com/docs.\n\n> Важная цитата с мусором и секретом",
  );
});

test("renderTelegramChunks renders Markdown tables as compact pre blocks", () => {
  const [chunk] = renderTelegramChunks(`| File | Change |
| --- | --- |
| bridge.mjs | +2 -1 |
| lib/telegram-format.mjs | +8 -0 |`);

  assert.match(chunk.html, /<pre>File\s+Change/);
  assert.match(chunk.html, /bridge\.mjs\s+\+2 -1/);
  assert.match(chunk.html, /lib\/telegram-format\.mjs\s+\+8 -0/);
  assert.doesNotMatch(chunk.html, /\| ---/);
  assert.match(chunk.plain, /File\s+Change/);
  assert.doesNotMatch(chunk.plain, /\| ---/);
});

test("renderTelegramChunks renders local file links as readable code text", () => {
  const [chunk] = renderTelegramChunks(
    "See [bridge.mjs](/Users/antonnaumov/code/codex-telegram-frontend/bridge.mjs:42) and [space file](</Users/a/My File.md:3>).",
  );

  assert.match(
    chunk.html,
    /<code>bridge\.mjs — \/Users\/antonnaumov\/code\/codex-telegram-frontend\/bridge\.mjs:42<\/code>/,
  );
  assert.match(chunk.html, /<code>space file — \/Users\/a\/My File\.md:3<\/code>/);
  assert.equal(
    chunk.plain,
    "See bridge.mjs — /Users/antonnaumov/code/codex-telegram-frontend/bridge.mjs:42 and space file — /Users/a/My File.md:3.",
  );
});

test("renderTelegramChunks keeps code fences as pre blocks", () => {
  const [chunk] = renderTelegramChunks("```js\nconst x = 1;\n```");

  assert.match(chunk.html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
  assert.equal(chunk.plain, "const x = 1;");
});

test("renderTelegramChunks leaves unmatched markdown markers literal", () => {
  const [chunk] = renderTelegramChunks("snake_case and **open bold and [bad link");

  assert.equal(chunk.html, "snake_case and **open bold and [bad link");
  assert.equal(chunk.plain, "snake_case and **open bold and [bad link");
});

test("render telegram text CLI exposes canonical HTML/plain chunks", () => {
  const result = spawnSync(process.execPath, ["scripts/render_telegram_text.mjs"], {
    cwd: PROJECT_ROOT,
    input: JSON.stringify({ texts: ["**User:**\n- [x] done"] }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.rendered[0][0].html, /<b>User:<\/b>/);
  assert.match(payload.rendered[0][0].html, /☑ done/);
  assert.equal(payload.rendered[0][0].plain, "User:\n☑ done");
});
