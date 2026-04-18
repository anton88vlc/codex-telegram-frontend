import test from "node:test";
import assert from "node:assert/strict";

import { getBindingsForChat, getBoundThreadIdsForChat } from "../lib/project-data.mjs";

test("project-data ignores parked sync bindings by default", () => {
  const state = {
    bindings: {
      active: {
        chatId: "-1001",
        messageThreadId: 3,
        threadId: "t-active",
      },
      parked: {
        chatId: "-1001",
        messageThreadId: 4,
        threadId: "t-parked",
        createdBy: "sync-project",
        syncManaged: true,
        syncState: "closed",
      },
      otherChat: {
        chatId: "-1002",
        messageThreadId: 5,
        threadId: "t-other",
      },
    },
  };

  assert.deepEqual(Array.from(getBoundThreadIdsForChat(state, "-1001")), ["t-active"]);
  assert.deepEqual(
    Array.from(getBoundThreadIdsForChat(state, "-1001", { includeInactive: true })).sort(),
    ["t-active", "t-parked"],
  );
  assert.equal(getBindingsForChat(state, "-1001", { includeInactive: false }).length, 1);
  assert.equal(getBindingsForChat(state, "-1001").length, 2);
});
