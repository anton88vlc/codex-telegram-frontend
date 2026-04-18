#!/bin/sh
set -eu

REPO="/Users/antonnaumov/code/codex-telegram-frontend"
PLIST_SRC="$REPO/ops/com.antonnaumov.codex.telegram-bridge.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.antonnaumov.codex.telegram-bridge.plist"

mkdir -p "$REPO/logs" "$REPO/state"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl unload "$PLIST_DST" >/dev/null 2>&1 || true
launchctl load "$PLIST_DST"
launchctl kickstart -k "gui/$(id -u)/com.antonnaumov.codex.telegram-bridge"
launchctl print "gui/$(id -u)/com.antonnaumov.codex.telegram-bridge" | rg 'state =|pid =|last exit code'
