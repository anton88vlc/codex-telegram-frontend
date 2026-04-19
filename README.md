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

## Install With Codex

The intended install path is agent-led: open this repo in Codex, paste one prompt, and let Codex do the boring setup work while you handle the few Telegram steps that cannot be automated cleanly.

> **Current v1 target:** macOS with local `Codex.app`. Linux and Windows are not the contract yet.

Paste this into a fresh Codex thread from the repo root:

```text
Install codex-telegram-frontend on this Mac.

Run the onboarding doctor, prepare local config from examples, guide me through the unavoidable Telegram steps, then scan my Codex projects and ask me which projects and threads I want mirrored into Telegram.

Create or reuse the Telegram folder `codex`, create one group per selected Codex project, create one topic per selected Codex thread, import only a clean bounded history tail, start the bridge, run a real Telegram smoke test, and leave the repo in a clean documented state.

Do not mirror every thread. Keep Telegram as a clean remote Codex working set, not a landfill.
```

What you may still need to do manually:

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) if you do not already have one. Codex will tell you when to paste the token and will choose the local storage path.
2. Create or reuse Telegram app credentials from [my.telegram.org](https://my.telegram.org/) if the admin helper needs them. In a good run, Codex handles the local `.env` wiring and you only paste the values when asked.
3. Authorize one local Telegram user session when Codex asks; this is what lets the helper create folders, groups and topics as your Telegram user.
4. Keep `Codex.app` available. For the best UX, let Codex launch it with `npm run codex:launch`.

After that, the wizard can create/reuse the Telegram folder, project groups, thread topics, bindings, status bars, clean history backfill and smoke checks. BotFather has no proper public API, so pretending the bot itself can be created magically would be cute and false.

Optional but nice: once the token is wired, Codex can polish the bot command menu, short description, menu button and suggested admin rights with `npm run bot:polish -- --apply`. Dry-run is the default, because Telegram setup commands should not surprise anyone.

## Runtime Boundary

Frontend, not a standalone Codex brain. The Mac still does the real work.

- For real work in v1, keep `Codex.app` open on the Mac.
- Preferred transport is `app-control` at `http://127.0.0.1:9222`, started with `npm run codex:launch` or `--remote-debugging-port=9222`.
- If the debug port is unavailable, the bridge can use local `app-server` fallback, but that is a degraded path: useful for emergency sends, weaker for UI-aware mirroring, progress and diagnostics.
- If `Codex.app` is closed or crashed, Telegram can still receive bot/admin commands, but real Codex turns will not finish normally. The bridge should say that clearly, not cosplay as a backend.

## Supported Environment

Current v1 target: a local macOS machine running Codex Desktop. Boring boundary, useful boundary.

The onboarding wizard is not Anton-machine-only, but it is not cross-platform magic either. On another Mac it should work after local setup. On Linux or Windows it is not supported yet because the runtime assumes Codex Desktop for macOS, `launchd`, macOS Keychain as an optional token source and a local Codex DB.

Required local inputs:

- installed `Codex.app`
- local Codex state DB, normally `~/.codex/state_5.sqlite`
- Telegram bot token from BotFather
- Telegram `API_ID` and `API_HASH` for the user-side admin helper
- one authorized Telegram user session for creating folders, groups and topics
- Node.js and Python dependencies from this repo

## Documentation Voice

Docs should sound like a competent teammate at 2am: direct, practical, and a little opinionated. No corporate fog. No fake certainty. If something is rough, say it is rough. If a command can make a mess, say that before the user runs it.

## What Works

- Telegram Bot API long polling
- direct chats and forum topics
- `/attach`, `/attach-latest`, `/detach`, `/status`, `/health`, `/settings`, `/project-status`, `/sync-project`, `/mode native`, plus Telegram-menu-safe aliases like `/attach_latest`, `/project_status`, `/sync_project`, `/mode_native`
- native send through renderer-aware `app-control -> threads.send_message`, with local `app-server` fallback when Codex is not launched with a debug port
- app-control send-only mode by default: Desktop accepts the turn, then Telegram gets progress/final from the rollout mirror without heavy renderer polling
- clear degraded/offline UX when `Codex.app` is closed, app-control is down, fallback is used, or both transports fail
- configurable Telegram ingress transport: use `nativeIngressTransport: "app-server"` if app-control destabilizes the desktop renderer
- in-place progress bubble in Telegram: one receipt message is edited while Codex works
- reply-style answers to the triggering Telegram message
- Telegram HTML rendering for `**bold**`, `_italic_` / `*italic*`, quotes, lists, code, spoilers, links, Markdown tables and local file links, with plain-text fallback
- short human-facing errors in chat, technical details in logs
- noisy ops commands can be routed to direct chat with the bot to keep work topics clean
- `/health` includes delivery clues, recent failures and app-control vs fallback counters
- mention-aware ingress (`@bot your request`) when group privacy blocks plain text
- `sync-project dry-run` and CLI `--self-check`
- npm scripts for running, self-checks, tests and guided onboarding
- `bot:polish` for Telegram command menu, profile text, menu button and suggested bot admin rights
- `onboard:prepare` creates missing local config/admin env files and can set up the admin Python venv before the wizard runs
- onboarding wizard with interactive project/thread selection, checklist, reuse preview, plan write, optional bootstrap, clean backfill dry-run/send and Telegram smoke
- `/project-status` shows desired thread column, active topics, parked sync topics and sync preview
- `/sync-project` can rename/reopen/create/park sync-managed topics for the current working set
- user-side history backfill from `rollout_path` into Telegram topics via `admin/telegram_user_admin.py backfill-thread`; defaults to user prompts plus assistant `final_answer`, with a bounded clean history tail
- backfill uses the same Markdown-to-Telegram HTML renderer as the live bridge
- safe topic cleanup via `admin/telegram_user_admin.py cleanup-topic`: dry-run first, deletion only with `--delete`
- bootstrap can create/update a Telegram folder, create project groups and put them into that folder
- retry on temporary Telegram fetch errors
- inbound update checkpointing to avoid duplicate turns after restart
- live outbound mirror: Codex Desktop user-turn surrogate and final answers are mirrored into the bound Telegram topic/chat
- Codex-originated commentary is folded into one editable progress message with recent visible updates; `outboundProgressMode: "generic"` hides details and `outboundProgressMode: "verbatim"` mirrors raw commentary
- Codex task plans are mirrored into the same progress bubble as a compact `Todo` block
- live progress includes a compact `Changed files` block from the thread git worktree: turn-baseline commits plus the current dirty worktree, so Telegram keeps the same “what changed?” signal as Codex Desktop
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
- [lib/app-server-stream.mjs](lib/app-server-stream.mjs) - app-server streaming event normalization for the next transport slice
- [scripts/send_via_app_control.js](scripts/send_via_app_control.js) - renderer-aware send through Codex app-control
- [scripts/send_via_app_server.js](scripts/send_via_app_server.js) - fallback transport through local Codex app-server
- [scripts/probe_app_server_stream.mjs](scripts/probe_app_server_stream.mjs) - app-server event stream probe
- [scripts/launch_codex_app_control.mjs](scripts/launch_codex_app_control.mjs) - safe launcher for Codex.app with the app-control debug port
- [scripts/onboard.mjs](scripts/onboard.mjs) - onboarding scan/plan/wizard generator from the local Codex DB
- [admin/telegram_user_admin.py](admin/telegram_user_admin.py) - user-side bootstrap/admin helper for Telegram groups and topics
- [AGENTS.md](AGENTS.md) - local notes for future Codex agents working in this repo
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) - config keys, secret sources and Telegram command boundaries
- [docs/ONBOARDING.md](docs/ONBOARDING.md) - recommended setup flow for a new user
- [docs/RUNBOOK.md](docs/RUNBOOK.md) - ops runbook
- [docs/TRANSPORT_RESEARCH.md](docs/TRANSPORT_RESEARCH.md) - current research notes on Codex app-server, hooks and newer Telegram Bot API surfaces
- [BACKLOG.md](BACKLOG.md) - product and UX backlog

