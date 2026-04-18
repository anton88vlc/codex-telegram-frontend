#!/usr/bin/env node

const DEFAULT_DEBUG_BASE_URL = process.env.CODEX_REMOTE_DEBUG_URL || "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function fail(message, extra = {}, code = 1) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, ...extra }, null, 2)}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    debugBaseUrl: DEFAULT_DEBUG_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    waitForReply: false,
    restoreRoute: true,
    showThread: false,
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
      case "--timeout-ms":
        out.timeoutMs = Number(argv[++i]);
        break;
      case "--poll-interval-ms":
        out.pollIntervalMs = Number(argv[++i]);
        break;
      case "--debug-base-url":
        out.debugBaseUrl = argv[++i];
        break;
      case "--wait-for-reply":
        out.waitForReply = true;
        break;
      case "--no-restore-route":
        out.restoreRoute = false;
        break;
      case "--show-thread":
        out.showThread = true;
        break;
      default:
        fail(`unknown argument: ${arg}`, { argv });
    }
  }

  if (!out.threadId) fail("missing required --thread-id", { argv });
  if (!out.prompt) fail("missing required --prompt", { argv });
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    fail("invalid --timeout-ms", { timeoutMs: out.timeoutMs });
  }
  if (!Number.isFinite(out.pollIntervalMs) || out.pollIntervalMs <= 0) {
    fail("invalid --poll-interval-ms", { pollIntervalMs: out.pollIntervalMs });
  }

  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDebugBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

async function getPageTarget(debugBaseUrl) {
  const baseUrl = normalizeDebugBaseUrl(debugBaseUrl);
  const response = await fetch(`${baseUrl}/json/list`);
  if (!response.ok) {
    throw new Error(`failed to query ${baseUrl}/json/list: HTTP ${response.status}`);
  }
  const targets = await response.json();
  if (!Array.isArray(targets)) {
    throw new Error(`unexpected response from ${baseUrl}/json/list`);
  }

  const pageTargets = targets.filter((target) => target?.type === "page" && target?.webSocketDebuggerUrl);
  if (pageTargets.length === 0) {
    throw new Error(`no page targets found at ${baseUrl}; launch Codex with --remote-debugging-port`);
  }

  const codexPage =
    pageTargets.find((target) => String(target.title || "").includes("Codex")) ||
    pageTargets.find((target) => String(target.url || "").includes("codex")) ||
    pageTargets[0];

  return {
    baseUrl,
    target: codexPage,
  };
}

async function withCdp(webSocketDebuggerUrl, fn) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (event) => reject(event.error || event), { once: true });
  });

  let nextId = 1;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
    } catch {
      return;
    }
    if (message?.id != null && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (Object.prototype.hasOwnProperty.call(message, "result")) {
        waiter.resolve(message.result);
      } else {
        waiter.reject(new Error(message?.error?.message || JSON.stringify(message.error)));
      }
    }
  });

  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  try {
    await request("Runtime.enable");
    return await fn({
      request,
      async evaluate(source) {
        const result = await request("Runtime.evaluate", {
          expression: source,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result?.exceptionDetails) {
          const description =
            result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            "Runtime.evaluate failed";
          throw new Error(description);
        }
        return result?.result?.value;
      },
    });
  } finally {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("CDP connection closed"));
    }
    pending.clear();
    try {
      ws.close();
    } catch {}
  }
}

