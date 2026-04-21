import test from "node:test";
import assert from "node:assert/strict";

import {
  formatOutboundAssistantMirrorText,
  formatOutboundUserMirrorText,
  isCommentaryAssistantMirrorMessage,
  isFinalAssistantMirrorMessage,
  isPlanMirrorMessage,
  makePromptPreview,
} from "../lib/outbound-mirror-messages.mjs";

test("makePromptPreview keeps compact one-line text", () => {
  assert.equal(makePromptPreview("hello\nworld"), "hello world");
  assert.equal(makePromptPreview("x".repeat(200)), `${"x".repeat(157)}...`);
});

test("formatOutboundUserMirrorText labels Codex Desktop-originated prompts", () => {
  assert.equal(
    formatOutboundUserMirrorText("Run checks", { codexUserDisplayName: "Anton" }),
    "**Anton via Codex**\n\nRun checks",
  );
  assert.equal(
    formatOutboundUserMirrorText("Run checks", { codexUserDisplayName: "Codex Desktop user" }),
    "**Codex Desktop**\n\nRun checks",
  );
  assert.equal(formatOutboundUserMirrorText(""), "");
});

test("assistant mirror classifiers separate final, commentary and plan updates", () => {
  assert.equal(isFinalAssistantMirrorMessage({ role: "assistant", phase: "final_answer" }), true);
  assert.equal(isFinalAssistantMirrorMessage({ role: "assistant" }), true);
  assert.equal(isFinalAssistantMirrorMessage({ role: "assistant", phase: "commentary" }), false);
  assert.equal(isCommentaryAssistantMirrorMessage({ role: "assistant", phase: "commentary" }), true);
  assert.equal(isPlanMirrorMessage({ role: "plan", phase: "update_plan" }), true);
});

test("formatOutboundAssistantMirrorText quotes commentary and keeps final answers plain", () => {
  assert.equal(
    formatOutboundAssistantMirrorText({
      role: "assistant",
      phase: "commentary",
      text: "Inspecting\n\nRunning tests",
    }),
    "> Inspecting\n>\n> Running tests",
  );
  assert.equal(
    formatOutboundAssistantMirrorText({
      role: "assistant",
      phase: "final_answer",
      text: "Done",
    }),
    "Done",
  );
});
