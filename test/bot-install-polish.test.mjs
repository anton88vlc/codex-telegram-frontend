import test from "node:test";
import assert from "node:assert/strict";

import {
  applyBotInstallPolish,
  buildBotInstallPolishOperations,
  buildBotInstallPolishPlan,
  formatBotInstallPolishPlan,
} from "../lib/bot-install-polish.mjs";

test("buildBotInstallPolishPlan uses Telegram-menu-safe command names", () => {
  const plan = buildBotInstallPolishPlan();
  assert(plan.commands.some((command) => command.command === "model"));
  assert(plan.commands.some((command) => command.command === "think"));
  assert(plan.commands.some((command) => command.command === "reasoning"));
  assert(plan.commands.some((command) => command.command === "fast"));
  assert(plan.commands.some((command) => command.command === "compact"));
  assert(!plan.commands.some((command) => command.command === "project_status"));
  assert(!plan.commands.some((command) => command.command === "sync_project"));
  assert(!plan.commands.some((command) => command.command.includes("-")));
});

test("buildBotInstallPolishOperations creates a compact Bot API operation list", () => {
  const operations = buildBotInstallPolishOperations(buildBotInstallPolishPlan());
  assert.deepEqual(
    operations.map((operation) => operation.name),
    [
      "setMyCommands",
      "setMyCommands",
      "setMyCommands",
      "setChatMenuButton",
      "setMyShortDescription",
      "setMyDescription",
      "setMyDefaultAdministratorRights",
    ],
  );
  assert.deepEqual(
    operations.filter((operation) => operation.name === "setMyCommands").map((operation) => operation.args.scope?.type || "default"),
    ["default", "all_private_chats", "all_group_chats"],
  );
});

test("applyBotInstallPolish dry-run does not call Telegram", async () => {
  const result = await applyBotInstallPolish("token", buildBotInstallPolishPlan(), {
    dryRun: true,
    telegram: {
      setMyCommands() {
        throw new Error("should not call Telegram in dry-run");
      },
    },
  });
  assert.equal(result.applied, false);
  assert.equal(result.operations.length, 7);
});

test("applyBotInstallPolish applies through injected Telegram helpers", async () => {
  const calls = [];
  const telegram = new Proxy(
    {},
    {
      get(_target, name) {
        return async (_token, args) => {
          calls.push({ name, args });
          return true;
        };
      },
    },
  );
  const result = await applyBotInstallPolish("token", buildBotInstallPolishPlan({ includeProfile: false }), {
    dryRun: false,
    telegram,
  });

  assert.equal(result.applied, true);
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "setMyCommands",
      "setMyCommands",
      "setMyCommands",
      "setChatMenuButton",
      "setMyDefaultAdministratorRights",
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call.name === "setMyCommands").map((call) => call.args.scope?.type || "default"),
    ["default", "all_private_chats", "all_group_chats"],
  );
});

test("formatBotInstallPolishPlan makes dry-run output readable", () => {
  const text = formatBotInstallPolishPlan(buildBotInstallPolishPlan({ includeProfile: false }));
  assert.match(text, /commands \(group chats\): .*\/model/);
  assert.match(text, /commands \(group chats\): .*\/think/);
  assert.match(text, /commands \(group chats\): .*\/fast/);
  assert.match(text, /commands \(group chats\): .*\/compact/);
  assert.match(text, /default admin rights:/);
});
