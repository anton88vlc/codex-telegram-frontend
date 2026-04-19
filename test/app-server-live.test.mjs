import test from "node:test";
import assert from "node:assert/strict";

import { AppServerLiveStream } from "../lib/app-server-live.mjs";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static last = null;

  constructor(url) {
    this.url = url;
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
      this.serverMessage({ id: message.id, result: {} });
    }
    if (message.id && message.method === "thread/resume") {
      this.serverMessage({ id: message.id, result: { thread: { id: message.params.threadId } } });
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

test("AppServerLiveStream subscribes and queues normalized notifications", async () => {
  const statuses = [];
  const stream = new AppServerLiveStream({
    url: "ws://app-server.test",
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 100,
    onStatus(status) {
      statuses.push(status);
    },
  });

  await stream.subscribe("thread-1");
  await stream.subscribe("thread-1");
  FakeWebSocket.last.serverMessage({
    method: "item/reasoning/textDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reason-1",
      delta: "checking stream",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const events = stream.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].category, "reasoning");
  assert.equal(events[0].threadId, "thread-1");
  assert.equal(events[0].textPreview, "checking stream");
  assert.equal(statuses.at(-1).status, "connected");
  assert.equal(FakeWebSocket.last.sent.filter((message) => message.method === "thread/resume").length, 1);

  await stream.close();
});
