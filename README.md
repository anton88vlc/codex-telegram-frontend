# Codex Telegram Frontend

Telegram as a fast remote frontend for local Codex Desktop on macOS.

This is not "another bot chat". The product shape is simple:

- Telegram folder `codex` = the external Codex container.
- One Telegram group = one Codex project.
- One Telegram topic = one Codex thread.
- Direct bot chat with private topics = Codex Desktop `Chats`.
- Codex Desktop stays the engine and source of truth.

The goal is a clean phone-sized working set, not a landfill mirror of every thread you have ever opened.

## Install With Codex

Current v1 target: macOS with local `Codex.app`.

Open this repo in Codex and paste this into a fresh thread from the repo root:

```text
Install codex-telegram-frontend on this Mac.

Run the onboarding doctor, prepare local config from examples, guide me through the unavoidable Telegram steps, then run the quickstart onboarding path.

Do not ask me to paste bot tokens, Telegram API hashes, login codes or 2FA passwords into Codex chat. Use local hidden prompts, Keychain, ignored config files, browser/Telegram UI, or QR login instead.

Create or reuse the Telegram folder `codex`, scan my pinned Codex threads first and then my latest active Codex project threads and Codex Chats, create one group per detected Codex project, create one topic per selected Codex project thread, map Codex Chats into private topics inside the bot direct chat, import about 10 clean messages into each topic, start the bridge, run a real Telegram smoke test, and leave the repo in a clean documented state.

Default to about 10 active threads total, with pinned Codex threads treated as the user's keep list. Do not ask me to choose projects unless the quickstart preview looks wrong. Keep Telegram as a clean remote Codex working set, not a landfill.
```

What still needs a human:

