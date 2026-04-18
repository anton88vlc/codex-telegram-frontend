# Onboarding

The goal is a clean Telegram working set, not a landfill copy of the entire Codex sidebar.

The intended model:

- Telegram folder `codex` = external container
- Telegram group = Codex project
- Telegram topic = Codex thread
- bootstrap plan = explicit choice of projects and threads the user wants in Telegram
- history import = bounded clean tail, only user prompts plus assistant `final_answer`

## Runtime Requirement

The Telegram bridge does not replace Codex Desktop. It gives Telegram a clean remote surface for the local Codex app. Different job, same project.

Current v1 is macOS-first. It can run on another properly prepared Mac. Linux and Windows are not supported yet; if someone gets it working there, excellent, but that is not the contract.

For live work and onboarding smoke tests, `Codex.app` should be open. The best path is launching it with:

```bash
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222
```

That exposes `app-control` on `http://127.0.0.1:9222`. If it is unavailable, the bridge can fall back to the local app-server, but fallback is weaker and should be treated as degraded mode, not the normal product experience.

## Preflight Checklist

Before running the wizard on a fresh machine, make sure these exist. Skip this and the wizard will mostly just discover missing reality for you.

- `Codex.app` is installed and has been opened at least once.
- The local Codex DB exists, usually `~/.codex/state_5.sqlite`.
- `config.local.json` exists and points at the right local paths if defaults do not fit.
- The Telegram bot token is available through env, config or macOS Keychain.
- `admin/.env` contains Telegram `API_ID` and `API_HASH`.
- The user-side Telegram session has been authorized once with `login-qr` or `login-phone`.

The wizard has a checklist, but it cannot create BotFather tokens, Telegram API credentials or a Codex Desktop installation for the user. Those bits stay manual for now.

Run the doctor when in doubt:

```bash
npm run onboard:doctor
```

It is read-only. If it says something is missing, believe it before blaming Telegram.

## What The User Must Do

A little manual setup is unavoidable for now:

1. Create a Telegram bot through BotFather and put the token in env, config, or macOS Keychain.
2. Get `API_ID` and `API_HASH` for the user-side Telegram helper.
3. From the repo root, copy local config and install admin dependencies:

```bash
cp config.example.json config.local.json
cp admin/.env.example admin/.env
python3 -m venv admin/.venv
admin/.venv/bin/pip install -r admin/requirements.txt
```

4. Authorize the user session once:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py login-qr
```

BotFather does not provide a proper public API for fully automated bot creation. Do not pretend this can be scripted cleanly. Everything after that should be as automated as we can make it.

## Recommended Guided Flow

Interactive:

```bash
npm run onboard:wizard
```

Disposable rehearsal:

```bash
npm run onboard:wizard:rehearsal
```

Non-interactive rehearsal plan write:

```bash
npm run onboard:wizard:rehearsal -- \
  --project /path/to/codex-project \
  --write \
  --no-input
```

Side-effect flags are intentionally explicit. Creating Telegram groups is fine; doing it by accident is not.

- `--apply` creates/reuses Telegram groups/topics and writes bridge bindings.
- `--cleanup-dry-run` previews a clean rebuild by listing visible topic messages that would be removed.
- `--cleanup` deletes visible topic messages after running the preview first. This is sharp; use it for intentional rebuilds, not casual tidying.
- `--backfill-dry-run` previews clean history import.
- `--backfill` sends clean history import.
- `--smoke` sends a Telegram smoke prompt and waits for the expected answer.
- `--smoke-timeout-seconds 240` controls how long the wizard waits for a mirrored smoke answer.

The lower-level steps below are still useful when the wizard needs adult supervision.

## Step 1: Scan Codex Projects

Read-only preview from the local Codex DB:

```bash
npm run onboard:scan -- \
  --project-limit 12 \
  --threads-per-project 5
```

JSON mode for a future UI/wizard:

```bash
npm run onboard:scan -- \
  --project-limit 12 \
  --threads-per-project 5 \
  --json
```

Pick projects the user actually wants on the phone. Mirroring everything that ever existed is how a useful frontend becomes notification soup.

## Step 2: Generate Bootstrap Plan

Preview:

```bash
npm run onboard:plan -- \
  --project /path/to/codex-project \
  --project /path/to/another-project \
  --threads-per-project 3 \
  --history-max-messages 40
