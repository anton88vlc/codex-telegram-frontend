import { normalizeAppServerNotification, normalizeAppServerRequest } from "./app-server-stream.mjs";

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_RECONNECT_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventErrorMessage(event) {
  return event?.error?.message || event?.message || "websocket error";
}

function rawMessageData(data) {
  return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
}

export class AppServerLiveStream {
  constructor({
    url,
    clientInfo = {
      name: "codex-telegram-frontend-live-stream",
      title: "Codex Telegram Frontend Live Stream",
      version: "0.1.0",
    },
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    reconnectMs = DEFAULT_RECONNECT_MS,
    maxQueuedEvents = 500,
    WebSocketImpl = globalThis.WebSocket,
    onEvent = null,
    onStatus = null,
  } = {}) {
    this.url = url;
    this.clientInfo = clientInfo;
    this.connectTimeoutMs = connectTimeoutMs;
    this.reconnectMs = reconnectMs;
    this.maxQueuedEvents = maxQueuedEvents;
    this.WebSocketImpl = WebSocketImpl;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.ws = null;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.nextId = 1;
    this.connected = false;
    this.connecting = null;
    this.nextReconnectAt = 0;
    this.subscribedThreadIds = new Set();
    this.queuedEvents = [];
  }

  status(payload) {
    if (typeof this.onStatus === "function") {
      this.onStatus(payload);
    }
  }

  emitEvent(event) {
    if (!event) {
      return;
    }
    this.queuedEvents.push(event);
    if (this.queuedEvents.length > this.maxQueuedEvents) {
      this.queuedEvents.splice(0, this.queuedEvents.length - this.maxQueuedEvents);
    }
    if (typeof this.onEvent === "function") {
      this.onEvent(event);
    }
  }

  drainEvents() {
    const events = this.queuedEvents;
    this.queuedEvents = [];
    return events;
  }

  async subscribe(threadId) {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) {
      return false;
    }
    const alreadySubscribed = this.subscribedThreadIds.has(normalizedThreadId);
    const shouldResumeAfterConnect = this.connected && this.ws?.readyState === this.WebSocketImpl.OPEN && !alreadySubscribed;
    this.subscribedThreadIds.add(normalizedThreadId);
    await this.ensureConnected();
    if (!shouldResumeAfterConnect) {
      return true;
    }
    await this.request("thread/resume", { threadId: normalizedThreadId });
    return true;
  }

  async ensureConnected() {
    if (this.connected && this.ws?.readyState === this.WebSocketImpl.OPEN) {
      return true;
    }
    if (this.connecting) {
      return this.connecting;
    }
    const now = Date.now();
    if (this.nextReconnectAt > now) {
      throw new Error(`app-server stream reconnect cooling down for ${this.nextReconnectAt - now}ms`);
    }
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async connect() {
    if (!this.WebSocketImpl) {
      throw new Error("global WebSocket is not available");
    }
    this.closeSocketOnly();
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.addEventListener("message", (event) => this.handleMessage(event));
    ws.addEventListener("error", (event) => this.handleDisconnect(ws, eventErrorMessage(event)));
    ws.addEventListener("close", (event) =>
      this.handleDisconnect(ws, `websocket closed: ${event.code}${event.reason ? ` ${event.reason}` : ""}`),
    );
    await this.waitForOpen(ws);
    this.connected = true;
    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    });
    this.send({ method: "initialized", params: {} });
    for (const threadId of this.subscribedThreadIds) {
      await this.request("thread/resume", { threadId });
    }
    this.status({ status: "connected", url: this.url, subscribedThreads: this.subscribedThreadIds.size });
    return true;
  }

  waitForOpen(ws) {
    return new Promise((resolve, reject) => {
      if (ws.readyState === this.WebSocketImpl.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`timeout connecting to ${this.url}`));
      }, this.connectTimeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        (event) => {
          clearTimeout(timer);
          reject(new Error(eventErrorMessage(event)));
        },
        { once: true },
      );
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server stream request timed out: ${method}`));
      }, this.connectTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  respondUnsupported(id, method) {
    this.send({
      id,
      error: {
        code: -32000,
        message: `codex-telegram-frontend live stream does not handle server request: ${method}`,
      },
    });
  }

  hasServerRequest(id) {
    return this.serverRequests.has(String(id));
  }

  respondToServerRequest(id, result) {
    const key = String(id);
    const request = this.serverRequests.get(key);
    if (!request) {
      return false;
    }
    this.send({
      id: request.id,
      result,
    });
    this.serverRequests.delete(key);
    return true;
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(rawMessageData(event.data));
    } catch {
      return;
    }

    if (
      message.id != null &&
      this.pending.has(message.id) &&
      (Object.prototype.hasOwnProperty.call(message, "result") || message.error)
    ) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (Object.prototype.hasOwnProperty.call(message, "result")) {
        waiter.resolve(message.result);
      } else {
        waiter.reject(new Error(JSON.stringify(message.error)));
      }
      return;
    }

    if (message.id != null && message.method) {
      const request = normalizeAppServerRequest(message, { ts: new Date().toISOString() });
      if (request) {
        this.serverRequests.set(String(message.id), message);
        this.emitEvent(request);
        return;
      }
      this.respondUnsupported(message.id, message.method);
      return;
    }

    const normalized = normalizeAppServerNotification(message, { ts: new Date().toISOString() });
    this.emitEvent(normalized);
  }

  handleDisconnect(ws, error) {
    if (!this.ws || this.ws !== ws) {
      return;
    }
    this.connected = false;
    this.nextReconnectAt = Date.now() + this.reconnectMs;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(error));
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.status({ status: "disconnected", url: this.url, error });
  }

  closeSocketOnly() {
    if (!this.ws) {
      return;
    }
    try {
      this.ws.close();
    } catch {}
    this.ws = null;
    this.connected = false;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
    }
    this.pending.clear();
    this.serverRequests.clear();
  }

  async close() {
    this.closeSocketOnly();
    await sleep(0);
  }
}
