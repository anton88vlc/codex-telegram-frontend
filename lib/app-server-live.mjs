import { AppServerProtocolClient } from "./app-server-client.mjs";
import { normalizeAppServerNotification, normalizeAppServerRequest } from "./app-server-stream.mjs";

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_RECONNECT_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    requestTimeoutMs = connectTimeoutMs,
    reconnectMs = DEFAULT_RECONNECT_MS,
    maxQueuedEvents = 500,
    WebSocketImpl = globalThis.WebSocket,
    onEvent = null,
    onStatus = null,
    ...transportOptions
  } = {}) {
    this.url = url;
    this.clientInfo = clientInfo;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectMs = reconnectMs;
    this.maxQueuedEvents = maxQueuedEvents;
    this.WebSocketImpl = WebSocketImpl;
    this.transportOptions = transportOptions;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.client = null;
    this.connected = false;
    this.connecting = null;
    this.nextReconnectAt = 0;
    this.subscribedThreadIds = new Set();
    this.subscriptionFailures = new Map();
    this.subscriptionRetryAfter = new Map();
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
    const retryAfter = this.subscriptionRetryAfter.get(normalizedThreadId) || 0;
    const now = Date.now();
    if (retryAfter > now) {
      return false;
    }
    await this.ensureConnected();
    if (this.subscribedThreadIds.has(normalizedThreadId)) {
      return true;
    }
    try {
      await this.request("thread/resume", { threadId: normalizedThreadId });
    } catch (error) {
      const failures = (this.subscriptionFailures.get(normalizedThreadId) || 0) + 1;
      const retryDelayMs = Math.min(this.reconnectMs * 2 ** Math.max(0, failures - 1), 60_000);
      this.subscriptionFailures.set(normalizedThreadId, failures);
      this.subscriptionRetryAfter.set(normalizedThreadId, Date.now() + retryDelayMs);
      this.status({
        status: "subscribe_failed",
        url: this.url,
        threadId: normalizedThreadId,
        failures,
        retryDelayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.subscribedThreadIds.add(normalizedThreadId);
    this.subscriptionFailures.delete(normalizedThreadId);
    this.subscriptionRetryAfter.delete(normalizedThreadId);
    this.status({ status: "subscribed", url: this.url, threadId: normalizedThreadId });
    return true;
  }

  isSubscribed(threadId) {
    const normalizedThreadId = String(threadId || "").trim();
    return Boolean(normalizedThreadId && this.subscribedThreadIds.has(normalizedThreadId));
  }

  isSubscribeCoolingDown(threadId, nowMs = Date.now()) {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) {
      return false;
    }
    return (this.subscriptionRetryAfter.get(normalizedThreadId) || 0) > nowMs;
  }

  async ensureConnected() {
    if (this.connected && this.client) {
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
    this.closeSocketOnly();
    this.client = new AppServerProtocolClient({
      url: this.url,
      ...this.transportOptions,
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
      },
      connectTimeoutMs: this.connectTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      maxQueuedNotifications: this.maxQueuedEvents,
      WebSocketImpl: this.WebSocketImpl,
      onNotification: (message) => {
        const normalized = normalizeAppServerNotification(message, { ts: new Date().toISOString() });
        this.emitEvent(normalized);
      },
      onServerRequest: (message) => {
        const request = normalizeAppServerRequest(message, { ts: new Date().toISOString() });
        if (request) {
          this.emitEvent(request);
          return;
        }
        this.client.rejectServerRequest(message.id, {
          code: -32000,
          message: `codex-telegram-frontend live stream does not handle server request: ${message.method}`,
        });
      },
      onStatus: (payload) => {
        if (payload?.status === "disconnected") {
          this.connected = false;
          this.subscribedThreadIds.clear();
          this.nextReconnectAt = Date.now() + this.reconnectMs;
          this.status({ status: "disconnected", url: this.url, error: payload.error });
        }
      },
    });
    await this.client.connect();
    this.connected = true;
    this.status({ status: "connected", url: this.url, subscribedThreads: this.subscribedThreadIds.size });
    return true;
  }

  request(method, params, options = {}) {
    return this.client.request(method, params, {
      timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
    });
  }

  hasServerRequest(id) {
    return this.client?.hasServerRequest(id) || false;
  }

  respondToServerRequest(id, result) {
    return this.client?.respondToServerRequest(id, result) || false;
  }

  closeSocketOnly() {
    if (!this.client) {
      return;
    }
    this.client.closeTransportOnly();
    this.client = null;
    this.connected = false;
    this.subscribedThreadIds.clear();
  }

  async close() {
    await this.client?.close();
    this.client = null;
    this.connected = false;
    this.subscribedThreadIds.clear();
    await sleep(0);
  }
}
