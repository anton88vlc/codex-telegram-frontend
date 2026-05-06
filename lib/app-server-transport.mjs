import { normalizeText } from "./message-routing.mjs";

const DEFAULT_APP_SERVER_COMMAND = "codex";
const DEFAULT_APP_SERVER_ARGS = ["app-server"];

export function normalizeAppServerTransport(value, { url = null } = {}) {
  const normalized = normalizeText(value).toLowerCase();
  if (["websocket", "ws"].includes(normalized)) return "websocket";
  if (["stdio", "process"].includes(normalized)) return "stdio";
  if (["unix", "socket"].includes(normalized)) return "unix";
  if (normalized === "off" || normalized === "disabled") return "off";
  if (normalized === "auto" || !normalized) {
    const text = normalizeText(url);
    if (text.startsWith("unix://")) return "unix";
    if (text.startsWith("ws://") || text.startsWith("wss://")) return "websocket";
    return "stdio";
  }
  return normalized;
}

export function hasAppServerTransport(config = {}) {
  const hasExplicitConfig =
    Object.prototype.hasOwnProperty.call(config, "appServerTransport") ||
    Object.prototype.hasOwnProperty.call(config, "appServerUrl") ||
    Object.prototype.hasOwnProperty.call(config, "appServerCommand") ||
    Object.prototype.hasOwnProperty.call(config, "appServerSocketPath");
  if (!hasExplicitConfig) {
    return false;
  }
  return normalizeAppServerTransport(config.appServerTransport, { url: config.appServerUrl }) !== "off";
}

export function appServerTransportLabel(config = {}) {
  const transport = normalizeAppServerTransport(config.appServerTransport, { url: config.appServerUrl });
  if (transport === "websocket") return normalizeText(config.appServerUrl) || "websocket";
  if (transport === "unix") return normalizeText(config.appServerSocketPath || config.appServerUrl) || "unix";
  if (transport === "stdio") {
    const command = normalizeText(config.appServerCommand) || DEFAULT_APP_SERVER_COMMAND;
    const args = Array.isArray(config.appServerArgs) && config.appServerArgs.length > 0 ? config.appServerArgs : DEFAULT_APP_SERVER_ARGS;
    return `${command} ${args.join(" ")}`;
  }
  return transport || "off";
}

export function appServerClientOptions(config = {}, overrides = {}) {
  const transport = normalizeAppServerTransport(config.appServerTransport, { url: config.appServerUrl });
  if (transport === "off") {
    return null;
  }

  const options = {
    transport,
    ...overrides,
  };

  if (transport === "websocket") {
    options.url = normalizeText(config.appServerUrl);
  } else if (transport === "unix") {
    options.url = normalizeText(config.appServerUrl);
    options.socketPath = normalizeText(config.appServerSocketPath);
  } else if (transport === "stdio") {
    options.command = normalizeText(config.appServerCommand) || DEFAULT_APP_SERVER_COMMAND;
    options.args =
      Array.isArray(config.appServerArgs) && config.appServerArgs.length > 0
        ? config.appServerArgs.map(String)
        : DEFAULT_APP_SERVER_ARGS;
    options.cwd = normalizeText(config.appServerCwd) || process.cwd();
    options.env = config.appServerEnv && typeof config.appServerEnv === "object" ? config.appServerEnv : {};
  }

  return options;
}
