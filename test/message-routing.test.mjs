import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeInboundPrompt,
  parseCommand,
  stripLeadingBotMention,
} from "../lib/message-routing.mjs";

test("parseCommand strips bot target from commands", () => {
  assert.deepEqual(parseCommand("/health@examplebot now"), {
    command: "/health",
    args: ["now"],
  });
});

test("parseCommand maps Telegram-menu-safe aliases to canonical commands", () => {
  assert.deepEqual(parseCommand("/sync_project 4 dry-run"), {
    command: "/sync-project",
    args: ["4", "dry-run"],
  });
  assert.deepEqual(parseCommand("/project_status"), {
    command: "/project-status",
    args: [],
  });
  assert.deepEqual(parseCommand("/attach_latest"), {
    command: "/attach-latest",
    args: [],
  });
  assert.deepEqual(parseCommand("/mode_native"), {
    command: "/mode",
    args: ["native"],
  });
});

test("stripLeadingBotMention removes a leading bot mention", () => {
  assert.equal(
    stripLeadingBotMention("@examplebot проверь health", "examplebot"),
    "проверь health",
  );
});

test("normalizeInboundPrompt keeps plain text intact", () => {
  assert.equal(
    normalizeInboundPrompt("обычный текст без mention", { botUsername: "examplebot" }),
    "обычный текст без mention",
  );
});

test("normalizeInboundPrompt returns empty string for mention-only message", () => {
  assert.equal(
    normalizeInboundPrompt("@examplebot", { botUsername: "examplebot" }),
    "",
  );
});
