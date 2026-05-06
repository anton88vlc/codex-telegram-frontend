import test from "node:test";
import assert from "node:assert/strict";

import { makeAppServerStreamClientFactory } from "../lib/app-server-borrowed-client.mjs";

test("borrowed app-server clients use the persistent stream and do not close it", async () => {
  const calls = [];
  const stream = {
    ensureConnected: async () => calls.push(["connect"]),
    request: async (method, params, options) => {
      calls.push(["request", method, params, options]);
      return { ok: true };
    },
    close: async () => calls.push(["close"]),
  };

  const factory = makeAppServerStreamClientFactory(stream);
  const client = factory();
  await client.connect();
  assert.deepEqual(await client.request("turn/start", { threadId: "thread-1" }, { timeoutMs: 1000 }), { ok: true });
  await client.close();

  assert.deepEqual(calls, [
    ["connect"],
    ["request", "turn/start", { threadId: "thread-1" }, { timeoutMs: 1000 }],
  ]);
});
