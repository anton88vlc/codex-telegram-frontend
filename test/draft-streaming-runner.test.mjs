import test from "node:test";
import assert from "node:assert/strict";

import {
  formatDraftStreamingText,
  isDraftStreamingBindingEligible,
  makeDraftId,
  syncDraftStreams,
} from "../lib/draft-streaming-runner.mjs";

function makeBinding(overrides = {}) {
  return {
    threadId: "thread-1",
    chatId: "6074160741",
    messageThreadId: 42,
    transport: "native",
    surface: "codex-chats",
    currentTurn: {
      startedAt: "2026-04-21T10:00:00.000Z",
      promptPreview: "Check the repo",
    },
    ...overrides,
  };
}

test("draft streaming is limited to active private Codex Chat topics", () => {
  assert.equal(isDraftStreamingBindingEligible({}, makeBinding()), true);
  assert.equal(isDraftStreamingBindingEligible({ draftStreamingEnabled: false }, makeBinding()), false);
  assert.equal(isDraftStreamingBindingEligible({}, makeBinding({ surface: "project-topic" })), false);
  assert.equal(isDraftStreamingBindingEligible({}, makeBinding({ chatId: "-1001" })), false);
  assert.equal(isDraftStreamingBindingEligible({}, makeBinding({ messageThreadId: null })), false);
  assert.equal(isDraftStreamingBindingEligible({}, makeBinding({ currentTurn: null })), false);
});

test("formatDraftStreamingText prefers the latest live progress", () => {
  const text = formatDraftStreamingText(
    makeBinding({
      currentTurn: {
        promptPreview: "Initial prompt",
        progressItems: [
          { text: "Started reasoning." },
          { text: "Reading files." },
        ],
      },
    }),
  );

  assert.equal(text, "Working...\nReading files.");
});

test("makeDraftId is stable for the same turn and non-zero", () => {
  const turn = { startedAt: "2026-04-21T10:00:00.000Z", promptPreview: "Hello" };
  assert.equal(makeDraftId("private:1:topic:2", turn), makeDraftId("private:1:topic:2", turn));
  assert.notEqual(makeDraftId("private:1:topic:2", turn), 0);
});

test("syncDraftStreams sends a draft and stores draft state", async () => {
  const calls = [];
  const events = [];
  const state = { bindings: { private: makeBinding() } };
  const result = await syncDraftStreams({
    config: { botToken: "token" },
    state,
    nowMs: Date.parse("2026-04-21T10:01:00.000Z"),
    sendMessageDraftFn: async (token, payload) => calls.push({ token, payload }),
    logEventFn: (type, payload) => events.push({ type, payload }),
  });

  assert.deepEqual(result, { changed: true, sent: 1, skipped: 0, errors: 0 });
  assert.equal(calls[0].token, "token");
  assert.equal(calls[0].payload.chatId, "6074160741");
  assert.equal(calls[0].payload.messageThreadId, 42);
  assert.match(calls[0].payload.text, /^Working\.\.\./);
  assert.equal(state.bindings.private.currentTurn.draftStream.lastText, calls[0].payload.text);
  assert.equal(events[0].type, "draft_stream_sent");
});

test("syncDraftStreams skips unchanged draft text", async () => {
  const state = {
    bindings: {
      private: makeBinding({
        currentTurn: {
          startedAt: "2026-04-21T10:00:00.000Z",
          promptPreview: "Check the repo",
          draftStream: {
            draftId: 123,
            lastText: "Working...\nWorking on: Check the repo",
            lastSentAt: "2026-04-21T10:00:01.000Z",
          },
        },
      }),
    },
  };
  const result = await syncDraftStreams({
    config: {},
    state,
    sendMessageDraftFn: async () => {
      throw new Error("should not send");
    },
  });

  assert.deepEqual(result, { changed: false, sent: 0, skipped: 1, errors: 0 });
});

test("syncDraftStreams is a quiet fallback on Telegram errors", async () => {
  const events = [];
  const state = { bindings: { private: makeBinding() } };
  const result = await syncDraftStreams({
    config: {
      botToken: "token",
      draftStreamingErrorCooldownMs: 1000,
    },
    state,
    nowMs: Date.parse("2026-04-21T10:01:00.000Z"),
    sendMessageDraftFn: async () => {
      throw new Error("drafts unavailable");
    },
    logEventFn: (type, payload) => events.push({ type, payload }),
  });

  assert.deepEqual(result, { changed: true, sent: 0, skipped: 0, errors: 1 });
  assert.equal(state.bindings.private.currentTurn.draftStream.lastError, "drafts unavailable");
  assert.equal(state.bindings.private.currentTurn.draftStream.disabledUntil, "2026-04-21T10:01:01.000Z");
  assert.equal(events[0].type, "draft_stream_error");
});
