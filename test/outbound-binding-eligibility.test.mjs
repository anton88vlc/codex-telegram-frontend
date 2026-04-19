import test from "node:test";
import assert from "node:assert/strict";

import {
  isOutboundMirrorBindingEligible,
  isStatusBarBindingEligible,
} from "../lib/outbound-binding-eligibility.mjs";

test("isOutboundMirrorBindingEligible accepts active native Telegram bindings", () => {
  assert.equal(isOutboundMirrorBindingEligible({ threadId: "t1", chatId: "-1001", transport: "native" }), true);
  assert.equal(isOutboundMirrorBindingEligible({ threadId: "t1", chatId: "-1001" }), true);
});

test("isOutboundMirrorBindingEligible rejects incomplete, non-native and closed sync bindings", () => {
  assert.equal(isOutboundMirrorBindingEligible({ chatId: "-1001" }), false);
  assert.equal(isOutboundMirrorBindingEligible({ threadId: "t1" }), false);
  assert.equal(isOutboundMirrorBindingEligible({ threadId: "t1", chatId: "-1001", transport: "legacy" }), false);
  assert.equal(
    isOutboundMirrorBindingEligible({
      threadId: "t1",
      chatId: "-1001",
      syncManaged: true,
      syncState: "closed",
    }),
    false,
  );
});

test("isStatusBarBindingEligible requires a topic binding", () => {
  assert.equal(isStatusBarBindingEligible({ threadId: "t1", chatId: "-1001", messageThreadId: 42 }), true);
  assert.equal(isStatusBarBindingEligible({ threadId: "t1", chatId: "-1001", messageThreadId: null }), false);
});
