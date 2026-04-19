import test from "node:test";
import assert from "node:assert/strict";

import { rerouteUnboundGroupMessageToFallbackTopic } from "../lib/unbound-group-rescue.mjs";

const config = {
  botToken: "token",
  unboundGroupFallbackMaxAgeMs: 60_000,
};

const message = {
  chat: { id: -1001, type: "supergroup" },
  message_id: 10,
  message_thread_id: 1,
  from: { first_name: "Anton" },
};

test("rerouteUnboundGroupMessageToFallbackTopic does nothing when disabled", async () => {
  let lookedUp = false;
  const result = await rerouteUnboundGroupMessageToFallbackTopic({
    config: { ...config, unboundGroupFallbackEnabled: false },
    state: {},
    message,
    promptText: "test",
    findFallbackTopicBindingForUnboundGroupMessageFn: () => {
      lookedUp = true;
    },
  });

  assert.equal(result, null);
  assert.equal(lookedUp, false);
});

test("rerouteUnboundGroupMessageToFallbackTopic copies the prompt into the active topic", async () => {
  const binding = {
    chatId: "-1001",
    messageThreadId: 3,
    threadId: "thread-1",
  };
  const state = { bindings: {} };
  const sentCalls = [];
  const events = [];
  const remembered = [];

  const result = await rerouteUnboundGroupMessageToFallbackTopic({
    config,
    state,
    message,
    promptText: "проверь",
    attachmentRefs: [{}],
    voiceRefs: [{}, {}],
    findFallbackTopicBindingForUnboundGroupMessageFn: (targetState, targetMessage, options) => {
      assert.equal(targetState, state);
      assert.equal(targetMessage, message);
      assert.deepEqual(options, { maxAgeMs: 60_000 });
      return {
        bindingKey: "group:-1001:topic:3",
        binding,
        activityMs: Date.parse("2026-04-19T12:00:00.000Z"),
      };
    },
    buildTargetFromBindingFn: (targetBinding) => ({
      chatId: targetBinding.chatId,
      messageThreadId: targetBinding.messageThreadId,
    }),
    formatUnboundGroupFallbackBubbleFn: ({ promptText, attachmentRefs, voiceRefs }) =>
      `bubble: ${promptText}; media ${attachmentRefs.length}; voice ${voiceRefs.length}`,
    sendRichTextChunksFn: async (token, target, text) => {
      sentCalls.push({ token, target, text });
      return [{ message_id: 55 }];
    },
    rememberOutboundFn: (...args) => remembered.push(args),
    logEventFn: (...args) => events.push(args),
    nowFn: () => "2026-04-19T12:30:00.000Z",
  });

  assert.equal(result.bindingKey, "group:-1001:topic:3");
  assert.equal(result.binding, binding);
  assert.equal(result.message.message_id, 55);
  assert.equal(result.message.message_thread_id, 3);
  assert.deepEqual(result.message.routedFromMessage, {
    chatId: "-1001",
    messageThreadId: 1,
    messageId: 10,
  });
  assert.deepEqual(sentCalls[0], {
    token: "token",
    target: { chatId: "-1001", messageThreadId: 3 },
    text: "bubble: проверь; media 1; voice 2",
  });
  assert.equal(state.bindings["group:-1001:topic:3"].lastUnboundFallbackAt, "2026-04-19T12:30:00.000Z");
  assert.equal(remembered[0][0], binding);
  assert.deepEqual(remembered[0][1], [{ message_id: 55 }]);
  assert.equal(events[0][0], "unbound_group_message_rerouted");
  assert.equal(events[0][1].toMessageId, 55);
});
