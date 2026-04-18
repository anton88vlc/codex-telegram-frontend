#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
DRY_RUN=0

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

LABEL="${CODEX_TELEGRAM_LAUNCHD_LABEL:-com.codex.telegram-frontend.bridge}"
KEYCHAIN_SERVICE="${CODEX_TELEGRAM_KEYCHAIN_SERVICE:-codex-telegram-bridge-bot-token}"
CONFIG_PATH="${CODEX_TELEGRAM_CONFIG:-$REPO/config.local.json}"
NODE_BIN="${CODEX_TELEGRAM_NODE:-$(command -v node || true)}"
if [ "$DRY_RUN" -eq 1 ]; then
  PLIST_DST="${CODEX_TELEGRAM_PLIST_OUT:-/dev/stdout}"
else
  PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
fi

if [ -z "$NODE_BIN" ]; then
  echo "node not found; set CODEX_TELEGRAM_NODE=/path/to/node" >&2
  exit 127
fi

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$REPO/logs" "$REPO/state" "$HOME/Library/LaunchAgents"
fi

cat > "$PLIST_DST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>TOKEN=&quot;\$(/usr/bin/security find-generic-password -s &quot;\$CODEX_TELEGRAM_KEYCHAIN_SERVICE&quot; -w 2&gt;/dev/null)&quot; || { echo &quot;Missing Keychain item: \$CODEX_TELEGRAM_KEYCHAIN_SERVICE&quot; 1&gt;&amp;2; exit 78; }; export CODEX_TELEGRAM_BOT_TOKEN=&quot;\$TOKEN&quot;; exec &quot;\$0&quot; &quot;\$1&quot; --config &quot;\$2&quot;</string>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$REPO/bridge.mjs")</string>
    <string>$(xml_escape "$CONFIG_PATH")</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>CODEX_TELEGRAM_KEYCHAIN_SERVICE</key>
    <string>$(xml_escape "$KEYCHAIN_SERVICE")</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO")</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>ProcessType</key>
  <string>Background</string>

  <key>StandardOutPath</key>
  <string>$(xml_escape "$REPO/logs/bridge.stdout.log")</string>

  <key>StandardErrorPath</key>
  <string>$(xml_escape "$REPO/logs/bridge.stderr.log")</string>
</dict>
</plist>
EOF

if [ "$DRY_RUN" -eq 1 ]; then
  exit 0
fi

launchctl unload "$PLIST_DST" >/dev/null 2>&1 || true
launchctl load "$PLIST_DST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
launchctl print "gui/$(id -u)/$LABEL" | rg 'state =|pid =|last exit code'
