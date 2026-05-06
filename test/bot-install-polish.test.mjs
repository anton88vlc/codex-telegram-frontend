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
  assert(plan.commands.some((command) => command.command === "cancel"));
  assert(plan.commands.some((command) => command.command === "interrupt"));
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

test("buildBotInstallPolishOperations can target only the bot avatar", () => {
  const operations = buildBotInstallPolishOperations(
    buildBotInstallPolishPlan({
      includeCommands: false,
      includeProfile: false,
      includeMenuButton: false,
      includeDefaultAdminRights: false,
      includeAvatar: true,
      avatarPath: "/tmp/bot-avatar.jpg",
    }),
  );

  assert.deepEqual(
    operations.map((operation) => operation.name),
    ["setMyProfilePhoto"],
  );
  assert.equal(operations[0].args.photoPath, "/tmp/bot-avatar.jpg");
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

test("applyBotInstallPolish applies avatar through the official Bot API helper", async () => {
  const calls = [];
  const result = await applyBotInstallPolish(
    "token",
    buildBotInstallPolishPlan({
      includeCommands: false,
      includeProfile: false,
      includeMenuButton: false,
      includeDefaultAdminRights: false,
      includeAvatar: true,
      avatarPath: "/tmp/bot-avatar.jpg",
    }),
    {
      dryRun: false,
      telegram: {
        async setMyProfilePhoto(_token, args) {
          calls.push(args);
          return true;
        },
      },
    },
  );

  assert.equal(result.applied, true);
  assert.deepEqual(calls, [{ photoPath: "/tmp/bot-avatar.jpg" }]);
});

test("formatBotInstallPolishPlan makes dry-run output readable", () => {
  const text = formatBotInstallPolishPlan(buildBotInstallPolishPlan({ includeProfile: false }));
  assert.match(text, /commands \(group chats\): .*\/model/);
  assert.match(text, /commands \(group chats\): .*\/think/);
  assert.match(text, /commands \(group chats\): .*\/fast/);
  assert.match(text, /commands \(group chats\): .*\/compact/);
  assert.match(text, /default admin rights:/);
});

test("formatBotInstallPolishPlan shows avatar-only dry runs", () => {
  const text = formatBotInstallPolishPlan(
    buildBotInstallPolishPlan({
      includeCommands: false,
      includeProfile: false,
      includeMenuButton: false,
      includeDefaultAdminRights: false,
      includeAvatar: true,
      avatarPath: "/tmp/bot-avatar.jpg",
    }),
  );

  assert.match(text, /profile photo: \/tmp\/bot-avatar\.jpg/);
});
