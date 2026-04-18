#!/usr/bin/env node

const DEFAULT_URL = process.env.CODEX_APP_SERVER_URL || "ws://127.0.0.1:27890";
const DEFAULT_TIMEOUT_MS = 45_000;

function fail(message, extra = {}, code = 1) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: message, ...extra }, null, 2)}\n`,
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    url: DEFAULT_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    waitForReply: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--thread-id":
        out.threadId = argv[++i];
        break;
      case "--prompt":
        out.prompt = argv[++i];
        break;
      case "--url":
        out.url = argv[++i];
        break;
      case "--timeout-ms":
        out.timeoutMs = Number(argv[++i]);
        break;
      case "--wait-for-reply":
        out.waitForReply = true;
        break;
      default:
        fail(`unknown argument: ${arg}`, { argv });
    }
  }

  if (!out.threadId) {
    fail("missing required --thread-id", { argv });
  }
  if (!out.prompt) {
    fail("missing required --prompt", { argv });
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    fail("invalid --timeout-ms", { timeoutMs: out.timeoutMs });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ws = new WebSocket(args.url);
  const pending = new Map();
  let nextId = 1;
  let finished = false;
  let currentTurnId = null;
  let finalAgentMessage = null;
  let closeTimer = null;
  let waitResolve;
  const waitPromise = new Promise((resolve) => {
    waitResolve = resolve;
  });

  function finish(payload, code = 0) {
    if (finished) {
      return;
    }
    finished = true;
    if (closeTimer) {
      clearTimeout(closeTimer);
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    try {
      ws.close();
    } catch {}
    setTimeout(() => process.exit(code), 50);
  }

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

  function respondUnsupported(id, method) {
    send({
      id,
      error: {
        code: -32000,
        message: `Unsupported server request in thread-ping-native helper: ${method}`,
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
    if (message.method === "turn/started") {
      currentTurnId = params.turn?.id || currentTurnId;
      return;
    }

    if (
      message.method === "item/completed" &&
      params.threadId === args.threadId &&
      (!currentTurnId || params.turnId === currentTurnId)
    ) {
      const item = params.item;
      if (item?.type === "agentMessage" && item.phase === "final_answer") {
        finalAgentMessage = item;
      }
      return;
    }

    if (
      message.method === "turn/completed" &&
      params.threadId === args.threadId &&
      (!currentTurnId || params.turn?.id === currentTurnId)
    ) {
      waitResolve({
        threadId: params.threadId,
        turn: params.turn || null,
      });
    }
  });

  ws.addEventListener("error", (event) => {
    if (finished) {
      return;
    }
    const error = event?.error?.message || event?.message || "websocket error";
    finish(
      {
        ok: false,
        error,
        threadId: args.threadId,
        url: args.url,
      },
      1,
    );
  });

  ws.addEventListener("close", (event) => {
    if (!finished) {
      finish(
        {
          ok: false,
          error: "websocket closed before helper finished",
          code: event.code,
          reason: event.reason || "",
          threadId: args.threadId,
          url: args.url,
        },
        1,
      );
    }
  });

  try {
    await waitForOpen(ws);

    const startedAtMs = Date.now();
    await request("initialize", {
      clientInfo: {
        name: "thread-ping-native",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    send({ method: "initialized" });

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

    if (!args.waitForReply) {
      finish({
        ok: true,
        mode: "native-send-only",
        transport: "app-server",
        url: args.url,
        threadId: args.threadId,
        prompt: args.prompt,
        sentAtMs: startedAtMs,
        thread: resumed.thread
          ? {
              id: resumed.thread.id,
              status: resumed.thread.status,
              name: resumed.thread.name ?? null,
              cwd: resumed.thread.cwd ?? null,
            }
          : null,
        turn: turnStarted.turn || null,
      });
      return;
    }

    closeTimer = setTimeout(() => {
      waitResolve({
        timeout: true,
      });
    }, args.timeoutMs);

    const completion = await waitPromise;
    if (completion?.timeout) {
      finish(
        {
          ok: false,
          error: "timeout waiting for final reply",
          mode: "native-send-and-wait-for-reply",
          transport: "app-server",
          url: args.url,
          threadId: args.threadId,
          prompt: args.prompt,
          sentAtMs: startedAtMs,
          turnId: currentTurnId,
        },
        2,
      );
      return;
    }

    finish({
      ok: true,
      mode: "native-send-and-wait-for-reply",
      transport: "app-server",
      url: args.url,
      threadId: args.threadId,
      prompt: args.prompt,
      sentAtMs: startedAtMs,
      turn: completion.turn || turnStarted.turn || null,
      reply: finalAgentMessage
        ? {
            text: finalAgentMessage.text ?? "",
            phase: finalAgentMessage.phase ?? null,
            itemId: finalAgentMessage.id ?? null,
          }
        : null,
    });
  } catch (error) {
    finish(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        threadId: args.threadId,
        url: args.url,
      },
      1,
    );
  }
}

main();
