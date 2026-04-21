import test from "node:test";
import assert from "node:assert/strict";

import {
  currentFastMode,
  findModel,
  normalizeFastMode,
  normalizeReasoningEffort,
  renderFastStatus,
  renderModelStatus,
  renderReasoningStatus,
  supportedReasoningEfforts,
} from "../lib/codex-controls.mjs";

const models = [
  {
    id: "gpt-5.4",
    displayName: "gpt-5.4",
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
    ],
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
  },
];

test("normalizeReasoningEffort accepts human aliases", () => {
  assert.equal(normalizeReasoningEffort("extra high"), "xhigh");
  assert.equal(normalizeReasoningEffort("off"), "none");
  assert.equal(normalizeReasoningEffort("MED"), "medium");
  assert.equal(normalizeReasoningEffort("turbo"), null);
});

test("normalizeFastMode toggles or parses explicit state", () => {
  assert.equal(normalizeFastMode("", { current: false }), true);
  assert.equal(normalizeFastMode("", { current: true }), false);
  assert.equal(normalizeFastMode("on"), true);
  assert.equal(normalizeFastMode("standard"), false);
  assert.equal(normalizeFastMode("maybe"), null);
});

test("model and reasoning helpers render compact Telegram copy", () => {
  assert.equal(findModel(models, "GPT-5.4-Mini").id, "gpt-5.4-mini");
  assert.deepEqual(supportedReasoningEfforts(models[0]), ["low", "medium", "high", "xhigh"]);
  assert.equal(currentFastMode({ service_tier: "fast" }), true);

  assert.match(renderModelStatus({ codexConfig: { model: "gpt-5.4" }, models }), /model: `gpt-5.4`/);
  assert.match(
    renderReasoningStatus({ codexConfig: { model: "gpt-5.4", model_reasoning_effort: "high" }, models }),
    /available: `low`, `medium`, `high`, `xhigh`/,
  );
  assert.match(renderFastStatus({ codexConfig: { service_tier: null } }), /fast: `off`/);
});
