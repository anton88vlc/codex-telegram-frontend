#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  normalizeAppServerNotification,
  shouldKeepAppServerStreamEvent,
  summarizeAppServerStreamEvents,
} from "../lib/app-server-stream.mjs";

const DEFAULT_URL = process.env.CODEX_APP_SERVER_URL || "ws://127.0.0.1:27890";
const DEFAULT_TIMEOUT_MS = 60_000;

function compact(value, limit = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}...` : text;
}

function printJson(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    url: DEFAULT_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxEvents: 500,
    outPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--thread-id":
        out.threadId = argv[++index];
        break;
      case "--prompt":
        out.prompt = argv[++index];
        break;
      case "--url":
        out.url = argv[++index];
        break;
      case "--timeout-ms":
        out.timeoutMs = Number(argv[++index]);
        break;
      case "--max-events":
        out.maxEvents = Number(argv[++index]);
        break;
      case "--out":
        out.outPath = argv[++index];
        break;
      case "--help":
      case "-h":
        printJson({
          usage:
            "node scripts/probe_app_server_stream.mjs --thread-id <id> --prompt <text> [--url ws://127.0.0.1:27890] [--out logs/app-server-stream-probe.ndjson]",
        });
        break;
      default:
        printJson({ ok: false, error: `unknown argument: ${arg}`, argv }, 1);
    }
  }

  if (!out.threadId) {
    printJson({ ok: false, error: "missing required --thread-id", argv }, 1);
  }
  if (!out.prompt) {
    printJson({ ok: false, error: "missing required --prompt", argv }, 1);
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    printJson({ ok: false, error: "invalid --timeout-ms", timeoutMs: out.timeoutMs }, 1);
  }
  if (!Number.isFinite(out.maxEvents) || out.maxEvents <= 0) {
    printJson({ ok: false, error: "invalid --max-events", maxEvents: out.maxEvents }, 1);
  }

  return out;
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (event) => reject(event.error || event), { once: true });
  });
}

async function writeEvents(outPath, events) {
  if (!outPath) {
    return null;
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAtMs = Date.now();
  const ws = new WebSocket(args.url);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  let currentTurnId = null;
  let finished = false;
  let finishResolve;
  const finishPromise = new Promise((resolve) => {
    finishResolve = resolve;
  });

  function send(message) {
    ws.send(JSON.stringify(message));
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }

  function resolveFinish(payload) {
    if (finished) {
      return;
    }
    finished = true;
    finishResolve(payload);
  }

  function record(message) {
    const event = normalizeAppServerNotification(message, { ts: new Date().toISOString() });
    if (!shouldKeepAppServerStreamEvent(event, { threadId: args.threadId, turnId: currentTurnId })) {
      return;
    }
    events.push(event);
    if (events.length > args.maxEvents) {
      events.shift();
    }
  }

  function respondUnsupported(id, method) {
    send({
      id,
      error: {
        code: -32000,
        message: `app-server stream probe does not handle server request: ${method}`,
      },
    });
  }

  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (
      message.id != null &&
      pending.has(message.id) &&
      (Object.prototype.hasOwnProperty.call(message, "result") || message.error)
    ) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (Object.prototype.hasOwnProperty.call(message, "result")) {
        waiter.resolve(message.result);
      } else {
        waiter.reject(new Error(JSON.stringify(message.error)));
      }
      return;
    }

    if (message.id != null && message.method) {
      respondUnsupported(message.id, message.method);
      return;
    }

    if (!message.method) {
      return;
    }

    const params = message.params || {};
    if (message.method === "turn/started" && params.threadId === args.threadId) {
      currentTurnId = params.turn?.id || currentTurnId;
    }
    record(message);

    if (
      message.method === "turn/completed" &&
      params.threadId === args.threadId &&
      (!currentTurnId || params.turn?.id === currentTurnId)
    ) {
      resolveFinish({ completed: true, turn: params.turn || null });
    }
  });

  ws.addEventListener("error", (event) => {
    resolveFinish({
      error: event?.error?.message || event?.message || "websocket error",
    });
  });

  ws.addEventListener("close", (event) => {
    if (!finished) {
      resolveFinish({
        error: "websocket closed before turn completed",
        closeCode: event.code,
        closeReason: event.reason || "",
      });
    }
  });

  const timer = setTimeout(() => {
    resolveFinish({ timeout: true });
  }, args.timeoutMs);

  try {
    await waitForOpen(ws);
    await request("initialize", {
      clientInfo: {
        name: "codex-telegram-frontend-stream-probe",
        title: "Codex Telegram Frontend Stream Probe",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    send({ method: "initialized", params: {} });

    const resumed = await request("thread/resume", {
      threadId: args.threadId,
    });
    const turnStarted = await request("turn/start", {
      threadId: args.threadId,
      input: [
        {
          type: "text",
          text: args.prompt,
          text_elements: [],
        },
      ],
    });

    currentTurnId = turnStarted.turn?.id || currentTurnId;
    const completion = await finishPromise;
    clearTimeout(timer);

    const eventsPath = await writeEvents(args.outPath, events);
    const summary = summarizeAppServerStreamEvents(events);
    try {
      ws.close();
    } catch {}

    if (completion?.error || completion?.timeout) {
      printJson(
        {
          ok: false,
          mode: "app-server-stream-probe",
          error: completion?.timeout ? "timeout waiting for turn/completed" : completion.error,
          url: args.url,
          threadId: args.threadId,
          turnId: currentTurnId,
          promptPreview: compact(args.prompt),
          durationMs: Date.now() - startedAtMs,
          eventsPath,
          summary,
        },
        completion?.timeout ? 2 : 1,
      );
    }

    printJson({
      ok: true,
      mode: "app-server-stream-probe",
      url: args.url,
      threadId: args.threadId,
      turnId: currentTurnId,
      promptPreview: compact(args.prompt),
      durationMs: Date.now() - startedAtMs,
      eventsPath,
      thread: resumed.thread
        ? {
            id: resumed.thread.id,
            name: resumed.thread.name ?? null,
            status: resumed.thread.status ?? null,
            cwd: resumed.thread.cwd ?? null,
          }
        : null,
      turn: completion.turn || turnStarted.turn || null,
      summary,
    });
  } catch (error) {
    clearTimeout(timer);
    try {
      ws.close();
    } catch {}
    const eventsPath = await writeEvents(args.outPath, events).catch(() => null);
    printJson(
      {
        ok: false,
        mode: "app-server-stream-probe",
        error: error instanceof Error ? error.message : String(error),
        url: args.url,
        threadId: args.threadId,
        turnId: currentTurnId,
        promptPreview: compact(args.prompt),
        durationMs: Date.now() - startedAtMs,
        eventsPath,
        summary: summarizeAppServerStreamEvents(events),
      },
      1,
    );
  }
}

main();
