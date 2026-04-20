import {
  setChatMenuButton,
  setMyCommands,
  setMyDefaultAdministratorRights,
  setMyDescription,
  setMyShortDescription,
} from "./telegram.mjs";

export const DEFAULT_BOT_COMMANDS = [
  { command: "start", description: "Show setup help" },
  { command: "help", description: "Show bridge commands" },
  { command: "status", description: "Show current thread binding" },
  { command: "health", description: "Check bridge and transport health" },
  { command: "settings", description: "Show safe runtime settings" },
  { command: "queue", description: "Show queued prompts for this topic" },
  { command: "pause", description: "Pause this topic queue" },
  { command: "resume", description: "Resume this topic queue" },
  { command: "cancel_queue", description: "Clear this topic queue" },
  { command: "steer", description: "Guide the current running Codex turn" },
  { command: "attach_latest", description: "Bind topic to the newest Codex thread" },
  { command: "detach", description: "Remove the current binding" },
  { command: "project_status", description: "Preview this project's Telegram working set" },
  { command: "sync_project", description: "Sync project topics to the working set" },
  { command: "mode_native", description: "Use the Codex Desktop transport" },
];

export const DEFAULT_BOT_SHORT_DESCRIPTION = "A clean Telegram frontend for your local Codex Desktop working set.";

export const DEFAULT_BOT_DESCRIPTION = [
  "Codex Telegram Frontend mirrors a small, intentional Codex Desktop working set into Telegram.",
  "One group maps to one project. One topic maps to one Codex thread. Ops noise stays out of the way.",
].join("\n");

export const DEFAULT_BOT_DEFAULT_ADMINISTRATOR_RIGHTS = {
  can_manage_chat: true,
  can_delete_messages: true,
  can_manage_topics: true,
  can_pin_messages: true,
  can_invite_users: true,
};

export function buildBotInstallPolishPlan({
  includeCommands = true,
  includeProfile = true,
  includeMenuButton = true,
  includeDefaultAdminRights = true,
} = {}) {
  return {
    commands: includeCommands ? DEFAULT_BOT_COMMANDS : null,
    shortDescription: includeProfile ? DEFAULT_BOT_SHORT_DESCRIPTION : null,
    description: includeProfile ? DEFAULT_BOT_DESCRIPTION : null,
    menuButton: includeMenuButton ? { type: "commands" } : null,
    defaultAdministratorRights: includeDefaultAdminRights ? DEFAULT_BOT_DEFAULT_ADMINISTRATOR_RIGHTS : null,
  };
}

export function buildBotInstallPolishOperations(plan) {
  const operations = [];
  if (plan.commands?.length) {
    operations.push({
      name: "setMyCommands",
      args: { commands: plan.commands },
    });
  }
  if (plan.menuButton) {
    operations.push({
      name: "setChatMenuButton",
      args: { menuButton: plan.menuButton },
    });
  }
  if (plan.shortDescription) {
    operations.push({
      name: "setMyShortDescription",
      args: { shortDescription: plan.shortDescription },
    });
  }
  if (plan.description) {
    operations.push({
      name: "setMyDescription",
      args: { description: plan.description },
    });
  }
  if (plan.defaultAdministratorRights) {
    operations.push({
      name: "setMyDefaultAdministratorRights",
      args: { rights: plan.defaultAdministratorRights },
    });
  }
  return operations;
}

const DEFAULT_TELEGRAM_CLIENT = {
  setMyCommands,
  setChatMenuButton,
  setMyShortDescription,
  setMyDescription,
  setMyDefaultAdministratorRights,
};

export async function applyBotInstallPolish(token, plan, { dryRun = true, telegram = DEFAULT_TELEGRAM_CLIENT } = {}) {
  const operations = buildBotInstallPolishOperations(plan);
  if (dryRun) {
    return {
      applied: false,
      operations: operations.map((operation) => ({ name: operation.name, args: operation.args })),
    };
  }

  const results = [];
  for (const operation of operations) {
    const fn = telegram[operation.name];
    if (typeof fn !== "function") {
      throw new Error(`missing Telegram helper for ${operation.name}`);
    }
    results.push({
      name: operation.name,
      result: await fn(token, operation.args),
    });
  }
  return {
    applied: true,
    operations: results,
  };
}

export function formatBotInstallPolishPlan(plan) {
  const lines = ["Bot install polish plan"];
  const operations = buildBotInstallPolishOperations(plan);
  for (const operation of operations) {
    if (operation.name === "setMyCommands") {
      lines.push(`- commands: ${operation.args.commands.map((item) => `/${item.command}`).join(", ")}`);
    } else if (operation.name === "setMyDefaultAdministratorRights") {
      const rights = Object.entries(operation.args.rights)
        .filter(([, value]) => value === true)
        .map(([key]) => key)
        .join(", ");
      lines.push(`- default admin rights: ${rights}`);
    } else if (operation.name === "setChatMenuButton") {
      lines.push("- menu button: commands");
    } else if (operation.name === "setMyShortDescription") {
      lines.push("- short description");
    } else if (operation.name === "setMyDescription") {
      lines.push("- profile description");
    }
  }
  if (!operations.length) {
    lines.push("- nothing selected");
  }
  return lines.join("\n");
}
