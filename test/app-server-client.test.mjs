import test from "node:test";
import assert from "node:assert/strict";

import {
  AppServerProtocolClient,
  AppServerProtocolError,
  inferAppServerTransport,
  isAppServerOverloadError,
  isLoopbackAppServerUrl,
} from "../lib/app-server-client.mjs";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static last = null;

  constructor(url, protocols = undefined) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.last = this;
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    }, 0);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.id && message.method === "initialize") {
      this.serverMessage({
        id: message.id,
        result: {
          protocolVersion: 3,
          supportedMethods: ["thread/read", "turn/start", "thread/turns/list"],
        },
      });
    }
    if (message.id && message.method === "thread/read") {
      this.serverMessage({ id: message.id, result: { thread: { id: message.params.threadId } } });
    }
    if (message.id && message.method === "overloaded") {
      this.serverMessage({ id: message.id, error: { code: -32001, message: "server overloaded" } });
    }
  }

  serverMessage(message) {
    setTimeout(() => {
      this.emit("message", { data: JSON.stringify(message) });
    }, 0);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1000, reason: "" });
  }
}

test("transport inference keeps local app-server boundaries explicit", () => {
  assert.equal(inferAppServerTransport({ url: "stdio://" }), "stdio");
  assert.equal(inferAppServerTransport({ command: "codex" }), "stdio");
  assert.equal(inferAppServerTransport({ url: "unix:///tmp/codex.sock" }), "unix");
  assert.equal(inferAppServerTransport({ socketPath: "/tmp/codex.sock" }), "unix");
  assert.equal(inferAppServerTransport({ url: "ws://127.0.0.1:27890" }), "websocket");
  assert.equal(isLoopbackAppServerUrl("ws://127.0.0.1:27890"), true);
  assert.equal(isLoopbackAppServerUrl("ws://localhost:27890"), true);
  assert.equal(isLoopbackAppServerUrl("ws://192.168.1.50:27890"), false);
});

test("AppServerProtocolClient initializes, sends initialized, and resolves requests", async () => {
  const notifications = [];
  const statuses = [];
  const client = new AppServerProtocolClient({
    url: "ws://127.0.0.1:27890",
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 100,
    requestTimeoutMs: 100,
    onNotification(message) {
      notifications.push(message);
    },
    onStatus(status) {
      statuses.push(status);
    },
  });

  await client.connect();
  const read = await client.request("thread/read", { threadId: "thread-1" });
  FakeWebSocket.last.serverMessage({ method: "item/agentMessage/delta", params: { delta: "hello" } });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(read, { thread: { id: "thread-1" } });
  assert.equal(FakeWebSocket.last.sent[0].method, "initialize");
  assert.equal(FakeWebSocket.last.sent[1].method, "initialized");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "item/agentMessage/delta");
  assert.equal(client.drainNotifications().length, 1);
  assert.equal(statuses.some((status) => status.status === "connected"), true);

  await client.close();
});

test("AppServerProtocolClient stores server requests and responds later", async () => {
  const requests = [];
  const client = new AppServerProtocolClient({
    url: "ws://127.0.0.1:27890",
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 100,
    requestTimeoutMs: 100,
    onServerRequest(message) {
      requests.push(message);
    },
  });

  await client.connect();
  FakeWebSocket.last.serverMessage({
    id: 77,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(requests.length, 1);
  assert.equal(client.hasServerRequest("77"), true);
  assert.equal(client.respondToServerRequest("77", { decision: "accept" }), true);
  assert.deepEqual(FakeWebSocket.last.sent.at(-1), { id: 77, result: { decision: "accept" } });
  assert.equal(client.hasServerRequest("77"), false);

  await client.close();
});

test("AppServerProtocolClient classifies protocol errors and overload", async () => {
  const client = new AppServerProtocolClient({
    url: "ws://127.0.0.1:27890",
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 100,
    requestTimeoutMs: 100,
  });

  await client.connect();
  await assert.rejects(
    client.request("overloaded", {}),
    (error) => {
      assert.equal(error instanceof AppServerProtocolError, true);
      assert.equal(isAppServerOverloadError(error), true);
      assert.equal(error.method, "overloaded");
      return true;
    },
  );

  await client.close();
});

test("AppServerProtocolClient makes drift-prone methods opt-in unless announced", async () => {
  const client = new AppServerProtocolClient({
    url: "ws://127.0.0.1:27890",
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 100,
  });

  assert.equal(client.supportsMethod("thread/read"), true);
  assert.equal(client.supportsMethod("thread/turns/list"), false);

  await client.connect();
  assert.equal(client.supportsMethod("thread/read"), true);
  assert.equal(client.supportsMethod("thread/turns/list"), true);

  await client.close();
});

test("AppServerProtocolClient rejects non-loopback websocket without auth token", async () => {
  const client = new AppServerProtocolClient({
    url: "ws://192.168.1.50:27890",
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 100,
  });

  await assert.rejects(client.connect(), /requires an auth token/);
});

