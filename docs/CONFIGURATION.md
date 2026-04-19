# Configuration

There are three layers. Mixing them up is how the bridge starts feeling haunted.

## 1. Static Config

Static config lives in `config.local.json`. It is copied from `config.example.json` and ignored by git.

Use this for things that should survive restarts and should not be changed from a random Telegram topic.

| Key | Default | What it controls |
| --- | --- | --- |
| `botTokenEnv` | `CODEX_TELEGRAM_BOT_TOKEN` | Env var name for the Telegram bot token. |
| `botTokenKeychainService` | `codex-telegram-bridge-bot-token` | macOS Keychain service fallback for the bot token. |
| `botToken` | `null` | Local config fallback for the Telegram bot token. Works, but env or Keychain is cleaner. Never commit it. |
| `botUsername` | `null` | Bot username without `@`; used for mention-aware ingress and bootstrap hints. |
| `allowedUserIds` | `[]` | Telegram user allowlist. Empty means no user-id gate. |
| `allowedChatIds` | `[]` | Telegram chat allowlist. Empty means no chat-id gate. |
| `pollTimeoutSeconds` | `30` | Bot API long-poll timeout. |
| `sendTyping` | `true` | Sends Telegram typing action while Codex is working. |
| `typingHeartbeatEnabled` | `true` | Keeps Telegram's ephemeral "bot is typing" indicator alive while a bound topic has an active Codex turn. |
| `typingHeartbeatIntervalMs` | `4000` | How often to refresh the typing indicator. Telegram clients expire chat actions quickly, so keep this near 4s. |
| `outboundSyncEnabled` | `true` | Mirrors Codex Desktop-originated turns back into Telegram. |
| `outboundPollIntervalMs` | `2000` | Poll interval for outbound Codex thread mirror. |
| `outboundMirrorPhases` | `["commentary", "final_answer"]` | Which assistant phases are mirrored live. |
| `outboundProgressMode` | `updates` | `updates` keeps recent progress in one bubble; `generic` hides details; `verbatim` mirrors raw commentary. |
| `codexUserDisplayName` | `Codex Desktop user` | Label for bot-side surrogate user messages mirrored from Codex Desktop. |
| `statusBarEnabled` | `true` | Enables compact pinned topic status bar. |
| `statusBarPin` | `true` | Pins the status bar message when Telegram allows it. |
| `statusBarTailBytes` | `524288` | How much rollout tail is sampled for status data. |
| `worktreeSummaryEnabled` | `true` | Adds a `Changed files` block to live progress bubbles when this turn changes the thread git worktree. Pre-existing dirty files are treated as baseline, not fresh work. |
| `worktreeSummaryMaxFiles` | `0` | Maximum changed files shown in the Telegram progress bubble. `0` means show the full list. |
| `attachmentsEnabled` | `true` | Allows Telegram photos and documents to be downloaded locally and forwarded to Codex as local file paths in the prompt. |
| `attachmentStorageDir` | `state/attachments` | Local ignored storage for downloaded Telegram media. Do not commit it. |
| `attachmentMaxBytes` | `20971520` | Per-file attachment limit. Default is 20 MB; enough for screenshots without inviting chaos. |
| `attachmentMaxCount` | `10` | Max attachments processed from one Telegram message or media album. Telegram albums top out at 10, so the default keeps the whole user intent together. |
| `voiceTranscriptionEnabled` | `true` | Enables Telegram voice/audio ingestion. The bridge downloads audio bytes, transcribes them, posts a transcript bubble, then sends the transcript to Codex. |
| `voiceTranscriptionProvider` | `auto` | `auto`, `deepgram`, `openai`, or `command`. `auto` prefers Deepgram first because Telegram voice is usually OGG/Opus; OpenAI is still supported for compatible audio files. |
| `voiceTranscriptionModel` | provider default | Deepgram defaults to `nova-3`; OpenAI defaults to `gpt-4o-mini-transcribe`. Leave empty unless you have a reason. |
| `voiceTranscriptionLanguage` | `multi` | Deepgram language hint. `multi` is the phone-friendly default for Russian/English switching; `auto` uses language detection. OpenAI ignores `multi`. |
| `voiceTranscriptionMaxBytes` | `26214400` | Per-voice limit. Default is 25 MB, matching the common transcription upload ceiling. |
| `voiceTranscriptionDeepgramKeyEnv` | `DEEPGRAM_API_KEY` | Env var for Deepgram STT. Keychain fallback is `codex-telegram-bridge-deepgram-api-key`. |
| `voiceTranscriptionOpenAIKeyEnv` | `OPENAI_API_KEY` | Env var for OpenAI STT. Keychain fallback is `codex-telegram-bridge-openai-api-key`. |
| `voiceTranscriptionCommand` | `[]` | Optional custom STT command. Use `{file}` in args, or the bridge appends a temp file path. Temp files are deleted unless `voiceTranscriptionKeepFiles` is true. |
| `historyMaxMessages` | `40` | Default clean history tail size for onboarding/backfill. |
| `historyMaxUserPrompts` | `null` | Optional cap by recent user prompts. Leave `null` unless the message tail is too noisy. |
| `historyAssistantPhases` | `["final_answer"]` | Assistant phases imported during clean history backfill. Keep commentary out by default. |
| `historyIncludeHeartbeats` | `false` | Whether heartbeat/system-like user entries are allowed into imported history. Default false keeps setup noise out. |
| `nativeTimeoutMs` | `120000` | Timeout for one native Codex send. |
| `nativeWaitForReply` | `false` | Keep this off for the normal happy path. The transport returns as soon as Codex accepts the turn; Telegram gets progress/final through the outbound rollout mirror. Setting it to `true` uses the older renderer polling path and should be treated as a debugging fallback. |
| `nativePollIntervalMs` | `1000` | Poll interval while waiting for native Codex reply. |
| `nativeIngressTransport` | `app-control` | Telegram-originated send path: `app-control`, `app-server`, or `auto`. Use `app-server` if renderer app-control crashes the desktop app. |
| `appControlCooldownMs` | `300000` | How long to avoid app-control after an app-control send error before trying it again. |
| `appControlShowThread` | `false` | Experimental: after app-control accepts a turn, ask Codex Desktop to show the thread. Useful for Desktop-first UX, but keep it off if renderer stability is shaky. |
| `nativeDebugBaseUrl` | `http://127.0.0.1:9222` | Preferred Codex Desktop app-control endpoint. |
| `appServerUrl` | `ws://127.0.0.1:27890` | Degraded fallback endpoint. Useful, not the happy path. |
| `appServerStreamEnabled` | `true` | Listens to app-server v2 events for live progress while app-control remains the send path. If it misbehaves, turn it off; rollout mirror still works. |
| `appServerStreamConnectTimeoutMs` | `1200` | Short connect timeout for the optional app-server stream. It should not stall Telegram sends. |
| `appServerStreamReconnectMs` | `5000` | Cooldown before trying the optional app-server stream again after it disconnects. |
| `appServerStreamMaxEvents` | `500` | In-memory cap for queued app-server stream events before the bridge coalesces them into progress updates. |
| `statePath` | `state/state.json` | Bridge runtime state file. |
| `eventLogPath` | `logs/bridge.events.ndjson` | Structured bridge event/audit log used by `/health` for recent failures and delivery counters. |
| `bridgeLogPath` | `logs/bridge.stderr.log` | launchd stderr log. Useful when the bridge crashes before it can write structured events. |
| `nativeHelperPath` | `scripts/send_via_app_control.js` | app-control helper path. |
| `nativeFallbackHelperPath` | `scripts/send_via_app_server.js` | app-server fallback helper path. |
| `projectIndexPath` | `state/bootstrap-result.json` | Project/group/topic index produced by bootstrap. |
| `threadsDbPath` | `~/.codex/state_5.sqlite` | Local Codex Desktop threads DB. |
| `syncDefaultLimit` | `3` | Default project working-set size for `/project-status` and `/sync-project`. |

