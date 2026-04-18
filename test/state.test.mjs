import test from "node:test";
import assert from "node:assert/strict";

import { mergeState, removeBinding, setBinding } from "../lib/state.mjs";

test("mergeState preserves externally added bootstrap bindings", () => {
  const bridgeState = {
    version: 1,
    lastUpdateId: 10,
    bindings: {
      "group:-1001:topic:3": {
        threadId: "old",
        chatId: "-1001",
        messageThreadId: 3,
        updatedAt: "2026-04-18T20:00:00.000Z",
      },
    },
    bindingTombstones: {},
    processedMessageKeys: ["a"],
    outboundMirrors: {},
  };
  const persistedState = {
    version: 1,
    lastUpdateId: 11,
    bindings: {
      "group:-1002:topic:3": {
        threadId: "new",
        chatId: "-1002",
        messageThreadId: 3,
        updatedAt: "2026-04-18T20:01:00.000Z",
      },
    },
    processedMessageKeys: ["b"],
    outboundMirrors: {},
  };

  mergeState(bridgeState, persistedState);

  assert.equal(bridgeState.lastUpdateId, 11);
  assert.equal(bridgeState.bindings["group:-1001:topic:3"].threadId, "old");
  assert.equal(bridgeState.bindings["group:-1002:topic:3"].threadId, "new");
  assert.deepEqual(bridgeState.processedMessageKeys, ["b", "a"]);
});

test("mergeState does not resurrect detached bindings", () => {
  const bridgeState = {
    version: 1,
    lastUpdateId: 0,
    bindings: {},
    bindingTombstones: {
      "group:-1001:topic:3": "2026-04-18T20:05:00.000Z",
    },
    processedMessageKeys: [],
    outboundMirrors: {},
  };
  const persistedState = {
    version: 1,
    lastUpdateId: 0,
    bindings: {
      "group:-1001:topic:3": {
        threadId: "old",
        updatedAt: "2026-04-18T20:00:00.000Z",
      },
    },
    outboundMirrors: {
      "group:-1001:topic:3": {
        initialized: true,
      },
    },
  };

  mergeState(bridgeState, persistedState);

  assert.equal(bridgeState.bindings["group:-1001:topic:3"], undefined);
  assert.equal(bridgeState.outboundMirrors["group:-1001:topic:3"], undefined);
});

test("setBinding clears a tombstone after a fresh attach", () => {
  const state = {
    bindings: {},
    bindingTombstones: {
      "group:-1001:topic:3": "2026-04-18T20:05:00.000Z",
    },
  };

  setBinding(state, "group:-1001:topic:3", { threadId: "new" });

  assert.equal(state.bindings["group:-1001:topic:3"].threadId, "new");
  assert.equal(state.bindingTombstones["group:-1001:topic:3"], undefined);
});

test("mergeState lets current binding explicitly clear currentTurn", () => {
  const bridgeState = {
    version: 1,
    lastUpdateId: 0,
    bindings: {
      "group:-1001:topic:3": {
        threadId: "thread-1",
        currentTurn: null,
      },
    },
    bindingTombstones: {},
    processedMessageKeys: [],
    outboundMirrors: {},
  };
  const persistedState = {
    version: 1,
    lastUpdateId: 0,
    bindings: {
      "group:-1001:topic:3": {
        threadId: "thread-1",
        currentTurn: {
          source: "telegram",
          startedAt: "2026-04-18T22:48:44.349Z",
        },
      },
    },
    processedMessageKeys: [],
    outboundMirrors: {},
  };

  mergeState(bridgeState, persistedState);

  assert.equal(bridgeState.bindings["group:-1001:topic:3"].currentTurn, null);
});

test("removeBinding records a tombstone", () => {
  const state = {
    bindings: {
      "group:-1001:topic:3": { threadId: "old" },
    },
    bindingTombstones: {},
  };

  removeBinding(state, "group:-1001:topic:3");

  assert.equal(state.bindings["group:-1001:topic:3"], undefined);
  assert.match(state.bindingTombstones["group:-1001:topic:3"], /^20/);
});
