# Runbook

Commands below assume they are run from the repository root. Run them from somewhere else and you are volunteering for silly problems.

## Runtime Files

- config: `config.local.json`
- state: `state/state.json`
- project index: `state/bootstrap-result.json`
- attachments: `state/attachments/`
- user session: `state/telegram_user.session`
- bootstrap plan: `admin/bootstrap-plan.json` (ignored runtime file)
- rehearsal plan: `admin/bootstrap-plan.rehearsal.json` (ignored runtime file)
- logs: `logs/bridge.events.ndjson`, `logs/bridge.stdout.log`, `logs/bridge.stderr.log`
- launchd label: `com.codex.telegram-frontend.bridge` by default
- token Keychain service: `codex-telegram-bridge-bot-token` by default

## Runtime Boundary

The bridge is only the Telegram frontend. `Codex.app` remains the engine and source of truth.

Keep `Codex.app` open for real work. Prefer `app-control` on `http://127.0.0.1:9222`; the app-server fallback is useful resilience, not the happy path.

Start the happy path with:

```bash
npm run codex:launch
```

If Codex is already open without the debug port, close it first. The launcher does not kill active Codex windows. Good tools do not yoink the steering wheel.

## Install Assumptions

The current ops path assumes macOS. There is no secret cloud brain hiding behind this:

- `Codex.app` is the local engine.
- Codex project/thread data comes from the local `~/.codex/state_5.sqlite` DB unless config overrides it.
- `launchd` is used for the daemon.
- macOS Keychain can hold the bot token, though env/config also work.
- Telethon uses a local user session file to create Telegram folders, groups and topics.

If any of those are missing, run `npm run self-check` first and fix the local prerequisite before debugging Telegram UX. Otherwise you are just poking the wrong beast.

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

Onboarding preflight without Telegram side effects:

```bash
npm run onboard:doctor
```

Local state/index repair preview:

```bash
npm run state:doctor
```

Apply safe local repairs. This tombstones stale bindings, removes orphan mirror state and prunes stale bootstrap entries; it does not delete Telegram messages:

```bash
npm run state:doctor -- --apply
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

Do this in order. Random poking makes the bridge look haunted when it is usually just missing one boring prerequisite.

1. Make sure `Codex.app` is open.
2. Prefer `npm run codex:launch`; otherwise the bridge can still try the local app-server fallback.
3. Run `npm run self-check`.
4. Run `npm run state:doctor`; if it reports safe repairs, apply them.
5. Check `/health`; it samples `logs/bridge.events.ndjson`.
6. If the bridge crashed before structured logging, check `logs/bridge.stderr.log`.
7. Check whether `state/state.json -> lastUpdateId` moves.
8. If launchd is alive but stuck, use `launchctl kickstart -k ...`.

If `self-check` says `app-control: fetch failed`, but `app-server: reachable`, that is not fatal.

## Telegram Attachments

Photos and documents from a bound topic are downloaded by the bot into `state/attachments/`, then sent to Codex as local file paths inside the prompt. That is intentionally boring and inspectable: no hidden cloud storage, no mystery media relay.

Voice/audio is different on purpose. The bridge downloads the Telegram audio bytes, sends them to STT, posts a short italic quoted transcript in the topic, then sends that transcript to Codex. For built-in Deepgram/OpenAI providers it does not keep the audio file on disk. The optional `command` provider uses a temp file and deletes it after the command returns unless `voiceTranscriptionKeepFiles` is enabled.

Current boundary:

- photos and documents: supported
- image documents: treated as images
- voice/audio: transcribed first, then sent to Codex as text
- video/stickers: not yet
- default limit: 10 files per message/media album, 20 MB per file
- voice default limit: 1 voice/audio item, 25 MB per item

If an attachment fails, check `logs/bridge.events.ndjson` for `telegram_attachment_error`. The file itself is runtime state, so do not commit it.
If transcription fails, check `telegram_voice_transcription_error` in the same event log. In normal UX the user only sees a short "could not transcribe" note; provider details stay in logs where they belong.

## Transport Fallback

If a Telegram reply says fallback was used, the bridge is using `app-server` instead of the preferred `app-control` path. Some UI-aware behavior may be weaker, but the user should at least know what happened instead of staring at silence.

If both paths fail, Telegram shows a short recovery hint: open `Codex.app`, preferably through `npm run codex:launch`, then retry. If phone-originated Telegram prompts crash the desktop renderer, set `nativeIngressTransport` to `app-server` in `config.local.json`.

For the Desktop-first happy path without the old heavy renderer polling, use:

```json
{
  "nativeIngressTransport": "app-control",
  "nativeWaitForReply": false,
  "appControlShowThread": true
}
```

This is now the expected app-control shape: a small `threads.send_message` action, then Telegram receives progress/final from the rollout mirror. If the renderer still crashes, turn `appControlShowThread` off first; if it still crashes, go back to `nativeIngressTransport: "app-server"`.
That keeps Telegram ingress off the renderer while outbound mirroring can still read the Codex thread state.

## UX Smoke

This is what good looks like:

1. Send normal text in a bound topic and confirm one progress bubble appears.
2. Confirm the bubble edits in place for longer replies.
3. Confirm the final answer is a reply to the triggering user/surrogate message.
4. Run `/project-status` or `/sync-project dry-run` and confirm details appear in the same chat/topic.
5. Send a short turn directly from Codex Desktop and confirm Telegram receives the surrogate user message plus assistant updates.
6. Confirm each active topic has one pinned compact status bar.
7. If `topicAutoSyncEnabled` is true, create or open a fresh Codex thread in a bootstrapped project and confirm the group gets a sync-managed topic without creating a topic flood.

## Bootstrap / Telegram Admin

Preferred guided flow:

```bash
npm run onboard:quickstart
```

This is the normal install story now: latest 10 active Codex work items, grouped into project groups plus bot private topics for Codex Desktop `Chats`, about 10 clean messages per topic, then bootstrap/backfill/smoke. If that working set looks wrong, drop to the manual wizard:

```bash
npm run onboard:wizard
```

Disposable rehearsal:

```bash
npm run onboard:wizard:rehearsal
```

Generate plan preview from the local Codex DB:

```bash
npm run onboard:scan -- \
  --project-limit 12 \
  --threads-per-project 5
