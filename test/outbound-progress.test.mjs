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

  assert.match(text, /^\*\*Progress\*\*/);
  assert.match(text, /last activity: 21:31/);
  assert.match(text, /> Inspecting current Telegram state/);
  assert.match(text, /> Running smoke checks/);
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

  assert.equal(text, "**Progress**\nCodex is working...\nlast activity: 21:31");
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
  assert.match(text, /> Committed docs/);
});
