import { spawn } from "node:child_process";
import net from "node:net";

const DEFAULT_CLIENT_INFO = {
  name: "codex-telegram-frontend",
  title: "Codex Telegram Frontend",
  version: "0.1.0",
};
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const OVERLOAD_ERROR_CODE = -32001;

const CORE_METHODS = new Set([
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/list",
  "thread/read",
  "thread/inject_items",
  "thread/compact/start",
  "thread/fork",
  "thread/archive",
  "thread/unarchive",
  "thread/name/set",
  "thread/metadata/update",
  "thread/rollback",
  "thread/shellCommand",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "config/read",
  "config/batchWrite",
  "model/list",
]);

const DRIFTY_METHODS = new Set([
  // This showed schema/docs drift across 0.128 -> 0.129 alpha. Use only after
  // feature detection or an explicit override.
  "thread/turns/list",
]);

function noop() {}

function rawMessageData(data) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function eventErrorMessage(event) {
  return event?.error?.message || event?.message || "transport error";
}

function parseJsonLine(line) {
  const text = String(line || "").trim();
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

function normalizeUrl(value) {
  return String(value || "").trim();
}

export function isLoopbackAppServerUrl(url) {
  const text = normalizeUrl(url);
  if (!text) {
    return false;
  }
  try {
    const parsed = new URL(text);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function inferAppServerTransport({ url = null, socketPath = null, command = null } = {}) {
  const text = normalizeUrl(url);
  if (command) {
    return "stdio";
  }
  if (socketPath || text.startsWith("unix://")) {
    return "unix";
  }
  if (text.startsWith("ws://") || text.startsWith("wss://")) {
    return "websocket";
  }
  if (!text || text === "stdio://") {
    return "stdio";
  }
  throw new Error(`unsupported app-server transport URL: ${text}`);
}

export class AppServerProtocolError extends Error {
  constructor(message, { code = null, data = null, method = null } = {}) {
    super(message);
    this.name = "AppServerProtocolError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

export function isAppServerOverloadError(error) {
  return Boolean(error && error.code === OVERLOAD_ERROR_CODE);
}

class WebSocketTransport {
  constructor({ url, WebSocketImpl = globalThis.WebSocket, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, authToken = null } = {}) {
    this.kind = "websocket";
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.authToken = authToken;
    this.ws = null;
    this.onMessage = noop;
    this.onClose = noop;
  }

  async connect() {
    if (!this.WebSocketImpl) {
      throw new Error("global WebSocket is not available");
    }
    if (!isLoopbackAppServerUrl(this.url) && !this.authToken) {
      throw new Error("non-loopback app-server websocket requires an auth token");
    }
    const protocols = this.authToken ? [`codex-app-server-token.${this.authToken}`] : undefined;
    const ws = protocols ? new this.WebSocketImpl(this.url, protocols) : new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.addEventListener("message", (event) => this.onMessage(rawMessageData(event.data)));
    ws.addEventListener("error", (event) => this.onClose(eventErrorMessage(event)));
    ws.addEventListener("close", (event) =>
      this.onClose(`websocket closed: ${event.code}${event.reason ? ` ${event.reason}` : ""}`),
    );
    await this.waitForOpen(ws);
  }

  waitForOpen(ws) {
    return new Promise((resolve, reject) => {
      if (ws.readyState === this.WebSocketImpl.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error(`timeout connecting to ${this.url}`)), this.connectTimeoutMs);
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

  close() {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}

class LineDelimitedTransport {
  constructor({ stream, kind, label, connectFn = null } = {}) {
    this.kind = kind;
    this.label = label;
    this.stream = stream;
    this.connectFn = connectFn;
    this.buffer = "";
    this.onMessage = noop;
    this.onClose = noop;
  }

  async connect() {
    if (this.connectFn) {
      this.stream = await this.connectFn();
    }
    this.stream.on("data", (chunk) => this.handleData(chunk));
    this.stream.on("error", (error) => this.onClose(error instanceof Error ? error.message : String(error)));
    this.stream.on("close", () => this.onClose(`${this.label} closed`));
    this.stream.on("exit", (code, signal) => this.onClose(`${this.label} exited: ${code ?? signal ?? "unknown"}`));
  }

  handleData(chunk) {
    this.buffer += rawMessageData(chunk);
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const trimmed = line.trim();
      if (trimmed) {
        this.onMessage(trimmed);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  send(message) {
    this.stream.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    try {
      this.stream?.end?.();
    } catch {}
    try {
      this.stream?.kill?.("SIGTERM");
    } catch {}
  }
}

function makeStdioTransport({ command = "codex", args = ["app-server"], env = {}, cwd = process.cwd() } = {}) {
  let child = null;
  return new LineDelimitedTransport({
    kind: "stdio",
    label: command,
    connectFn: async () => {
      child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.on("data", () => {});
      return {
        on: (event, listener) => {
          if (event === "data") child.stdout.on("data", listener);
          else child.on(event, listener);
        },
        write: (data) => child.stdin.write(data),
        end: () => child.stdin.end(),
        kill: (signal) => child.kill(signal),
      };
    },
  });
}

function makeUnixTransport({ url = null, socketPath = null } = {}) {
  const resolvedPath = socketPath || normalizeUrl(url).replace(/^unix:\/\//, "");
  if (!resolvedPath) {
    throw new Error("missing unix socket path for app-server transport");
  }
  return new LineDelimitedTransport({
    kind: "unix",
    label: resolvedPath,
    connectFn: () =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection(resolvedPath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      }),
  });
}

function makeTransport(options = {}) {
  if (options.transportImpl) {
    return options.transportImpl;
  }
  const kind = options.transport || inferAppServerTransport(options);
  if (kind === "websocket") {
    return new WebSocketTransport(options);
  }
  if (kind === "unix") {
    return makeUnixTransport(options);
  }
  if (kind === "stdio") {
    return makeStdioTransport(options);
  }
  throw new Error(`unsupported app-server transport: ${kind}`);
}

function extractSupportedMethods(initializeResult) {
  const candidates = [
    initializeResult?.supportedMethods,
    initializeResult?.methods,
    initializeResult?.capabilities?.methods,
    initializeResult?.serverInfo?.methods,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return new Set(value.map((item) => String(item)));
    }
  }
  return null;
}

export class AppServerProtocolClient {
  constructor({
    clientInfo = DEFAULT_CLIENT_INFO,
    capabilities = { experimentalApi: true },
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxQueuedNotifications = 500,
    featureOverrides = {},
    onNotification = null,
    onServerRequest = null,
    onStatus = null,
    ...transportOptions
  } = {}) {
    this.clientInfo = clientInfo;
    this.capabilities = capabilities;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxQueuedNotifications = maxQueuedNotifications;
    this.featureOverrides = featureOverrides;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.onStatus = onStatus;
    this.transportOptions = { ...transportOptions, connectTimeoutMs };
    this.transport = null;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.notifications = [];
    this.nextId = 1;
    this.connected = false;
    this.initializeResult = null;
    this.supportedMethods = null;
  }

  status(payload) {
    if (typeof this.onStatus === "function") {
      this.onStatus(payload);
    }
  }

  async connect() {
    this.closeTransportOnly();
    const transport = makeTransport(this.transportOptions);
    this.transport = transport;
    transport.onMessage = (raw) => this.handleRawMessage(raw);
    transport.onClose = (error) => this.handleDisconnect(error);
    await transport.connect();
    this.connected = true;
    this.initializeResult = await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: this.capabilities,
    });
    this.supportedMethods = extractSupportedMethods(this.initializeResult);
    this.notify("initialized", {});
    this.status({ status: "connected", transport: transport.kind, initializeResult: this.initializeResult });
    return this.initializeResult;
  }

  async ensureConnected() {
    if (this.connected && this.transport) {
      return true;
    }
    await this.connect();
    return true;
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.transport) {
      return Promise.reject(new Error("app-server protocol client is not connected"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.transport.send({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (!this.transport) {
      throw new Error("app-server protocol client is not connected");
    }
    this.transport.send({ method, params });
  }

  supportsMethod(method) {
    const normalized = String(method || "");
    if (Object.prototype.hasOwnProperty.call(this.featureOverrides, normalized)) {
      return Boolean(this.featureOverrides[normalized]);
    }
    if (this.supportedMethods) {
      return this.supportedMethods.has(normalized);
    }
    if (DRIFTY_METHODS.has(normalized)) {
      return false;
    }
    return CORE_METHODS.has(normalized);
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
    this.transport.send({ id: request.id, result });
    this.serverRequests.delete(key);
    return true;
  }

  rejectServerRequest(id, error) {
    const key = String(id);
    const request = this.serverRequests.get(key);
    if (!request) {
      return false;
    }
    this.transport.send({
      id: request.id,
      error: {
        code: error?.code ?? -32000,
        message: error?.message || String(error || "request rejected"),
        data: error?.data,
      },
    });
    this.serverRequests.delete(key);
    return true;
  }

  drainNotifications() {
    const out = this.notifications;
    this.notifications = [];
    return out;
  }

  handleRawMessage(raw) {
    let message;
    try {
      message = parseJsonLine(raw);
    } catch (error) {
      this.status({ status: "parse_error", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!message) {
      return;
    }
    this.handleMessage(message);
  }

  handleMessage(message) {
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
        const error = new AppServerProtocolError(message.error?.message || JSON.stringify(message.error), {
          code: message.error?.code ?? null,
          data: message.error?.data ?? null,
          method: waiter.method,
        });
        waiter.reject(error);
      }
      return;
    }

    if (message.id != null && message.method) {
      this.serverRequests.set(String(message.id), message);
      if (typeof this.onServerRequest === "function") {
        this.onServerRequest(message);
      }
      return;
    }

    if (message.method) {
      this.notifications.push(message);
      if (this.notifications.length > this.maxQueuedNotifications) {
        this.notifications.splice(0, this.notifications.length - this.maxQueuedNotifications);
      }
      if (typeof this.onNotification === "function") {
        this.onNotification(message);
      }
    }
  }

  handleDisconnect(error) {
    this.connected = false;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(error || "app-server protocol transport closed"));
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.status({ status: "disconnected", error });
  }

  closeTransportOnly() {
    if (this.transport) {
      this.transport.close();
    }
    this.transport = null;
    this.connected = false;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
    }
    this.pending.clear();
    this.serverRequests.clear();
  }

  async close() {
    this.closeTransportOnly();
    await Promise.resolve();
  }
}