```

Write a plan after selecting projects:

```bash
npm run onboard:plan -- \
  --project /path/to/codex-project \
  --threads-per-project 3 \
  --write
```

Clean history defaults come from `config.local.json`, not from a secret CLI incantation. Override with `--history-max-messages`, `--history-max-user-prompts`, `--history-assistant-phase` or `--history-include-heartbeats` only for one-off runs.

Write a disposable rehearsal plan:

```bash
npm run onboard:rehearsal -- \
  --project /path/to/codex-project \
  --write
```

Rehearsal writes `admin/bootstrap-plan.rehearsal.json` by default, uses `Codex Lab - ` group titles and folder `codex-lab`, displays topics as tabs, and keeps the working set intentionally small.

Clean rebuild preview for the selected rehearsal topics:

```bash
npm run onboard:wizard:rehearsal -- \
  --project /path/to/codex-project \
  --write \
  --apply \
  --cleanup-dry-run \
  --backfill-dry-run
```

`--cleanup` is the real delete switch. It runs the same preview first, then deletes visible topic messages except protected root/status messages.

Create or reuse Telegram groups/topics and write bridge bindings:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py bootstrap \
  --plan admin/bootstrap-plan.json
```

`bootstrap` creates or updates the Telegram folder from the plan by default and puts project groups plus the bot direct chat there.
If the plan contains the `private-chat-topics` surface, `bootstrap` creates/reuses topics inside the bot direct chat via Bot API. That depends on Telegram's private-topic mode for bots; if it is not enabled, the helper records a warning instead of pretending those Chats are projects.
It also forces forum topics to display as `Tabs`; pass `--topic-display list` only for manual debugging.
It merges groups into `state/bootstrap-result.json`; pass `--replace-result` only for an intentional clean rebuild.
Use `--skip-folder` only when debugging folder automation. Use `--skip-bot-folder` if the bot direct chat should stay out of the folder for a one-off test.
Bot username is read from `config.local.json -> botUsername`, `CODEX_TELEGRAM_BOT_USERNAME`, or `--bot-username`.

Private bot topics preflight:

```bash
npm run bot:topics
```

