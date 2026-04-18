# Codex App Telegram Frontend

Telegram as a fast remote frontend for a local `Codex Desktop` app on macOS.

This is not "one more bot". The intended shape is a clean bridge:

- `Telegram folder codex` = external container / shell
- `Telegram group` = Codex project
- `Telegram topic list inside a group` = mobile version of the Codex project thread column
- `Telegram topic` = Codex thread
- a small number of direct chats = projectless / global / ops surface
- `Codex Desktop` stays the backend and source of truth
- the bridge lives outside `~/.codex` as a normal project

## What Works

- Telegram Bot API long polling
- direct chats and forum topics
- `/attach`, `/attach-latest`, `/detach`, `/status`, `/health`, `/project-status`, `/sync-project`, `/mode native`
- native send through renderer-aware `app-control -> threads.send_message`, with local `app-server` fallback when Codex is not launched with a debug port
- in-place progress bubble in Telegram: one receipt message is edited while Codex works
- reply-style answers to the triggering Telegram message
- Telegram HTML rendering for `**bold**`, `_italic_` / `*italic*`, quotes, lists, code, spoilers and links, with plain-text fallback
- short human-facing errors in chat, technical details in logs
- noisy ops commands can be routed to direct chat with the bot to keep work topics clean
- mention-aware ingress (`@bot your request`) when group privacy blocks plain text
- `sync-project dry-run` and CLI `--self-check`
- npm scripts for running, self-checks, tests and guided onboarding
- onboarding wizard with interactive project/thread selection, checklist, plan write, optional bootstrap, clean backfill dry-run/send and Telegram smoke
- `/project-status` shows desired thread column, active topics, parked sync topics and sync preview
- `/sync-project` can rename/reopen/create/park sync-managed topics for the current working set
- user-side history backfill from `rollout_path` into Telegram topics via `admin/telegram_user_admin.py backfill-thread`; defaults to user prompts plus assistant `final_answer`, with a bounded clean history tail
- backfill uses the same Markdown-to-Telegram HTML renderer as the live bridge
- safe topic cleanup via `admin/telegram_user_admin.py cleanup-topic`: dry-run first, deletion only with `--delete`
- bootstrap can create/update a Telegram folder, create project groups and put them into that folder
- retry on temporary Telegram fetch errors
- inbound update checkpointing to avoid duplicate turns after restart
- live outbound mirror: Codex Desktop user-turn surrogate and final answers are mirrored into the bound Telegram topic/chat
- Codex-originated commentary is folded into one editable English progress message by default; `outboundProgressMode: "verbatim"` is available for raw commentary
- pinned compact status bar in active topics with model/reasoning/context/rate/activity data
- persisted outbound checkpoint and suppression layer to avoid duplicating bridge-originated replies
- Telethon-based user-side Telegram admin helper for groups, topics and bot-admin permissions

## Not Yet

- true token streaming from Codex UI
- attachments, images and voice/audio ingress
- auto-create topic rules for new threads
- heartbeat transport as a separate UI-visible mode

## Files

- [bridge.mjs](bridge.mjs) - main polling bridge
- [lib/telegram.mjs](lib/telegram.mjs) - Telegram transport
- [lib/codex-native.mjs](lib/codex-native.mjs) - native Codex send wrapper
- [scripts/send_via_app_control.js](scripts/send_via_app_control.js) - renderer-aware send through Codex app-control
- [scripts/send_via_app_server.js](scripts/send_via_app_server.js) - fallback transport through local Codex app-server
- [scripts/onboard.mjs](scripts/onboard.mjs) - onboarding scan/plan/wizard generator from the local Codex DB
- [admin/telegram_user_admin.py](admin/telegram_user_admin.py) - user-side bootstrap/admin helper for Telegram groups and topics
- [docs/ONBOARDING.md](docs/ONBOARDING.md) - recommended setup flow for a new user
- [docs/RUNBOOK.md](docs/RUNBOOK.md) - ops runbook
- [BACKLOG.md](BACKLOG.md) - product and UX backlog

