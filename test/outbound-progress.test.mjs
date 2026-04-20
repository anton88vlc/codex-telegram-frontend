import test from "node:test";
import assert from "node:assert/strict";

import {
  appendOutboundProgressItem,
  formatOutboundProgressMirrorText,
  normalizeOutboundProgressMode,
} from "../lib/outbound-progress.mjs";

test("normalizeOutboundProgressMode defaults to visible updates", () => {
  assert.equal(normalizeOutboundProgressMode(undefined), "updates");
  assert.equal(normalizeOutboundProgressMode("generic"), "generic");
  assert.equal(normalizeOutboundProgressMode("verbatim"), "verbatim");
});

test("formatOutboundProgressMirrorText keeps recent commentary in one progress bubble", () => {
  const turn = {};
  turn.progressItems = appendOutboundProgressItem(turn, {
    text: "Inspecting current Telegram state",
    timestamp: "2026-04-18T21:30:00.000+02:00",
  });
  turn.progressItems = appendOutboundProgressItem(turn, {
    text: "Running smoke checks",
    timestamp: "2026-04-18T21:31:00.000+02:00",
  });

  const text = formatOutboundProgressMirrorText({
    currentTurn: turn,
    config: {},
  });

  assert.match(text, /^> Inspecting current Telegram state/);
  assert.match(text, /last activity: 21:31/);
  assert.match(text, /> Inspecting current Telegram state/);
  assert.match(text, /> Running smoke checks/);
  assert.match(text, /\n\n\*\*Working\.\.\.\*\*\nlast activity: 21:31$/);
});

test("formatOutboundProgressMirrorText shows todo plan below live updates", () => {
  const turn = {
    planText: "**Todo**\n1/2 done\n1. [x] Inspect state\n2. [>] Patch mirror",
    progressItems: [
      {
        text: "Editing parser and progress bubble",
        timestamp: "2026-04-18T21:32:00.000+02:00",
      },
    ],
  };

  const text = formatOutboundProgressMirrorText({
    currentTurn: turn,
    config: {},
  });

  assert.match(text, /^> Editing parser and progress bubble/);
  assert.match(text, /2\. \[>\] Patch mirror/);
  assert.match(text, /\n\n\*\*Todo\*\*/);
  assert.match(text, /\n\n\*\*Working\.\.\.\*\*\nlast activity: 21:32$/);
});

test("formatOutboundProgressMirrorText shows changed files above progress footer", () => {
  const turn = {
    changedFilesText: "**Changed files**\n2 files changed +4 -1\n- `bridge.mjs` +3 -1\n- `README.md` +1 -0",
    progressItems: [
      {
        text: "Editing progress bubble",
        timestamp: "2026-04-18T21:33:00.000+02:00",
      },
    ],
  };

  const text = formatOutboundProgressMirrorText({
    currentTurn: turn,
    config: {},
  });

  assert.match(text, /^> Editing progress bubble/);
  assert.match(text, /\*\*Changed files\*\*/);
  assert.match(text, /- `bridge\.mjs` \+3 -1/);
  assert.match(text, /\n\n\*\*Working\.\.\.\*\*\nlast activity: 21:33$/);
});

test("formatOutboundProgressMirrorText generic mode hides commentary details", () => {
  const text = formatOutboundProgressMirrorText({
    message: {
      text: "Sensitive verbose tool detail",
      timestamp: "2026-04-18T21:31:00.000+02:00",
    },
    config: {
      outboundProgressMode: "generic",
    },
  });

  assert.equal(text, "**Working...**\nCodex is working...\nlast activity: 21:31");
});

test("formatOutboundProgressMirrorText preserves updates when completed", () => {
  const turn = {
    progressItems: [
      {
        text: "Committed docs",
        timestamp: "2026-04-18T21:32:00.000+02:00",
      },
    ],
  };

  const text = formatOutboundProgressMirrorText({
    currentTurn: turn,
    completed: true,
  });

  assert.match(text, /Done\. Final answer below\./);
  assert.match(text, /^> Committed docs/);
  assert.match(text, /\n\n\*\*Working\.\.\.\*\*\nDone\. Final answer below\.$/);
});