## Runtime Files

These are repo-local runtime files and are ignored by git:

- `config.local.json`
- `state/state.json`
- `state/bootstrap-result.json`
- `state/telegram_user.session`
- `logs/bridge.events.ndjson`
- `logs/*`
- `admin/.env`
- `admin/bootstrap-plan.json`
- `admin/bootstrap-plan.rehearsal.json`

## Local Commands

The recommended install path is the agent-led flow above. These commands are the useful escape hatch when you are developing or debugging the bridge directly.

Preflight:

```bash
npm run onboard:prepare
npm run onboard:doctor
```

`onboard:doctor` prints a short recovery plan when setup is incomplete. The wizard also shows a reuse preview before side effects, so a repeat run can say "reuse this group/topic" instead of making you wonder whether Telegram is about to grow a second head.

Launch `Codex.app` with the app-control debug port:

```bash
npm run codex:launch
```

If `Codex.app` is already open without the debug port, close it and run the command again. The helper refuses to kill the app automatically; that is deliberate.

Start the bridge:

```bash
npm start
```

One-shot self-check:

```bash
npm run self-check
```

Polish the Telegram bot profile and command menu:

```bash
npm run bot:polish
npm run bot:polish -- --apply
```

The first command previews the Bot API calls. The second applies them.

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

## Manual Onboarding Escape Hatch

Use this when the agent-led flow needs adult supervision:

```bash
npm run onboard:wizard
```

Disposable rehearsal surface:

```bash
npm run onboard:wizard:rehearsal
```

Optional side-effect flags:

- `--apply` creates/reuses Telegram groups/topics and writes bindings.
- `--cleanup-dry-run` previews a clean rebuild by listing visible topic messages that would be removed.
- `--cleanup` deletes those visible topic messages after running the preview first; use it only when you are intentionally rebuilding a topic.
- `--backfill-dry-run` previews clean history import.
- `--backfill` sends clean history import.
- `--smoke` sends a Telegram smoke prompt and waits for the expected answer.
- `--smoke-timeout-seconds 240` controls how long the wizard waits for a mirrored smoke answer.

Lower-level `scan`, `plan`, `bootstrap` and `backfill-thread` commands still exist, but they are not the normal user story. See [docs/ONBOARDING.md](docs/ONBOARDING.md) when you need the manual recovery path.

## Ops Notes

- The bot token can come from env, config, or macOS Keychain service `codex-telegram-bridge-bot-token`.
- If `app-control` is unavailable, the bridge can still use fallback `app-server`.
- The outbound mirror reads the bound thread `rollout_path`; user surrogates, live progress updates and final answers appear in Telegram without manual backfill.
- Clean history import should not dump an infinite thread: defaults live in `config.local.json` (`historyMaxMessages`, `historyMaxUserPrompts`, `historyAssistantPhases`, `historyIncludeHeartbeats`) and can still be overridden with CLI flags.
- If plain text in a group topic does not reach the bot, the quickest fallback is `@your_bot_username your request`; the real fix is usually BotFather privacy mode.
- Long ops replies like `/project-status` and `/sync-project` are routed to direct chat when possible, leaving only a short trace in the working topic.
- Parked sync topics are not active working-set topics and should not interfere with `/attach-latest` or the next sync preview.
