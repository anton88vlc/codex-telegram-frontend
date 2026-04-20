import test from "node:test";
import assert from "node:assert/strict";

import { getInitialProgressText, getProgressStepTexts } from "../lib/progress-bubble.mjs";

test("progress bubble stays honest about long waits", () => {
  const allText = [getInitialProgressText(), ...getProgressStepTexts()].join("\n");

  assert.equal(getInitialProgressText(), "Working...");
  assert.match(allText, /may recover or time out/);
  assert.match(allText, /clear transport error/);
  assert.doesNotMatch(allText, /not stuck/i);
});
