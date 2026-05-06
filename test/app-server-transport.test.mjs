import test from "node:test";
import assert from "node:assert/strict";

import {
  appServerClientOptions,
  appServerTransportLabel,
  hasAppServerTransport,
  normalizeAppServerTransport,
} from "../lib/app-server-transport.mjs";

test("app-server transport resolver keeps empty config disabled for tests and helpers", () => {
  assert.equal(hasAppServerTransport({}), false);
  assert.equal(normalizeAppServerTransport("auto", { url: "ws://127.0.0.1:27890" }), "websocket");
});

test("app-server transport resolver builds stdio options for current Codex Desktop", () => {
  const config = {
    appServerTransport: "stdio",
    appServerCommand: "/Applications/Codex.app/Contents/Resources/codex",
    appServerArgs: ["app-server"],
    appServerCwd: "/tmp",
  };

  assert.equal(hasAppServerTransport(config), true);
  assert.equal(appServerTransportLabel(config), "/Applications/Codex.app/Contents/Resources/codex app-server");
  assert.deepEqual(appServerClientOptions(config), {
    transport: "stdio",
    command: "/Applications/Codex.app/Contents/Resources/codex",
    args: ["app-server"],
    cwd: "/tmp",
    env: {},
  });
});

test("app-server transport resolver keeps legacy websocket explicit", () => {
  const config = {
    appServerTransport: "websocket",
    appServerUrl: "ws://127.0.0.1:27890",
  };

  assert.equal(appServerTransportLabel(config), "ws://127.0.0.1:27890");
  assert.deepEqual(appServerClientOptions(config), {
    transport: "websocket",
    url: "ws://127.0.0.1:27890",
  });
});
