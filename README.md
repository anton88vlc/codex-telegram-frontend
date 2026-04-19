# Codex Telegram Frontend

Telegram as a fast remote frontend for local Codex Desktop on macOS.

This is not "another bot chat". The product shape is simple:

- Telegram folder `codex` = the external Codex container.
- One Telegram group = one Codex project.
- One Telegram topic = one Codex thread.
- Direct bot chat = rare global/ops escape hatch.
- Codex Desktop stays the engine and source of truth.

The goal is a clean phone-sized working set, not a landfill mirror of every thread you have ever opened.

## Install With Codex

Current v1 target: macOS with local `Codex.app`.

Open this repo in Codex and paste this into a fresh thread from the repo root:

```text
Install codex-telegram-frontend on this Mac.

Run the onboarding doctor, prepare local config from examples, guide me through the unavoidable Telegram steps, then scan my Codex projects and ask me which projects and threads I want mirrored into Telegram.

Create or reuse the Telegram folder `codex`, create one group per selected Codex project, create one topic per selected Codex thread, import only a clean bounded history tail, start the bridge, run a real Telegram smoke test, and leave the repo in a clean documented state.

Do not mirror every thread. Keep Telegram as a clean remote Codex working set, not a landfill.
```

What still needs a human:

1. Create or reuse a Telegram bot through [@BotFather](https://t.me/BotFather).
2. Paste Telegram app credentials from [my.telegram.org](https://my.telegram.org/) if the admin helper asks.
3. Authorize one local Telegram user session so the helper can create folders, groups and topics.
4. Keep `Codex.app` available. Best path:

```bash
npm run codex:launch
```

Codex should handle local config, Keychain/env wiring, bootstrap, backfill and smoke. If setup gets weird, use [docs/ONBOARDING.md](docs/ONBOARDING.md).

## Runtime Boundary

This project is a frontend. It does not replace Codex.

- Preferred send path: `app-control` on `http://127.0.0.1:9222`.
- Start it with `npm run codex:launch` or launch Codex with `--remote-debugging-port=9222`.
- `app-server` fallback is resilience, not the happy path.
- If `Codex.app` is closed or crashed, the bridge should say that plainly in Telegram.

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
- Bootstrap can create/reuse Telegram folder, project groups, topics, bot folder entry and status bars.
- Bot polish: command menu, profile text, suggested admin rights and bundled avatar.
- Structured event log at `logs/bridge.events.ndjson`; `/health` samples it.

## Not Yet

- Cross-platform runtime. v1 is macOS plus local Codex Desktop.
- Raw token-by-token Telegram streaming. Current progress is coalesced into readable bubbles on purpose.
- Auto-create rules for fresh Codex threads.
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
npm run check
```

Bot polish:

```bash
npm run bot:polish
npm run bot:polish -- --apply
npm run bot:avatar
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

- [bridge.mjs](bridge.mjs) - main polling bridge
- [lib/telegram.mjs](lib/telegram.mjs) - Telegram Bot API helpers
- [lib/codex-native.mjs](lib/codex-native.mjs) - Codex send wrapper
- [lib/voice-transcription.mjs](lib/voice-transcription.mjs) - Telegram voice/audio STT
- [lib/outbound-progress.mjs](lib/outbound-progress.mjs) - Telegram progress bubble content
- [scripts/onboard.mjs](scripts/onboard.mjs) - onboarding scan/plan/wizard
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
