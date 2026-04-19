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
  assert(plan.commands.some((command) => command.command === "project_status"));
  assert(plan.commands.some((command) => command.command === "sync_project"));
  assert(!plan.commands.some((command) => command.command.includes("-")));
});

test("buildBotInstallPolishOperations creates a compact Bot API operation list", () => {
  const operations = buildBotInstallPolishOperations(buildBotInstallPolishPlan());
  assert.deepEqual(
    operations.map((operation) => operation.name),
    [
      "setMyCommands",
      "setChatMenuButton",
      "setMyShortDescription",
      "setMyDescription",
      "setMyDefaultAdministratorRights",
    ],
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
  assert.equal(result.operations.length, 5);
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
    ["setMyCommands", "setChatMenuButton", "setMyDefaultAdministratorRights"],
  );
});

test("formatBotInstallPolishPlan makes dry-run output readable", () => {
  const text = formatBotInstallPolishPlan(buildBotInstallPolishPlan({ includeProfile: false }));
  assert.match(text, /commands: .*\/sync_project/);
  assert.match(text, /default admin rights:/);
});