1. Create or reuse a Telegram bot through [@BotFather](https://t.me/BotFather).
2. Create or reuse Telegram app credentials at [my.telegram.org](https://my.telegram.org/) if the admin helper asks.
3. Authorize one local Telegram user session so the helper can create folders, groups and topics.
4. Keep `Codex.app` available. Best path:

```bash
npm run codex:launch
```

Codex should handle local config, Keychain/env wiring, bootstrap, backfill and smoke. The human should click/scan/type into local Telegram or terminal prompts, not dump secrets into the conversation transcript. If setup gets weird, use [docs/ONBOARDING.md](docs/ONBOARDING.md).

## Runtime Boundary

This project is a frontend. It does not replace Codex.

- Preferred send path: `app-control` on `http://127.0.0.1:9222`.
- Start it with `npm run codex:launch` or launch Codex with `--remote-debugging-port=9222`.
- `app-server` fallback is resilience, not the happy path.
- If `Codex.app` is closed or crashed, the bridge should say that plainly in Telegram.

Two modes matter: `app-control` is the live near-Mac mode with the best Desktop mirror, and `app-server` is the calmer remote mode when you just need Telegram to keep moving. Default to `app-control`; switch `nativeIngressTransport` to `app-server` if the Desktop renderer gets dramatic.

## What Works

- Telegram Bot API long polling for direct chats and forum topics.
- Bindings: `/attach`, `/attach-latest`, `/detach`, `/status`.
- Ops: `/health`, `/settings`, `/project-status`, `/sync-project`, `/mode native`.
- Telegram-menu-safe aliases: `/attach_latest`, `/project_status`, `/sync_project`, `/mode_native`.
- App-control send-only by default: Codex accepts the turn, Telegram gets progress/final from the rollout mirror.
- In-place progress bubble with live steps, Todo, changed files and final state.
- Native Telegram typing heartbeat while Codex is working.
- Reply-chain UX: final answers reply to the triggering user/surrogate message.
- Pinned compact status bar per active topic.
- Markdown-ish Telegram rendering: bold, italic, quotes, lists, code, links, tables and local file links.
- Codex Desktop-originated prompts and final answers mirrored into Telegram.
- Attachments: photos/documents, including media albums, are saved to ignored local storage and forwarded to Codex as file paths.
- Voice/audio: Telegram voice is transcribed first, shown as an italic quoted transcript, then sent to Codex as text.
- Clean bounded history backfill: user prompts plus assistant final answers by default.
- Quickstart onboarding: pinned Codex threads are included first, latest active Codex project threads become Telegram groups/topics, and existing Codex Chats become private topics inside the bot direct chat when the bot has Threaded Mode enabled.
- New private bot topics are not auto-created as Desktop `Chats` by default. The app-server `thread/start` path is useful, but it does not yet behave exactly like pressing `New chat` in Codex Desktop, so the safe default is explicit `/attach` instead of fake magic.
- Private bot topic preflight for Codex Desktop `Chats`: `npm run bot:topics`.
- Bootstrap can create/reuse Telegram folder, project groups, topics, bot folder entry, generated project group avatars and status bars.
- Optional curated topic auto-sync for fresh Codex threads in already bootstrapped project groups.
- Bot polish: generated group avatars, command menu, profile text, suggested admin rights and bundled bot avatar. Quickstart applies the bot avatar best-effort; `npm run bot:avatar` is the manual retry.
- Structured event log at `logs/bridge.events.ndjson`; `/health` samples it.
- Local state doctor for stale topic bindings, orphan mirror state and bootstrap-index drift.

## Not Yet

- Cross-platform runtime. v1 is macOS plus local Codex Desktop.
- Raw token-by-token Telegram streaming. Current progress is coalesced into readable bubbles on purpose.
- Rich voice controls such as provider picker, live partial transcripts or confidence display.
- Dedicated ops topic/router for noisy admin flows.

## Local Commands

Install/development preflight:

```bash
npm run onboard:prepare
npm run onboard:doctor
```

Guided setup:

```bash
npm run onboard:quickstart
npm run onboard:wizard
npm run onboard:wizard:rehearsal
```

Run the bridge:

```bash
npm run codex:launch
npm start
```

Self-check and full check:

```bash
npm run self-check
npm run state:doctor
npm run check
```

Bot polish:

```bash
npm run bot:polish
npm run bot:polish -- --apply
npm run bot:topics
npm run bot:avatar
```

Low-level app-server probe for creating a Codex Chat without touching Telegram:

```bash
npm run app-server:start-chat -- --title "Scratch idea"
```

Install or refresh launchd:

```bash
./ops/install-launchd.sh
```

## Configuration

Copy `config.example.json` to `config.local.json`. The local file is ignored by git.

Secrets can come from env, local config or macOS Keychain:

- bot token: `CODEX_TELEGRAM_BOT_TOKEN` or Keychain service `codex-telegram-bridge-bot-token`
- Deepgram STT: `DEEPGRAM_API_KEY` or `codex-telegram-bridge-deepgram-api-key`
- OpenAI STT: `OPENAI_API_KEY` or `codex-telegram-bridge-openai-api-key`
- Telegram user helper: `admin/.env` with `API_ID` and `API_HASH`

Full config map: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Runtime Files

These are local runtime files and should not be committed:

- `config.local.json`
- `state/state.json`
- `state/bootstrap-result.json`
- `state/telegram_user.session`
- `state/attachments/`
- `logs/*`
- `admin/.env`
- `admin/.venv/`
- `admin/bootstrap-plan.json`
- `admin/bootstrap-plan.rehearsal.json`

`state/` is local memory for the bridge, not repo content.

## Project Map

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - how the bridge is shaped and where refactors should go
- [bridge.mjs](bridge.mjs) - thin polling bridge and top-level loop
- [lib/inbound-turn-runner.mjs](lib/inbound-turn-runner.mjs) - Telegram-originated Codex turn orchestration
- [lib/telegram.mjs](lib/telegram.mjs) - Telegram Bot API helpers
- [lib/codex-native.mjs](lib/codex-native.mjs) - Codex send wrapper
- [lib/command-handlers.mjs](lib/command-handlers.mjs) - Telegram slash-command routing
- [lib/binding-send-validation.mjs](lib/binding-send-validation.mjs) - pre-send binding safety checks and archived-thread rescue
- [lib/unbound-group-rescue.mjs](lib/unbound-group-rescue.mjs) - General/All message rescue into the active topic
- [lib/voice-transcription.mjs](lib/voice-transcription.mjs) - Telegram voice/audio STT
- [lib/health-report.mjs](lib/health-report.mjs) - `/status` and `/health` text shaping
- [lib/project-sync-runner.mjs](lib/project-sync-runner.mjs) - project topic status/sync orchestration
- [lib/outbound-mirror-runner.mjs](lib/outbound-mirror-runner.mjs) - Codex rollout mirror delivery loop
- [lib/outbound-memory.mjs](lib/outbound-memory.mjs) - remembered Telegram message ids and mirror suppression helpers
- [lib/outbound-progress.mjs](lib/outbound-progress.mjs) - Telegram progress bubble content
- [lib/outbound-progress-message.mjs](lib/outbound-progress-message.mjs) - progress bubble send/edit state
- [lib/app-server-stream-runner.mjs](lib/app-server-stream-runner.mjs) - optional app-server event stream bridge
- [lib/worktree-summary.mjs](lib/worktree-summary.mjs) - changed-file summaries and turn baselines
- [lib/status-bar-runner.mjs](lib/status-bar-runner.mjs) - pinned topic status refresh loop
- [lib/typing-heartbeat-runner.mjs](lib/typing-heartbeat-runner.mjs) - native Telegram "typing" loop for active turns
- [lib/state-doctor.mjs](lib/state-doctor.mjs) - local state/index drift inspection and safe repairs
- [scripts/onboard.mjs](scripts/onboard.mjs) - onboarding scan/plan/wizard
- [scripts/state_doctor.mjs](scripts/state_doctor.mjs) - CLI for local state repair previews
- [admin/telegram_user_admin.py](admin/telegram_user_admin.py) - Telethon admin helper for folders/groups/topics
- [docs/ONBOARDING.md](docs/ONBOARDING.md) - setup flow
- [docs/RUNBOOK.md](docs/RUNBOOK.md) - operations and recovery
- [docs/TRANSPORT_RESEARCH.md](docs/TRANSPORT_RESEARCH.md) - app-server/hooks/Telegram research notes
- [BACKLOG.md](BACKLOG.md) - product backlog

## Telegram Model

Keep Telegram close to Codex Desktop:

- curated project groups
- curated topic working set
- visible progress and status
- minimal ops noise
- no infinite historical dump

That is the v1. Everything else is how a useful tool slowly turns into a swamp.