## Runtime Files

These are repo-local runtime files and are ignored by git:

- `config.local.json`
- `state/state.json`
- `state/bootstrap-result.json`
- `state/anton_user.session`
- `logs/*`
- `admin/.env`
- `admin/bootstrap-plan.json`
- `admin/bootstrap-plan.rehearsal.json`

## Run

Prepare local config and admin dependencies:

```bash
cp config.example.json config.local.json
cp admin/.env.example admin/.env
python3 -m venv admin/.venv
admin/.venv/bin/pip install -r admin/requirements.txt
```

Launch `Codex.app` with a debug port:

```bash
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222
```

Start the bridge:

```bash
npm start
```

One-shot self-check:

```bash
npm run self-check
```

Local checks before committing:

```bash
npm run check
```

## launchd

Install or refresh the launchd agent:

```bash
./ops/install-launchd.sh
```

## Telegram Model

- Telegram folder `codex` is the external container for the remote frontend.
- One Telegram group maps to one Codex project.
- Forum topics are enabled inside each group, and the topic list should feel like the Codex project thread column.
- One Telegram topic maps to one Codex thread.
- Topics should represent a curated working set, not every historical thread.
- Direct chat with the bot is for projectless/global/ops work, and should stay rare.

That is the right v1. Mirroring the whole sidebar blindly turns the product into a landfill with push notifications.

## Onboarding Wizard

Interactive guided flow:

```bash
npm run onboard:wizard
```

Disposable rehearsal surface:

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

Optional side-effect flags:

- `--apply` creates/reuses Telegram groups/topics and writes bindings.
- `--backfill-dry-run` previews clean history import.
- `--backfill` sends clean history import.
- `--smoke` sends a Telegram smoke prompt and waits for the expected answer.
- `--smoke-timeout-seconds 240` controls how long the wizard waits for a mirrored smoke answer.

## Onboarding Preview Commands

Inspect projects and recent threads from the local Codex DB:

```bash
npm run onboard:scan -- \
  --project-limit 12 \
  --threads-per-project 5
```

Generate a bootstrap plan for selected projects:

```bash
npm run onboard:plan -- \
  --project /path/to/codex-project \
  --threads-per-project 3
```

Create a disposable rehearsal surface:

```bash
npm run onboard:rehearsal -- \
  --project /path/to/codex-project
```

Writing `admin/bootstrap-plan.json` requires `--write`.
Rehearsal writes to ignored `admin/bootstrap-plan.rehearsal.json`.
New and reused forum groups default to topic display `Tabs`.
`bootstrap` merges groups into `state/bootstrap-result.json`, so rehearsal does not wipe the normal `codex` surface.
See [admin/bootstrap-plan.example.json](admin/bootstrap-plan.example.json) for structure.
See [docs/ONBOARDING.md](docs/ONBOARDING.md) for the full flow.

## Ops Notes

- The bot token can come from env, config, or macOS Keychain service `codex-telegram-bridge-bot-token`.
- If `app-control` is unavailable, the bridge can still use fallback `app-server`.
- The outbound mirror reads the bound thread `rollout_path`; user surrogates, generic progress and final answers appear in Telegram without manual backfill.
- Clean history import should not dump an infinite thread: `backfill-thread` defaults to the last 40 clean messages and supports `--max-history-messages`, `--max-user-prompts`, `--assistant-phase final_answer`.
- If plain text in a group topic does not reach the bot, the quickest fallback is `@your_bot_username your request`; the real fix is usually BotFather privacy mode.
- Long ops replies like `/project-status` and `/sync-project` are routed to direct chat when possible, leaving only a short trace in the working topic.
- Parked sync topics are not active working-set topics and should not interfere with `/attach-latest` or the next sync preview.
