import test from "node:test";
import assert from "node:assert/strict";

import {
  getBindingRuntimeTier,
  isAppServerStreamBindingEligible,
  isHotOutboundBinding,
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

test("runtime tiers keep active and recent bindings hot without status noise", () => {
  const nowMs = Date.parse("2026-04-21T10:30:00.000Z");
  const config = {
    bindingHotMaxAgeMs: 30 * 60 * 1000,
    bindingWarmMaxAgeMs: 24 * 60 * 60 * 1000,
  };

  assert.equal(
    getBindingRuntimeTier({ currentTurn: { startedAt: "2026-04-21T10:10:00.000Z" } }, { nowMs, ...config }),
    "hot",
  );
  assert.equal(
    getBindingRuntimeTier(
      {
        currentTurn: { startedAt: "2026-04-21T08:10:00.000Z" },
        statusBarUpdatedAt: "2026-04-21T10:29:00.000Z",
      },
      { nowMs, ...config },
    ),
    "warm",
  );
  assert.equal(
    getBindingRuntimeTier({ lastMirroredAt: "2026-04-21T10:10:00.000Z" }, { nowMs, ...config }),
    "hot",
  );
  assert.equal(
    getBindingRuntimeTier({ lastMirroredAt: "2026-04-21T08:10:00.000Z" }, { nowMs, ...config }),
    "warm",
  );
  assert.equal(
    getBindingRuntimeTier({ lastMirroredAt: "2026-04-19T08:10:00.000Z" }, { nowMs, ...config }),
    "cold",
  );
});

test("app-server stream eligibility defaults to hot topics only", () => {
  const nowMs = Date.parse("2026-04-21T10:30:00.000Z");
  const stale = {
    threadId: "t1",
    chatId: "-1001",
    lastMirroredAt: "2026-04-19T08:10:00.000Z",
  };
  const hot = {
    ...stale,
    lastMirroredAt: "2026-04-21T10:20:00.000Z",
  };

  assert.equal(isHotOutboundBinding(hot, { bindingHotMaxAgeMs: 30 * 60 * 1000 }, { nowMs }), true);
  assert.equal(isAppServerStreamBindingEligible(stale, { bindingHotMaxAgeMs: 30 * 60 * 1000 }, { nowMs }), false);
  assert.equal(
    isAppServerStreamBindingEligible(stale, { appServerStreamSubscribeHotOnly: false }, { nowMs }),
    true,
  );
});
