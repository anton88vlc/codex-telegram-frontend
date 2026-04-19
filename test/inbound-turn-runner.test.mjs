import test from "node:test";
import assert from "node:assert/strict";

import { handlePlainText } from "../lib/inbound-turn-runner.mjs";

function makeConfig(overrides = {}) {
  return {
    botToken: "token",
    botUsername: "codexbot",
    statePath: "/tmp/codex-telegram-state.json",
    sendTyping: false,
    typingHeartbeatEnabled: false,
    nativeWaitForReply: false,
    nativeIngressTransport: "app-control",
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  return {
    chat: {
      id: -1001,
      type: "supergroup",
      title: "Codex - repo",
    },
    message_id: 10,
    message_thread_id: 3,
    text: "do the thing",
    ...overrides,
  };
}

function makeBinding(overrides = {}) {
  return {
    threadId: "thread-1",
    transport: "native",
    chatId: "-1001",
    messageThreadId: 3,
    ...overrides,
  };
}

function makeSendOnlyDeps(calls = {}) {
  return {
    captureWorktreeBaselineFn: async () => ({ head: "base-head", summary: null }),
    collectTelegramAttachmentsFn: () => [],
    collectTelegramVoiceRefsFn: () => [],
    getMessageIngressTextFn: (message) => message.text || "",
    getInitialProgressTextFn: () => "Progress\nStarting...",
    logEventFn: (...args) => (calls.events ||= []).push(args),
    makePromptPreviewFn: (text) => text.slice(0, 80),
    normalizeInboundPromptFn: (text) => text.trim(),
    refreshStatusBarsFn: async (...args) => (calls.status ||= []).push(args),
    rememberOutboundFn: (...args) => (calls.remembered ||= []).push(args),
    rememberOutboundMirrorSuppressionFn: (...args) => (calls.suppressions ||= []).push(args),
    replyPlainFn: async (...args) => {
      (calls.replyPlain ||= []).push(args);
      return [{ message_id: 50 }];
    },
    saveStateFn: async (...args) => (calls.saves ||= []).push(args),
    sendNativeTurnFn: async (...args) => {
      (calls.native ||= []).push(args);
      return { transportPath: "app-control", mode: "send-only" };
    },
    shouldPreferAppServerFn: () => false,
    startProgressBubbleFn: (...args) => {
      (calls.progress ||= []).push(args);
      return {
        stop: async () => {
          calls.progressStops = (calls.progressStops || 0) + 1;
        },
      };
    },
    subscribeAppServerStreamFn: async (...args) => (calls.subscriptions ||= []).push(args),
    syncTypingHeartbeatsFn: (...args) => (calls.typing ||= []).push(args),
    validateBindingForSendWithRescueFn: async ({ binding }) => ({
      ok: true,
      thread: { id: binding.threadId, cwd: "/repo", archived: 0 },
      binding,
      notice: null,
    }),
  };
}

test("handlePlainText explains missing bindings without touching transport", async () => {
  const replies = [];

  await handlePlainText({
    config: makeConfig(),
    state: { bindings: {} },
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding: null,
    isPrivateTopicMessageFn: () => false,
    replyFn: async (token, message, text) => {
      replies.push({ token, message, text });
      return [{ message_id: 51 }];
    },
    shouldAutoCreatePrivateTopicBindingFn: () => false,
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /No Codex thread is bound here/);
});

test("handlePlainText blocks attachments when the config says they are off", async () => {
  const replies = [];

  await handlePlainText({
    config: makeConfig({ attachmentsEnabled: false }),
    state: { bindings: {} },
    message: makeMessage({ caption: "see this" }),
    bindingKey: "group:-1001:topic:3",
    binding: makeBinding(),
    collectTelegramAttachmentsFn: () => [{ kind: "image", fileId: "file-1" }],
    collectTelegramVoiceRefsFn: () => [],
    getMessageIngressTextFn: () => "see this",
    normalizeInboundPromptFn: (text) => text,
    replyFn: async (token, message, text) => {
      replies.push(text);
      return [{ message_id: 52 }];
    },
  });

  assert.deepEqual(replies, ["Attachments are disabled in this bridge config. Text still works."]);
});

test("handlePlainText starts a send-only native turn and leaves progress for the mirror", async () => {
  const calls = {};
  const state = { bindings: {} };
  const binding = makeBinding();

  await handlePlainText({
    config: makeConfig(),
    state,
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding,
    ...makeSendOnlyDeps(calls),
  });

  assert.equal(state.bindings["group:-1001:topic:3"], binding);
  assert.equal(binding.currentTurn.sendOnly, true);
  assert.equal(binding.currentTurn.codexProgressMessageId, 50);
  assert.equal(binding.currentTurn.transportPath, "app-control");
  assert.equal(binding.lastTransportPath, "app-control");
  assert.equal(calls.native[0][0].prompt, "do the thing");
  assert.equal(calls.progressStops, 1);
  assert.equal(calls.subscriptions.length, 1);
  assert.equal(calls.typing.length, 1);
  assert.equal(calls.suppressions[0][2], "do the thing");
  assert.equal(calls.events.at(-1)[0], "native_send_deferred_reply");
});

test("handlePlainText replies on the transcript bubble when a voice message was transcribed", async () => {
  const calls = {};
  const replies = [];

  await handlePlainText({
    config: makeConfig({ sendTyping: true }),
    state: { bindings: {} },
    message: makeMessage({ text: "" }),
    bindingKey: "group:-1001:topic:3",
    binding: makeBinding(),
    ...makeSendOnlyDeps(calls),
    chooseVoiceTranscriptionProviderFn: () => ({ provider: "deepgram", model: "nova-3" }),
    collectTelegramVoiceRefsFn: () => [{ kind: "voice", fileId: "voice-1" }],
    formatVoiceTranscriptBubbleFn: () => "«transcribed voice»",
    formatVoiceTranscriptPromptFn: ({ transcripts }) => transcripts[0].text,
    getMessageIngressTextFn: () => "",
    replyFn: async (token, message, text) => {
      replies.push({ message, text });
      return [{ message_id: 70 }];
    },
    sendTypingFn: async (...args) => (calls.sendTyping ||= []).push(args),
    transcribeTelegramVoiceFn: async ({ getFile, downloadFile }) => {
      assert.equal(typeof getFile, "function");
      assert.equal(typeof downloadFile, "function");
      return [{ text: "voice prompt", provider: "deepgram", model: "nova-3" }];
    },
  });

  assert.equal(replies[0].text, "«transcribed voice»");
  assert.equal(calls.replyPlain[0][1].message_id, 70);
  assert.equal(calls.native[0][0].prompt, "voice prompt");
  assert.equal(calls.sendTyping.length, 2);
});

test("handlePlainText turns native send errors into user-facing Telegram text", async () => {
  const calls = {};
  const binding = makeBinding();

  await handlePlainText({
    config: makeConfig(),
    state: { bindings: {} },
    message: makeMessage(),
    bindingKey: "group:-1001:topic:3",
    binding,
    ...makeSendOnlyDeps(calls),
    editThenSendRichTextChunksFn: async (...args) => {
      (calls.edits ||= []).push(args);
      return [{ message_id: 50 }];
    },
    markAppControlCooldownFn: () => null,
    markTransportErrorFn: (targetBinding) => {
      targetBinding.lastTransportErrorKind = "app_control_failed";
    },
    renderNativeSendErrorFn: () => "Codex Desktop is not reachable right now.",
    sendNativeTurnFn: async () => {
      throw new Error("debug endpoint crashed");
    },
  });

  assert.equal(binding.currentTurn, null);
  assert.equal(binding.lastTransportErrorKind, "app_control_failed");
  assert.equal(calls.edits[0][3], "Codex Desktop is not reachable right now.");
  assert.equal(calls.events.at(-1)[0], "native_send_error");
});