```

Write `admin/bootstrap-plan.json`:

```bash
npm run onboard:plan -- \
  --project /path/to/codex-project \
  --project /path/to/another-project \
  --threads-per-project 3 \
  --history-max-messages 40 \
  --write
```

Rehearsal preview for a disposable Telegram surface:

```bash
npm run onboard:rehearsal -- \
  --project /path/to/codex-project
```

Rehearsal defaults are intentionally small: 2 projects, 2 threads per project, last 20 clean history messages, group prefix `Codex Lab - `, folder `codex-lab`, output `admin/bootstrap-plan.rehearsal.json`.
Use rehearsal before deleting or rebuilding the real `codex` surface. Future you will appreciate this small act of mercy.

Clean rebuild path:

```bash
npm run onboard:wizard:rehearsal -- \
  --project /path/to/codex-project \
  --write \
  --apply \
  --cleanup-dry-run \
  --backfill-dry-run
```

If the preview is sane, replace `--cleanup-dry-run` with `--cleanup` and `--backfill-dry-run` with `--backfill`. Do not skip rehearsal unless you enjoy archaeology.

## Step 3: Create Telegram Surface

```bash
admin/.venv/bin/python admin/telegram_user_admin.py bootstrap \
  --plan admin/bootstrap-plan.json
```

This creates or reuses groups/topics from the plan and writes bridge bindings.
By default it also creates or updates the Telegram folder from the plan, usually `codex`, and puts the project groups there.
Forum topics are forced to display as `Tabs` by default because that maps better to Codex's project/thread column.
Use `--topic-display list` only when you explicitly want Telegram's list-style topic view.
Bootstrap merges groups into `state/bootstrap-result.json` instead of replacing unrelated groups, so rehearsal does not wipe the real project index.
Use `--replace-result` only for an intentional clean rebuild.
Use `--skip-folder` only when debugging Telegram folder behavior.
Bot username is read from `config.local.json -> botUsername`, `CODEX_TELEGRAM_BOT_USERNAME`, or `--bot-username`.

For rehearsal apply, use the rehearsal plan explicitly:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py bootstrap \
  --plan admin/bootstrap-plan.rehearsal.json
```

## Step 4: Clean History Backfill

Run dry-run first:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py backfill-thread \
  --thread-id <thread-id> \
  --chat-id <telegram-chat-id> \
  --topic-id <topic-id> \
  --max-history-messages 40 \
  --assistant-phase final_answer \
  --sender-mode labeled-bot \
  --dry-run
```

Then run without `--dry-run` only after the preview looks sane.

Defaults intentionally skip commentary, heartbeat/system-like entries, Codex app directives, memory citations and smoke noise. If a future user wants more, make it configurable, not the default firehose.
Backfill renders through the same Telegram HTML renderer as the live bridge by default (`--render-mode html`), so imported history should not show raw `**bold**`/markdown syntax.
Use `--render-mode plain` only for debugging parser issues.

If a freshly reserved status bar exists but Telegram Desktop does not show the pinned banner, re-pin it through the user-side helper:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py pin-message \
  --chat-id <telegram-chat-id> \
  --message-id <status-bar-message-id> \
  --silent
```

## Step 5: Verify

```bash
npm run self-check
```

Expected UX:

- active topics have a pinned compact status bar
- user prompts from Codex Desktop appear as bot-side surrogate messages
- assistant progress appears as one editable message with recent visible updates
- final assistant replies attach to the surrogate user message
- Telegram-originated prompts get one editable progress bubble and a final reply
- `/project-status` and `/sync-project dry-run` do not flood working topics with ops walls

## Recommended Defaults

- `threads-per-project`: 3
- `history-max-messages`: 40
- `assistant-phase`: `final_answer`
- `sender-mode`: `labeled-bot`
- auto-create new topics: off by default until rules are explicit
- Telegram frontend copy: English-first; mirrored user prompts and final answers keep the original thread language

This keeps Telegram feeling like a credible remote Codex surface, not a database dump wearing a chat costume.