Real create/delete smoke in the bot direct chat:

```bash
npm run bot:topics -- --smoke --chat-id <telegram-user-id>
```

If the check reports private topics as off, open @BotFather, select the bot, enable forum/topic mode in private chats in the BotFather Mini App, then rerun bootstrap. Without that switch, Codex Desktop `Chats` stay out of Telegram instead of being faked as project groups.

Apply the bundled bot avatar after the user-side Telegram session is authorized:

```bash
npm run bot:avatar
```

This calls `photos.uploadProfilePhoto(bot=...)` through MTProto, so the logged-in Telegram user must own the bot. BotFather/Bot API cannot do this cleanly.

## Telegram Ops Commands

- `/health` - quick health for the current chat/topic: binding, project mapping, transport endpoints, delivery clues and recent failures
- `/settings` or `/config` - safe read-only runtime settings, answered where you ask
- `/project-status [count]` - desired thread column, active topics, parked sync topics and sync preview
- `/sync-project [count] dry-run` - safe preview before rename/reopen/create/park

Full config map lives in [CONFIGURATION.md](CONFIGURATION.md). Short version: persistent app config is `config.local.json`/env/Keychain; Telegram commands mostly mutate bindings and topic sync state, not global settings.

Optional auto-sync:

```json
{
  "topicAutoSyncEnabled": true,
  "topicAutoSyncLimit": 3
}
```

It uses the same plan as `/sync-project`, only for already bootstrapped project groups. It creates/reopens/renames/parks sync-managed topics inside the limit, ignores manual topics and never deletes Telegram history. If the preview looks weird, keep it off. Being automatic is not a virtue by itself.

## History Backfill

Preview clean history import:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py backfill-thread \
  --thread-id <codex-thread-id> \
  --chat-id <telegram-chat-id> \
  --topic-id <telegram-topic-id> \
  --sender-mode labeled-bot \
  --dry-run
```

Run without `--dry-run` after checking the preview. Skipping the preview is how Telegram topics become archaeology.

Notes:

- `labeled-bot` is safer for imports: messages are sent as `User:` / `Codex:` by the bot and do not loop back as fresh user turns. Override with `--user-label` / `--assistant-label` if you want different visible names.
- default `--render-mode html` uses the same Telegram renderer as live bridge messages; `--render-mode plain` is only a debugging fallback.
- default backfill imports only the configured clean tail: user prompts plus configured assistant phases, `final_answer` by default
- commentary, heartbeat/system-like entries, Codex app directives and memory citations are skipped by default
- topic root, pinned status bar and recent live mirror ids from `state/state.json` are protected
- Telegram `retry_after` is respected, so a partial 429 can usually be resumed by rerunning the command

If a status bar message exists but Telegram Desktop does not surface the pinned banner, re-pin it via MTProto:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py pin-message \
  --chat-id <telegram-chat-id> \
  --message-id <status-bar-message-id> \
  --silent
```

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
- add `--all-visible` only for a deliberate clean rebuild; it targets every visible text message not protected by state/keep ids
- defaults target service actions and explicit ops/smoke noise, not real working history; deleting the useful conversation is not a cleanup strategy

## UX Notes

- Telegram frontend copy is English-first.
- Mirrored user prompts and final answers keep the original thread language.
- User-facing replies render through Telegram HTML parse mode with plain-text fallback.
- Progress bubbles are honest in-place status updates, not true Codex token streaming yet.
- Codex-originated commentary is folded into one editable progress message with recent visible updates by default.
- `Changed files` appears in the same progress bubble when the current turn changes the thread cwd git worktree. The bridge captures a baseline snapshot at turn start, so old dirty files do not show up as fresh work on a later prompt.
- Set `outboundProgressMode: "generic"` to hide progress details, or `outboundProgressMode: "verbatim"` to mirror raw commentary.
- Codex Desktop-originated turns first create a bot-side surrogate user message, then assistant replies attach to it.
- Status bar is one pinned message per active topic and edits only on change.
- Transport/raw exceptions stay in logs; users get short human messages.
- Parked sync topics are old working-set snapshots and should not count as active threads.

If privacy mode blocks plain-text ingress in group topics, quick fallback:

```text
@your_bot_username your text
```
