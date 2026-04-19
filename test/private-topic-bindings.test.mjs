import test from "node:test";
import assert from "node:assert/strict";

import {
  getPrivateTopicTitleStore,
  isGenericPrivateTopicTitle,
  makePrivateTopicChatTitle,
  rememberPrivateTopicTitle,
  shouldAutoCreatePrivateTopicBinding,
} from "../lib/private-topic-bindings.mjs";

test("private topic title store is initialized lazily", () => {
  const state = {};
  const store = getPrivateTopicTitleStore(state);
  assert.deepEqual(store, {});
  assert.equal(state.privateTopicTitles, store);
});

test("generic private topic titles are detected across common client defaults", () => {
  assert.equal(isGenericPrivateTopicTitle("New Thread"), true);
  assert.equal(isGenericPrivateTopicTitle("новая тема"), true);
  assert.equal(isGenericPrivateTopicTitle("Nuevo Tema"), true);
  assert.equal(isGenericPrivateTopicTitle("Morning scenarios"), false);
});

test("rememberPrivateTopicTitle stores service-created private topic names", () => {
  const state = {};
  assert.equal(
    rememberPrivateTopicTitle(state, {
      chat: { id: 123, type: "private" },
      message_thread_id: 55,
      message_id: 7,
      forum_topic_created: { name: "Morning scenarios" },
    }),
    true,
  );
  assert.equal(state.privateTopicTitles["group:123:topic:55"].title, "Morning scenarios");
  assert.equal(state.privateTopicTitles["group:123:topic:55"].messageId, 7);
});

test("makePrivateTopicChatTitle prefers remembered and service titles over generic fallbacks", () => {
  const bindingKey = "group:123:topic:55";
  assert.equal(
    makePrivateTopicChatTitle({
      state: { privateTopicTitles: { [bindingKey]: { title: "Morning scenarios" } } },
      bindingKey,
      message: { reply_to_message: { forum_topic_created: { name: "Ignored" } } },
    }),
    "Morning scenarios",
  );
  assert.equal(
    makePrivateTopicChatTitle({
      state: { privateTopicTitles: { [bindingKey]: { title: "New Thread" } } },
      bindingKey,
      message: { reply_to_message: { forum_topic_created: { name: "Research notes" } } },
    }),
    "Research notes",
  );
  assert.equal(
    makePrivateTopicChatTitle({
      state: {},
      bindingKey,
      message: { reply_to_message: { forum_topic_created: { name: "New Topic" } } },
    }),
    "New Codex Chat",
  );
});

test("shouldAutoCreatePrivateTopicBinding gates private topic bootstrap", () => {
  const message = { chat: { type: "private" }, message_thread_id: 55 };
  assert.equal(shouldAutoCreatePrivateTopicBinding({ config: {}, message, binding: null }), true);
  assert.equal(shouldAutoCreatePrivateTopicBinding({ config: { privateTopicAutoCreateChats: false }, message, binding: null }), false);
  assert.equal(shouldAutoCreatePrivateTopicBinding({ config: {}, message, binding: { threadId: "t1" } }), false);
  assert.equal(
    shouldAutoCreatePrivateTopicBinding({
      config: {},
      message: { chat: { type: "supergroup" }, message_thread_id: 55 },
      binding: null,
    }),
    false,
  );
});
