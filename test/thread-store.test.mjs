import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getAppServerThreadsByIds,
  listAppServerProjectThreads,
  listAppServerQuickstartWorkItems,
  normalizeAppServerThread,
} from "../lib/thread-store.mjs";

function makeFakeClientClass({ listPayload = [], readPayloads = {} } = {}) {
  const requests = [];
  class FakeClient {
    constructor(options) {
      this.options = options;
    }

    async connect() {}

    supportsMethod(method) {
      return ["thread/list", "thread/read"].includes(method);
    }

    async request(method, params) {
      requests.push({ method, params });
      if (method === "thread/list") {
        return { data: listPayload };
      }
      if (method === "thread/read") {
        return readPayloads[params.threadId] ?? { thread: null };
      }
      throw new Error(`unexpected method ${method}`);
    }

    async close() {
      this.closed = true;
    }
  }
  FakeClient.requests = requests;
  return FakeClient;
}

test("normalizeAppServerThread maps Codex app-server rows to sqlite-shaped rows", () => {
  const row = normalizeAppServerThread({
    id: "thread-1",
    name: "Main thread",
    cwd: "/repo",
    updatedAt: 1_774_000_000,
    createdAt: 1_773_999_000,
    path: "/tmp/rollout.jsonl",
    modelProvider: "openai",
    source: { origin: "vscode" },
    status: { type: "notLoaded" },
  });

  assert.equal(row.id, "thread-1");
  assert.equal(row.title, "Main thread");
  assert.equal(row.cwd, "/repo");
  assert.equal(row.archived, 0);
  assert.equal(row.updated_at, 1_774_000_000);
  assert.equal(row.updated_at_ms, 1_774_000_000_000);
  assert.equal(row.rollout_path, "/tmp/rollout.jsonl");
  assert.equal(row.model_provider, "openai");
  assert.equal(row.source, '{"origin":"vscode"}');
});

test("listAppServerProjectThreads filters active non-worker rows by cwd", async () => {
  const FakeClient = makeFakeClientClass({
    listPayload: [
      { id: "worker", name: "Worker", cwd: "/repo", updatedAt: 30, agentRole: "worker" },
      { id: "archived", name: "Old", cwd: "/repo", updatedAt: 40, status: { type: "archived" } },
      { id: "other", name: "Other", cwd: "/other", updatedAt: 50 },
      { id: "new", name: "New", cwd: "/repo", updatedAt: 20 },
      { id: "old", name: "Old", cwd: "/repo", updatedAt: 10 },
    ],
  });

  const rows = await listAppServerProjectThreads(
    { appServerUrl: "ws://127.0.0.1:27890" },
    "/repo",
    { limit: 2 },
    { AppServerProtocolClientClass: FakeClient },
  );

  assert.deepEqual(
    rows.map((row) => row.id),
    ["new", "old"],
  );
  assert.deepEqual(FakeClient.requests.map((request) => request.method), ["thread/list"]);
});

test("getAppServerThreadsByIds falls back to thread/read for missing list rows", async () => {
  const FakeClient = makeFakeClientClass({
    listPayload: [{ id: "thread-1", name: "Listed", cwd: "/repo", updatedAt: 20 }],
    readPayloads: {
      "thread-2": {
        thread: { id: "thread-2", name: "Read", cwd: "/repo", updatedAt: 10 },
      },
    },
  });

  const rows = await getAppServerThreadsByIds(
    { appServerUrl: "ws://127.0.0.1:27890" },
    ["thread-1", "thread-2"],
    { AppServerProtocolClientClass: FakeClient },
  );

  assert.deepEqual(
    rows.map((row) => row.id),
    ["thread-1", "thread-2"],
  );
  assert.equal(FakeClient.requests.some((request) => request.method === "thread/read"), true);
});

test("listAppServerQuickstartWorkItems keeps pinned threads before the recent tail", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codex-thread-store-"));
  try {
    const globalStatePath = path.join(tmpDir, ".codex-global-state.json");
    await writeFile(
      globalStatePath,
      `${JSON.stringify({ "pinned-thread-ids": ["pinned"] }, null, 2)}\n`,
      "utf8",
    );
    const FakeClient = makeFakeClientClass({
      listPayload: [
        { id: "recent", name: "Recent", cwd: "/repo", updatedAt: 30 },
        { id: "pinned", name: "Pinned", cwd: "/repo", updatedAt: 10 },
      ],
    });

    const result = await listAppServerQuickstartWorkItems(
      { appServerUrl: "ws://127.0.0.1:27890" },
      { limit: 2, globalStatePath },
      { AppServerProtocolClientClass: FakeClient },
    );

    assert.deepEqual(
      result.threads.map((thread) => thread.id),
      ["pinned", "recent"],
    );
    assert.deepEqual(
      result.threads.map((thread) => thread.codexPinned),
      [true, false],
    );
    assert.equal(result.selectedPinnedThreadCount, 1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
