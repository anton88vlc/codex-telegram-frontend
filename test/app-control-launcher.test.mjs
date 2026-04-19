import test from "node:test";
import assert from "node:assert/strict";

import {
  appControlJsonListUrl,
  buildCodexLaunchArgs,
  checkAppControl,
  launchCodexAppControl,
  normalizeAppControlBaseUrl,
  parseAppControlPort,
  parsePgrepOutput,
  waitForAppControl,
} from "../lib/app-control-launcher.mjs";

test("normalizes app-control base URL and json/list endpoint", () => {
  assert.equal(normalizeAppControlBaseUrl("http://127.0.0.1:9222///"), "http://127.0.0.1:9222");
  assert.equal(appControlJsonListUrl("http://127.0.0.1:9222/"), "http://127.0.0.1:9222/json/list");
});

test("builds Codex launch args from app-control URL", () => {
  assert.equal(parseAppControlPort("http://127.0.0.1:9333"), 9333);
  assert.deepEqual(buildCodexLaunchArgs("http://127.0.0.1:9333"), ["--remote-debugging-port=9333"]);
});

test("checks app-control target list", async () => {
  const result = await checkAppControl("http://127.0.0.1:9222", {
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:9222/json/list");
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "page-1" }, { id: "page-2" }],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetCount, 2);
});

test("reports app-control fetch failures without throwing", async () => {
  const result = await checkAppControl("http://127.0.0.1:9222", {
    fetchImpl: async () => {
      throw new Error("fetch failed");
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /fetch failed/);
});

test("parses pgrep output", () => {
  assert.deepEqual(parsePgrepOutput("123\n\n456\n"), ["123", "456"]);
  assert.deepEqual(parsePgrepOutput(""), []);
});

test("dry-run launch returns command without spawning", async () => {
  const result = await launchCodexAppControl({
    binaryPath: "/tmp/Codex",
    baseUrl: "http://127.0.0.1:9444",
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.command, "/tmp/Codex");
  assert.deepEqual(result.args, ["--remote-debugging-port=9444"]);
});

test("waitForAppControl succeeds after retry", async () => {
  let calls = 0;
  const result = await waitForAppControl("http://127.0.0.1:9222", {
    timeoutMs: 100,
    intervalMs: 1,
    checkImpl: async () => {
      calls += 1;
      return { ok: calls >= 2 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

