import test from "node:test";
import assert from "node:assert/strict";

import {
  rememberOutbound,
  rememberOutboundMirrorSuppressionForText,
} from "../lib/outbound-memory.mjs";

test("rememberOutbound stores only Telegram integer message ids", () => {
  const binding = {};

  rememberOutbound(binding, [
    { message_id: 10 },
    { message_id: "bad" },
    {},
    { message_id: 11 },
  ]);

  assert.deepEqual(binding.lastOutboundMessageIds, [10, 11]);
});

test("rememberOutbound ignores missing binding or malformed send result", () => {
  assert.equal(rememberOutbound(null, [{ message_id: 1 }]), undefined);
  const binding = { lastOutboundMessageIds: [1] };
  rememberOutbound(binding, null);
  assert.deepEqual(binding.lastOutboundMessageIds, [1]);
});

test("rememberOutboundMirrorSuppressionForText stores normalized mirror signatures", () => {
  const state = {};
  const signature = rememberOutboundMirrorSuppressionForText(
    state,
    "binding-key",
    "  hello  ",
    { role: "user", phase: null },
  );

  assert.equal(typeof signature, "string");
  assert.deepEqual(state.outboundMirrors["binding-key"].suppressions, [signature]);
  assert.equal(
    rememberOutboundMirrorSuppressionForText(state, "binding-key", "   "),
    null,
  );
});
