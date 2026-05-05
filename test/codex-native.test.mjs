import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  NativeTransportError,
  createNativeChat,
  sendNativeTurn,
  sendTurnViaAppServer,
} from "../lib/codex-native.mjs";

async function writeHelper(dir, name, source) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, source, "utf8");
  return filePath;
}

function makeFakeAppServerFactory({ fail = null, emitFinal = false } = {}) {
  const calls = [];
  const factory = (options) => ({
    async connect() {
      calls.push({ method: "connect", params: { url: options.url } });
      if (fail === "connect") {
        throw new Error("app-server down");
      }
    },
    async request(method, params) {
      calls.push({ method, params });
      if (fail === method) {
        throw new Error(`${method} rejected`);
      }
      if (method === "thread/resume") {
        return {
          thread: {
            id: params.threadId,
            status: "active",
            name: "Thread",
            cwd: "/tmp/project",
          },
        };
      }
      if (method === "turn/start") {
        if (emitFinal) {
          setTimeout(() => {
            options.onNotification({
              method: "turn/started",
              params: {
                threadId: params.threadId,
                turn: { id: "turn-1" },
              },
            });
            options.onNotification({
              method: "item/completed",
              params: {
                threadId: params.threadId,
                turnId: "turn-1",
                item: {
                  id: "item-1",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "Final reply",
                },
              },
            });
            options.onNotification({
              method: "turn/completed",
              params: {
                threadId: params.threadId,
                turn: { id: "turn-1" },
              },
            });
          }, 0);
        }
        return { turn: { id: "turn-1" } };
      }
      return {};
    },
    async close() {
      calls.push({ method: "close", params: {} });
    },
  });
  return { calls, factory };
}

test("sendTurnViaAppServer sends thread/resume and turn/start through the protocol client", async () => {
  const appServer = makeFakeAppServerFactory();

  const result = await sendTurnViaAppServer({
    threadId: "thread-1",
    prompt: "hello",
    appServerUrl: "ws://127.0.0.1:27890",
    timeoutMs: 1000,
    clientFactory: appServer.factory,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "native-send-only");
  assert.equal(result.transport, "app-server");
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.thread.cwd, "/tmp/project");
  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["connect", "thread/resume", "turn/start", "close"],
  );
  assert.deepEqual(appServer.calls.find((call) => call.method === "turn/start").params.input, [
    {
      type: "text",
      text: "hello",
      text_elements: [],
    },
  ]);
});

test("sendTurnViaAppServer can wait for a final reply from app-server notifications", async () => {
  const appServer = makeFakeAppServerFactory({ emitFinal: true });

  const result = await sendTurnViaAppServer({
    threadId: "thread-1",
    prompt: "hello",
    appServerUrl: "ws://127.0.0.1:27890",
    timeoutMs: 1000,
    waitForReply: true,
    clientFactory: appServer.factory,
  });

  assert.equal(result.mode, "native-send-and-wait-for-reply");
  assert.equal(result.reply.text, "Final reply");
  assert.equal(result.turn.id, "turn-1");
});

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

test("sendNativeTurn falls back when app-control debug route does not mount", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  const primary = await writeHelper(
    dir,
    "primary.js",
    'console.log(JSON.stringify({ ok: false, error: "Error: debug route did not mount in time" })); process.exit(1);\n',
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
  assert.match(result.primaryError, /debug route did not mount/);
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

test("sendNativeTurn uses the app-server protocol client when app-server is preferred", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  const primary = await writeHelper(
    dir,
    "primary.js",
    "throw new Error('primary helper should not run');\n",
  );
  const appServer = makeFakeAppServerFactory();

  const result = await sendNativeTurn({
    helperPath: primary,
    fallbackHelperPath: null,
    threadId: "thread-1",
    prompt: "hello",
    timeoutMs: 1000,
    appServerUrl: "ws://127.0.0.1:27890",
    preferAppServer: true,
    appControlSkipReason: "configured app-server-first ingress",
    appServerClientFactory: appServer.factory,
  });

  assert.equal(result.transportPath, "app-server");
  assert.equal(result.helperPath, null);
  assert.equal(result.primaryError, "configured app-server-first ingress");
  assert.equal(appServer.calls.some((call) => call.method === "turn/start"), true);
});

test("sendNativeTurn can use app-control send-only without wait flag", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  const argsPath = path.join(dir, "args.json");
  const primary = await writeHelper(
    dir,
    "primary.js",
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ ok: true, mode: "app-control-send-only", reply: null }));
`,
  );

  const result = await sendNativeTurn({
    helperPath: primary,
    threadId: "thread-1",
    prompt: "hello",
    timeoutMs: 1000,
    waitForReply: false,
    appControlShowThread: true,
  });
  const args = JSON.parse(await fs.readFile(argsPath, "utf8"));

  assert.equal(result.transportPath, "app-control");
  assert.equal(result.mode, "app-control-send-only");
  assert.equal(args.includes("--wait-for-reply"), false);
  assert.equal(args.includes("--show-thread"), true);
});

test("sendNativeTurn defaults to app-control send-only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  const argsPath = path.join(dir, "args.json");
  const primary = await writeHelper(
    dir,
    "primary.js",
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ ok: true, mode: "app-control-send-only", reply: null }));
`,
  );

  const result = await sendNativeTurn({
    helperPath: primary,
    threadId: "thread-1",
    prompt: "hello",
    timeoutMs: 1000,
  });
  const args = JSON.parse(await fs.readFile(argsPath, "utf8"));

  assert.equal(result.transportPath, "app-control");
  assert.equal(result.mode, "app-control-send-only");
  assert.equal(args.includes("--wait-for-reply"), false);
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

