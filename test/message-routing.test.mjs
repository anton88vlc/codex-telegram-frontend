import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeInboundPrompt,
  parseCommand,
  stripLeadingBotMention,
} from "../lib/message-routing.mjs";

test("parseCommand strips bot target from commands", () => {
  assert.deepEqual(parseCommand("/health@cdxanton2026bot now"), {
    command: "/health",
    args: ["now"],
  });
});

test("stripLeadingBotMention removes a leading bot mention", () => {
  assert.equal(
    stripLeadingBotMention("@cdxanton2026bot проверь health", "cdxanton2026bot"),
    "проверь health",
  );
});

test("normalizeInboundPrompt keeps plain text intact", () => {
  assert.equal(
    normalizeInboundPrompt("обычный текст без mention", { botUsername: "cdxanton2026bot" }),
    "обычный текст без mention",
  );
});

test("normalizeInboundPrompt returns empty string for mention-only message", () => {
  assert.equal(
    normalizeInboundPrompt("@cdxanton2026bot", { botUsername: "cdxanton2026bot" }),
    "",
  );
});
