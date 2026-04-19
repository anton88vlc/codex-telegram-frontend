import test from "node:test";
import assert from "node:assert/strict";

import { appendTransportNotice, renderNativeSendError } from "../lib/native-ux.mjs";

test("renderNativeSendError explains failed app-control and failed fallback", () => {
  const error = new Error("app-control failed and app-server fallback failed");
  error.kind = "fallback_failed";
  error.attempts = [
    {
      path: "app-control",
      error: "failed to query http://127.0.0.1:9222/json/list: fetch failed",
    },
    {
      path: "app-server-fallback",
      error: "websocket closed early",
    },
  ];

  const text = renderNativeSendError(error);

  assert.match(text, /Codex Desktop is not reachable/);
  assert.match(text, /app-control failed/);
  assert.match(text, /app-server fallback failed/);
  assert.match(text, /--remote-debugging-port=9222/);
});

test("renderNativeSendError explains app-server-first failure", () => {
  const error = new Error("app-server ingress failed: app server down");
  error.kind = "app_server_failed";
  error.attempts = [
    {
      path: "app-server-fallback",
      error: "app server down",
    },
  ];

  const text = renderNativeSendError(error);

  assert.match(text, /Codex app-server is not reachable/);
  assert.match(text, /did not touch app-control/);
  assert.match(text, /app server down/);
});

test("renderNativeSendError explains failed private Chat creation", () => {
  const error = new Error("app-server chat start failed: no rollout found");
  error.kind = "app_server_chat_start_failed";
  error.attempts = [
    {
      path: "app-server-thread-start",
      error: "no rollout found",
    },
  ];

  const text = renderNativeSendError(error);

  assert.match(text, /could not create a new Codex Chat/);
});

test("renderNativeSendError warns that timeout may still be running", () => {
  const error = new Error("timed out waiting for final reply via threads.read");
  error.kind = "reply_timeout";

  const text = renderNativeSendError(error);

  assert.match(text, /did not return a final reply before timeout/);
  assert.match(text, /if the request is still running there/);
});

test("appendTransportNotice only annotates app-server fallback replies", () => {
  assert.equal(appendTransportNotice("Normal answer", { transportPath: "app-control" }), "Normal answer");
  assert.match(
    appendTransportNotice("Fallback answer", { transportPath: "app-server-fallback" }),
    /Fallback answer\n\nTransport note: delivered through app-server fallback/,
  );
});