function serialize(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildActionRunnerSource(payload) {
  return `
    (async () => {
      const payload = ${serialize(payload)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      function getReactRootFiber() {
        const root = document.querySelector("#root");
        if (!root) return null;
        for (const key of Object.keys(root)) {
          if (!key.startsWith("__reactContainer")) continue;
          const container = root[key];
          if (container?.child || container?.memoizedProps || container?.memoizedState) {
            return container;
          }
          if (container?._internalRoot?.current) return container._internalRoot.current;
          if (container?.current) return container.current;
        }
        return null;
      }

      function findNavigator() {
        const rootFiber = getReactRootFiber();
        if (!rootFiber) return null;
        const seen = new Set();
        const stack = [rootFiber];
        while (stack.length) {
          const node = stack.pop();
          if (!node || seen.has(node)) continue;
          seen.add(node);
          const type = node.type;
          const displayName = type?.displayName || type?.name || "";
          if (displayName === "Navigation") {
            const navigator = node.memoizedProps?.value?.navigator;
            if (navigator?.push && navigator?.replace) return navigator;
          }
          if (node.child) stack.push(node.child);
          if (node.sibling) stack.push(node.sibling);
        }
        return null;
      }

      function getCurrentPath(navigator) {
        const location = navigator?.location;
        if (location) {
          return \`\${location.pathname || ""}\${location.search || ""}\${location.hash || ""}\`;
        }
        return \`\${window.location.pathname || ""}\${window.location.search || ""}\${window.location.hash || ""}\`;
      }

      async function ensureDebugRoute(navigator, timeoutMs) {
        const startedAt = Date.now();
        const initialPath = getCurrentPath(navigator);
        if (initialPath !== "/debug") {
          if (!navigator) {
            throw new Error("failed to locate React navigation context outside /debug");
          }
          navigator.push("/debug");
        }
        while (Date.now() - startedAt < timeoutMs) {
          const bodyText = document.body?.innerText || "";
          if (bodyText.includes("Debug") && bodyText.includes("App Actions")) {
            return initialPath;
          }
          await sleep(100);
        }
        throw new Error("debug route did not mount in time");
      }

      async function runDebugAction(action, timeoutMs) {
        const requestId = \`app-action:\${Date.now()}:\${Math.random().toString(16).slice(2)}\`;
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            window.removeEventListener("message", onMessage);
            reject(new Error(\`timed out waiting for debug-run-app-action-response for \${action.type}\`));
          }, timeoutMs);

          function finish(fn, value) {
            clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            fn(value);
          }

          function onMessage(event) {
            const data = event?.data;
            if (data?.type !== "debug-run-app-action-response" || data?.requestId !== requestId) {
              return;
            }
            if (data.ok) {
              finish(resolve, data.result);
            } else {
              finish(reject, new Error(data.errorMessage || \`debug action failed: \${action.type}\`));
            }
          }

          window.addEventListener("message", onMessage);
          Promise.resolve(
            window.electronBridge?.sendMessageFromView({
              type: "debug-run-app-action-request",
              requestId,
              action,
            }),
          ).catch((error) => {
            finish(reject, error instanceof Error ? error : new Error(String(error)));
          });
        });
      }

      const navigator = findNavigator();
      if (!window.electronBridge?.sendMessageFromView) {
        throw new Error("window.electronBridge.sendMessageFromView is unavailable");
      }

      const previousPath = await ensureDebugRoute(navigator, payload.timeoutMs);
      const beforeRead = await runDebugAction(
        {
          type: "threads.read",
          threadId: payload.threadId,
          limit: 1,
          includeOutputs: false,
          maxOutputChars: 2000,
        },
        payload.timeoutMs,
      );
      const previousTurnId = beforeRead?.turns?.[0]?.id ?? null;

      const sendResult = await runDebugAction(
        {
          type: "threads.send_message",
          threadId: payload.threadId,
          prompt: payload.prompt,
        },
        payload.timeoutMs,
      );

      let finalReply = null;
      let latestThreadRead = null;
      if (payload.waitForReply) {
        const deadline = Date.now() + payload.timeoutMs;
        while (Date.now() < deadline) {
          latestThreadRead = await runDebugAction(
            {
              type: "threads.read",
              threadId: payload.threadId,
              limit: 4,
              includeOutputs: false,
              maxOutputChars: 4000,
            },
            payload.timeoutMs,
          );
          const turns = Array.isArray(latestThreadRead?.turns) ? latestThreadRead.turns : [];
          const matchingTurn = turns.find((turn) => {
            const items = Array.isArray(turn?.items) ? turn.items : [];
            const userItem = items.find((item) => item?.type === "userMessage");
            const userText = Array.isArray(userItem?.content)
              ? userItem.content
                  .filter((entry) => entry?.type === "text")
                  .map((entry) => entry?.text || "")
                  .join("\\n")
              : "";
            return turn?.id !== previousTurnId && userText === payload.prompt;
          });
          if (matchingTurn) {
            const finalMessage = matchingTurn.items.find(
              (item) => item?.type === "agentMessage" && item?.phase === "final_answer",
            );
            if (finalMessage?.text) {
              finalReply = {
                text: finalMessage.text,
                turnId: matchingTurn.id,
                completedAt: matchingTurn.completedAt || null,
              };
              break;
            }
          }
          await sleep(payload.pollIntervalMs);
        }
        if (!finalReply) {
          throw new Error("timed out waiting for final reply via threads.read");
        }
      }

      let finalPath = getCurrentPath(navigator);
      if (payload.showThread) {
        await runDebugAction(
          {
            type: "windows.show_thread",
            windowId: "current",
            threadId: payload.threadId,
          },
          payload.timeoutMs,
        );
        finalPath = getCurrentPath(navigator);
      } else if (payload.restoreRoute && previousPath && previousPath !== "/debug") {
        navigator.replace(previousPath);
        finalPath = previousPath;
      }

      return {
        ok: true,
        previousPath,
        finalPath,
        sendResult,
        latestThreadRead,
        reply: finalReply,
      };
    })();
  `;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const { baseUrl, target } = await getPageTarget(args.debugBaseUrl);
    const payload = {
      threadId: args.threadId,
      prompt: args.prompt,
      waitForReply: args.waitForReply,
      timeoutMs: args.timeoutMs,
      pollIntervalMs: args.pollIntervalMs,
      restoreRoute: args.restoreRoute && !args.showThread,
      showThread: args.showThread,
    };

    const result = await withCdp(target.webSocketDebuggerUrl, async ({ evaluate }) => {
      return evaluate(buildActionRunnerSource(payload));
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          mode: args.waitForReply
            ? "app-control-send-and-wait-for-reply"
            : "app-control-send-only",
          transport: "app-control",
          debugBaseUrl: baseUrl,
          targetTitle: target.title ?? null,
          targetUrl: target.url ?? null,
          threadId: args.threadId,
          prompt: args.prompt,
          showThread: args.showThread,
          ...result,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), {
      threadId: args.threadId,
      debugBaseUrl: args.debugBaseUrl,
    });
  }
}

main();
