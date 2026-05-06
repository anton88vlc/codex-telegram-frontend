#!/usr/bin/env node

import process from "node:process";

import { DEFAULT_CONFIG_PATH, loadConfig } from "../lib/config.mjs";
import { configureBridgeEventLog } from "../lib/bridge-events.mjs";
import { rememberOutbound } from "../lib/outbound-memory.mjs";
import { syncOutboundMirrors } from "../lib/outbound-mirror-runner.mjs";
import { refreshStatusBars } from "../lib/status-bar-runner.mjs";
import { loadState, saveStateMerged as saveState } from "../lib/state.mjs";
import { captureWorktreeBaseline, loadChangedFilesTextForThread } from "../lib/worktree-summary.mjs";

function fail(message, extra = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, ...extra }, null, 2)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    configPath: DEFAULT_CONFIG_PATH,
    bindingKey: null,
    statusBar: true,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    switch (arg) {
      case "--config":
        out.configPath = argv[++idx];
        break;
      case "--binding-key":
        out.bindingKey = argv[++idx];
        break;
      case "--no-status-bar":
        out.statusBar = false;
        break;
      default:
        fail(`unknown argument: ${arg}`, { argv });
    }
  }
  if (!out.bindingKey) {
    fail("missing --binding-key");
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = await loadConfig(args.configPath);
configureBridgeEventLog(config);
const state = await loadState(config.statePath);

if (!state.bindings?.[args.bindingKey]) {
  fail("binding not found", { bindingKey: args.bindingKey });
}

const mirrorResult = await syncOutboundMirrors({
  config,
  state,
  onlyBindingKey: args.bindingKey,
  loadChangedFilesTextForThreadFn: loadChangedFilesTextForThread,
  captureWorktreeBaselineFn: captureWorktreeBaseline,
  rememberOutboundFn: rememberOutbound,
});

let statusBarResult = { changed: false, updated: 0 };
if (args.statusBar) {
  statusBarResult = await refreshStatusBars({
    config,
    state,
    onlyBindingKey: args.bindingKey,
  });
}

if (mirrorResult.changed || statusBarResult.changed) {
  await saveState(config.statePath, state);
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      bindingKey: args.bindingKey,
      mirror: mirrorResult,
      statusBar: statusBarResult,
    },
    null,
    2,
  )}\n`,
);