Hard take: keep this file boring. If a setting can make the bridge unusable, do not expose it casually in Telegram until there is validation and rollback.

## 2. Secrets And Local Setup

These are not product settings; they are local machine plumbing.

- Bot token: env var from `botTokenEnv`, `botToken` in local config, or macOS Keychain.
- STT key for voice: prefer `DEEPGRAM_API_KEY` or Keychain service `codex-telegram-bridge-deepgram-api-key`; OpenAI also works through `OPENAI_API_KEY` or `codex-telegram-bridge-openai-api-key`.
- Telegram user API credentials: `admin/.env` with `API_ID` and `API_HASH`.
- Telegram user session: `state/telegram_user.session`, created by `login-qr` or `login-phone`.
- launchd overrides: `CODEX_TELEGRAM_CONFIG`, `CODEX_TELEGRAM_LAUNCHD_LABEL`, `CODEX_TELEGRAM_KEYCHAIN_SERVICE`.

Run the doctor before blaming Telegram:

```bash
npm run onboard:doctor
```

## 3. Telegram Commands

Bot commands are for operational state, not full config editing.

Working commands today:

- `/help` or `/start` - shows help in the chat/topic where it was asked.
- `/attach <thread-id>` - binds the current chat/topic to a Codex thread.
- `/attach-latest` - binds this forum topic to the newest unbound thread for the mapped project.
- `/detach` - removes the current binding.
- `/status` - shows current binding status.
- `/health` - checks current chat/topic, project mapping and transport endpoints.
- `/settings` or `/config` - shows safe read-only runtime settings without secrets.
- `/project-status [count]` - previews desired project thread working set.
- `/sync-project [count] dry-run` - safe preview for topic rename/reopen/create/park.
- `/sync-project [count]` - applies that working-set sync.
- `/mode native` - pins the binding transport to native. It is the only supported v1 mode.

Telegram's command menu prefers underscores, so the bridge also accepts `/attach_latest`, `/project_status`, `/sync_project` and `/mode_native`. The old hyphen commands still work; the menu-safe aliases are just less annoying in real Telegram clients.

What commands mutate:

- bindings in `state/state.json`
- project/topic sync state
- Telegram forum topics when `/sync-project` is not dry-run

What commands do not mutate:

- bot token
- allowlists
- transport URLs
- attachment storage/limits
- voice transcription provider/keys
- mirror/status-bar settings
- onboarding defaults

That split is intentional. Telegram is the working surface, not a remote control panel for every sharp knob.

## Still Not Wanted

Editing config from Telegram should wait. If we add it too early, we will invent an admin panel in the middle of the work chat. Nobody needs that little swamp.
