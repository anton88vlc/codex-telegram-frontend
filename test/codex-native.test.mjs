import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NativeTransportError, sendNativeTurn } from "../lib/codex-native.mjs";

async function writeHelper(dir, name, source) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, source, "utf8");
  return filePath;
}

test("sendNativeTurn returns degraded result when app-control fails and fallback succeeds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  const primary = await writeHelper(
    dir,
    "primary.js",
    'console.log(JSON.stringify({ ok: false, error: "failed to query http://127.0.0.1:9222/json/list: fetch failed" })); process.exit(1);\n',
  );
  const fallback = await writeHelper(
    dir,
    "fallback.js",
    'console.log(JSON.stringify({ ok: true, reply: { text: "Fallback reply" } }));\n',
  );

  const result = await sendNativeTurn({
    helperPath: primary,
    fallbackHelperPath: fallback,
    threadId: "thread-1",
    prompt: "hello",
    timeoutMs: 1000,
  });

  assert.equal(result.transportPath, "app-server-fallback");
  assert.equal(result.reply.text, "Fallback reply");
  assert.match(result.primaryError, /fetch failed/);
});

test("sendNativeTurn throws classified error when app-control and fallback both fail", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  const primary = await writeHelper(
    dir,
    "primary.js",
    'console.log(JSON.stringify({ ok: false, error: "no page targets found" })); process.exit(1);\n',
  );
  const fallback = await writeHelper(
    dir,
    "fallback.js",
    'console.log(JSON.stringify({ ok: false, error: "websocket closed early" })); process.exit(1);\n',
  );

  await assert.rejects(
    sendNativeTurn({
      helperPath: primary,
      fallbackHelperPath: fallback,
      threadId: "thread-1",
      prompt: "hello",
      timeoutMs: 1000,
    }),
    (error) => {
      assert.ok(error instanceof NativeTransportError);
      assert.equal(error.kind, "fallback_failed");
      assert.equal(error.attempts.length, 2);
      assert.match(error.message, /app-control failed and app-server fallback failed/);
      return true;
    },
  );
});

test("sendNativeTurn can skip app-control and use app-server first", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  const primary = await writeHelper(
    dir,
    "primary.js",
    "throw new Error('primary helper should not run');\n",
  );
  const fallback = await writeHelper(
    dir,
    "fallback.js",
    'console.log(JSON.stringify({ ok: true, reply: { text: "Fallback-first reply" } }));\n',
  );

  const result = await sendNativeTurn({
    helperPath: primary,
    fallbackHelperPath: fallback,
    threadId: "thread-1",
    prompt: "hello",
    timeoutMs: 1000,
    preferAppServer: true,
    appControlSkipReason: "configured app-server-first ingress",
  });

  assert.equal(result.transportPath, "app-server-fallback");
  assert.equal(result.reply.text, "Fallback-first reply");
  assert.equal(result.primaryError, "configured app-server-first ingress");
});

test("sendNativeTurn reports app-server-first failure without app-control attempt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  const primary = await writeHelper(
    dir,
    "primary.js",
    "throw new Error('primary helper should not run');\n",
  );
  const fallback = await writeHelper(
    dir,
    "fallback.js",
    "throw new Error('app server down');\n",
  );

  await assert.rejects(
    sendNativeTurn({
      helperPath: primary,
      fallbackHelperPath: fallback,
      threadId: "thread-1",
      prompt: "hello",
      timeoutMs: 1000,
      preferAppServer: true,
      appControlSkipReason: "configured app-server-first ingress",
    }),
    (error) => {
      assert.ok(error instanceof NativeTransportError);
      assert.equal(error.kind, "app_server_failed");
      assert.equal(error.attempts.length, 1);
      assert.equal(error.attempts[0].path, "app-server-fallback");
      assert.match(error.message, /app-server ingress failed/);
      return true;
    },
  );
});
