# Runbook

Команды ниже предполагают запуск из repo root.

## Runtime Files

- config: `config.local.json`
- state: `state/state.json`
- project index: `state/bootstrap-result.json`
- user session: `state/anton_user.session`
- bootstrap plan: `admin/bootstrap-plan.json` (ignored runtime file)
- logs: `logs/bridge.stdout.log`, `logs/bridge.stderr.log`
- launchd label: `com.codex.telegram-frontend.bridge` by default
- token Keychain service: `codex-telegram-bridge-bot-token` by default

Useful launchd overrides:

```bash
CODEX_TELEGRAM_LAUNCHD_LABEL=com.example.codex-telegram \
CODEX_TELEGRAM_KEYCHAIN_SERVICE=codex-telegram-bridge-bot-token \
CODEX_TELEGRAM_CONFIG="$PWD/config.local.json" \
./ops/install-launchd.sh
```

## Status / Restart

Self-check without starting the polling loop:

```bash
npm run self-check
```

Install or refresh launchd:

```bash
./ops/install-launchd.sh
```

Preview generated plist without loading it:

```bash
./ops/install-launchd.sh --dry-run > /tmp/codex-telegram-bridge.plist
```

Check launchd:

```bash
LABEL="${CODEX_TELEGRAM_LAUNCHD_LABEL:-com.codex.telegram-frontend.bridge}"
launchctl print "gui/$(id -u)/$LABEL" | rg 'state =|pid =|last exit code'
```

Restart launchd:

```bash
LABEL="${CODEX_TELEGRAM_LAUNCHD_LABEL:-com.codex.telegram-frontend.bridge}"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
```

One-shot bridge poll:

```bash
npm run once
```

## If Something Breaks

1. Make sure `Codex.app` is open.
2. Prefer launching it with `--remote-debugging-port=9222`; otherwise bridge can still try the local app-server fallback.
3. Run `npm run self-check`.
4. Check `logs/bridge.stderr.log`.
5. Check whether `state/state.json -> lastUpdateId` moves.
6. If launchd is alive but stuck, use `launchctl kickstart -k ...`.

If `self-check` says `app-control: fetch failed`, but `app-server: reachable`, that is not fatal.
It means bridge is using fallback transport and some UI-aware behavior may be weaker.

## UX Smoke

1. Send normal text in a bound topic and confirm one progress bubble appears.
2. Confirm the bubble edits in place for longer replies.
3. Confirm the final answer is a reply to the triggering user/surrogate message.
4. Run `/project-status` or `/sync-project dry-run` and confirm long details go to direct chat when possible.
5. Send a short turn directly from Codex Desktop and confirm Telegram receives the surrogate user message plus assistant updates.
6. Confirm each active topic has one pinned compact status bar.

## Bootstrap / Telegram Admin

Generate plan preview from the local Codex DB:

```bash
npm run onboard:scan -- \
  --project-limit 12 \
  --threads-per-project 5
```

Write plan after selecting projects:

```bash
npm run onboard:plan -- \
  --project /path/to/codex-project \
  --threads-per-project 3 \
  --history-max-messages 40 \
  --write
```

Write a disposable rehearsal plan:

```bash
npm run onboard:rehearsal -- \
  --project /path/to/codex-project \
  --write
```

Rehearsal writes `admin/bootstrap-plan.rehearsal.json` by default, uses `Codex Lab - ` group titles and folder `codex-lab`, displays topics as tabs, and keeps the working set intentionally small.

Create or reuse Telegram groups/topics and write bridge bindings:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py bootstrap \
  --plan admin/bootstrap-plan.json
```

`bootstrap` creates or updates the Telegram folder from the plan by default and puts project groups there.
It also forces forum topics to display as `Tabs`; pass `--topic-display list` only for manual debugging.
It merges groups into `state/bootstrap-result.json`; pass `--replace-result` only for an intentional clean rebuild.
Use `--skip-folder` only when debugging folder automation.
Bot username is read from `config.local.json -> botUsername`, `CODEX_TELEGRAM_BOT_USERNAME`, or `--bot-username`.

## Telegram Ops Commands

- `/health` — quick health for the current chat/topic: binding, project mapping, transport endpoints
- `/project-status [count]` — desired thread column, active topics, parked sync topics and sync preview
- `/sync-project [count] dry-run` — safe preview before rename/reopen/create/park

## History Backfill

Preview clean history import:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py backfill-thread \
  --thread-id <codex-thread-id> \
  --chat-id <telegram-chat-id> \
  --topic-id <telegram-topic-id> \
  --max-history-messages 40 \
  --assistant-phase final_answer \
  --sender-mode labeled-bot \
  --dry-run
```

Run without `--dry-run` after checking the preview.

Notes:

- `labeled-bot` is safer for imports: messages are sent as `Anton:` / `Codex:` by the bot and do not loop back as fresh user turns.
- default backfill imports only clean tail: user prompts plus assistant `final_answer`
- commentary, heartbeat/system-like entries and smoke noise are skipped by default
- topic root, pinned status bar and recent live mirror ids from `state/state.json` are protected
- Telegram `retry_after` is respected, so a partial 429 can usually be resumed by rerunning the command

## Topic Cleanup

Safe preview:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py cleanup-topic \
  --chat-id <telegram-chat-id> \
  --topic-id <telegram-topic-id> \
  --scan-limit 120
```

Delete the same candidates:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py cleanup-topic \
  --chat-id <telegram-chat-id> \
  --topic-id <telegram-topic-id> \
  --scan-limit 120 \
  --delete
```

Notes:

- cleanup protects topic root and pinned status bar automatically
- add `--keep-message-id` for extra protected messages
- defaults target service-actions and explicit ops/smoke noise, not real working history

## UX Notes

- user-facing replies render through Telegram HTML parse mode with plain-text fallback
- progress bubble is an honest in-place status update, not true Codex token streaming yet
- outbound mirror sends human-visible `commentary` and `final_answer`, not raw event streams
- Codex Desktop-originated turns first create a bot-side surrogate user message, then assistant replies attach to it
- status bar is one pinned message per active topic and edits only on change
- transport/raw exceptions stay in logs; users get short human messages
- parked sync topics are old working-set snapshots and should not count as active threads

If privacy mode blocks plain-text ingress in group topics, quick fallback:

```text
@your_bot_username your text
```