test("sendNativeTurn can fall back to direct app-server protocol without the legacy helper", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-"));
  const primary = await writeHelper(
    dir,
    "primary.js",
    'console.log(JSON.stringify({ ok: false, error: "no page targets found" })); process.exit(1);\n',
  );
  const appServer = makeFakeAppServerFactory();

  const result = await sendNativeTurn({
    helperPath: primary,
    fallbackHelperPath: null,
    threadId: "thread-1",
    prompt: "hello",
    timeoutMs: 1000,
    appServerUrl: "ws://127.0.0.1:27890",
    appServerClientFactory: appServer.factory,
  });

  assert.equal(result.transportPath, "app-server-fallback");
  assert.match(result.primaryError, /no page targets found/);
  assert.equal(appServer.calls.some((call) => call.method === "turn/start"), true);
});

test("createNativeChat starts a Codex Chat from the user home cwd by default", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-chat-"));
  const argsPath = path.join(dir, "args.json");
  const helper = await writeHelper(
    dir,
    "start.js",
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ ok: true, mode: "chat-start-only", threadId: "thread-new", thread: { id: "thread-new", name: "Lab chat" } }));
`,
  );

  const result = await createNativeChat({
    helperPath: helper,
    title: "Lab chat",
    cwd: null,
    timeoutMs: 1000,
    appServerUrl: "ws://127.0.0.1:27890",
  });
  const args = JSON.parse(await fs.readFile(argsPath, "utf8"));

  assert.equal(result.transportPath, "app-server-thread-start");
  assert.equal(result.threadId, "thread-new");
  assert.deepEqual(args.slice(0, 6), ["--title", "Lab chat", "--timeout-ms", "1000", "--url", "ws://127.0.0.1:27890"]);
  assert.equal(args.includes("--cwd"), true);
  assert.equal(args[args.indexOf("--cwd") + 1], os.homedir());
});

test("createNativeChat can start a new chat with the first prompt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-chat-"));
  const argsPath = path.join(dir, "args.json");
  const helper = await writeHelper(
    dir,
    "start.js",
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ ok: true, mode: "chat-start-and-send-only", threadId: "thread-new" }));
`,
  );

  const result = await createNativeChat({
    helperPath: helper,
    title: "Fresh idea",
    cwd: "/tmp/project",
    prompt: "start from Telegram",
    timeoutMs: 1000,
  });
  const args = JSON.parse(await fs.readFile(argsPath, "utf8"));

  assert.equal(result.transportPath, "app-server-thread-start");
  assert.equal(result.mode, "chat-start-and-send-only");
  assert.equal(args[args.indexOf("--title") + 1], "Fresh idea");
  assert.equal(args[args.indexOf("--cwd") + 1], "/tmp/project");
  assert.equal(args[args.indexOf("--prompt") + 1], "start from Telegram");
});

test("createNativeChat reports app-server thread start failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-chat-"));
  const helper = await writeHelper(
    dir,
    "start.js",
    'console.log(JSON.stringify({ ok: false, error: "thread/start rejected" })); process.exit(1);\n',
  );

  await assert.rejects(
    createNativeChat({
      helperPath: helper,
      title: "Lab chat",
      timeoutMs: 1000,
    }),
    (error) => {
      assert.ok(error instanceof NativeTransportError);
      assert.equal(error.kind, "app_server_chat_start_failed");
      assert.equal(error.attempts[0].path, "app-server-thread-start");
      assert.match(error.message, /thread\/start rejected/);
      return true;
    },
  );
});
