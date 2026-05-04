import test from "node:test";
import assert from "node:assert/strict";

import { selectPageTarget } from "../scripts/send_via_app_control.js";

test("app-control helper prefers the main Codex window over hotkey windows", () => {
  const target = selectPageTarget([
    {
      id: "hotkey-1",
      type: "page",
      title: "Codex",
      url: "app://-/index.html?initialRoute=%2Fhotkey-window&hostId=local",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/hotkey-1",
    },
    {
      id: "main",
      type: "page",
      title: "Codex",
      url: "app://-/index.html?hostId=local",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/main",
    },
  ]);

  assert.equal(target.id, "main");
});

test("app-control helper still falls back to a hotkey page when it is the only page target", () => {
  const target = selectPageTarget([
    {
      id: "worker",
      type: "worker",
      title: "",
      url: "",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/worker",
    },
    {
      id: "hotkey-1",
      type: "page",
      title: "Codex",
      url: "app://-/index.html?initialRoute=%2Fhotkey-window&hostId=local",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/hotkey-1",
    },
  ]);

  assert.equal(target.id, "hotkey-1");
});
