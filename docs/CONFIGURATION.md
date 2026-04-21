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
| `unboundGroupFallbackEnabled` | `true` | Rescues plain messages accidentally sent to General/All in a project group by moving them into the last active bound topic. Commands are not rescued; sharp tools stay where you put them. |
| `unboundGroupFallbackMaxAgeMs` | `2592000000` | Max age for the "last active topic" rescue target. Default is 30 days; `0` disables the age cutoff. |
| `outboundSyncEnabled` | `true` | Mirrors Codex Desktop-originated turns back into Telegram. |
| `outboundPollIntervalMs` | `2000` | Poll interval for outbound Codex thread mirror. |
| `outboundMirrorPhases` | `["commentary", "final_answer"]` | Which assistant phases are mirrored live. |
| `outboundProgressMode` | `updates` | `updates` keeps recent progress in one bubble; `generic` hides details; `verbatim` mirrors raw commentary. |
| `codexUserDisplayName` | `Codex Desktop user` | Label for bot-side surrogate user messages mirrored from Codex Desktop. |
| `statusBarEnabled` | `true` | Enables compact pinned topic status bar. |
| `statusBarPin` | `true` | Pins the status bar message when Telegram allows it. |
| `statusBarFastMode` | `null` | Manual override for the pinned status line: `true` shows `fast on`, `false` shows `fast off`. Leave `null` for the normal path: the bridge reads Codex config live. |
| `statusBarTailBytes` | `524288` | How much rollout tail is sampled for status data. |
| `statusBarCodexConfigPollIntervalMs` | `5000` | How often the status bar samples live Codex config via app-server control for model, reasoning and fast tier. Set `0` to disable and fall back to thread history plus manual overrides. |
| `worktreeSummaryEnabled` | `true` | Adds a `Changed files` block to live progress bubbles when this turn changes the thread git worktree. Pre-existing dirty files are treated as baseline, not fresh work. |
| `worktreeSummaryMaxFiles` | `0` | Maximum changed files shown in the Telegram progress bubble. `0` means show the full list. |
| `attachmentsEnabled` | `true` | Allows Telegram photos and documents to be downloaded locally and forwarded to Codex as local file paths in the prompt. |
| `attachmentStorageDir` | `state/attachments` | Local ignored storage for downloaded Telegram media. Do not commit it. |
| `attachmentMaxBytes` | `20971520` | Per-file attachment limit. Default is 20 MB; enough for screenshots without inviting chaos. |
| `attachmentMaxCount` | `10` | Max attachments processed from one Telegram message or media album. Telegram albums top out at 10, so the default keeps the whole user intent together. |
| `voiceTranscriptionEnabled` | `true` | Enables Telegram voice/audio ingestion. The bridge downloads audio bytes, transcribes them, posts an italic quoted transcript, then sends the transcript to Codex. |
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
| `turnQueueEnabled` | `true` | When a topic already has an active Codex turn, new normal messages are queued instead of being shoved into the running turn. Use `/steer` for explicit intervention. |
| `turnQueueMaxItems` | `10` | Max queued prompts per bound Telegram topic. This is a guardrail, not a productivity challenge. |
| `privateTopicAutoCreateChats` | `false` | Experimental. If enabled, the first message in an unbound private bot topic starts an app-server thread and binds it. Keep this off for normal use: today it is not the same thing as creating a visible `New chat` in Codex Desktop. |
| `nativeChatStartTimeoutMs` | `45000` | Timeout for the experimental app-server `thread/start` helper used by private-topic auto-create. |
| `nativeChatStartCwd` | `$HOME` | Cwd for experimental auto-created app-server threads. Leave unset or `null` for the home default; set a real project path only if you intentionally want every private topic to become project-scoped. |
| `appControlCooldownMs` | `300000` | How long to avoid app-control after an app-control send error before trying it again. |
| `appControlShowThread` | `false` | Experimental: after app-control accepts a turn, ask Codex Desktop to show the thread. Useful for Desktop-first UX, but keep it off if renderer stability is shaky. |
| `nativeDebugBaseUrl` | `http://127.0.0.1:9222` | Preferred Codex Desktop app-control endpoint. |
| `appServerUrl` | `ws://127.0.0.1:27890` | Degraded fallback endpoint. Useful, not the happy path. |
| `appServerControlTimeoutMs` | `3000` | Timeout for short app-server control commands like `/model`, `/think`, `/fast` and `/compact`. Keep it short; Telegram should not hang while Codex thinks about life. |
| `appServerStreamEnabled` | `true` | Listens to app-server v2 events for live progress while app-control remains the send path. If it misbehaves, turn it off; rollout mirror still works. |
| `appServerStreamConnectTimeoutMs` | `1200` | Short connect timeout for the optional app-server stream. It should not stall Telegram sends. |
| `appServerStreamReconnectMs` | `5000` | Cooldown before trying the optional app-server stream again after it disconnects. |
| `appServerStreamMaxEvents` | `500` | In-memory cap for queued app-server stream events before the bridge coalesces them into progress updates. |
| `statePath` | `state/state.json` | Bridge runtime state file. |
| `eventLogPath` | `logs/bridge.events.ndjson` | Structured bridge event/audit log used by `/health` for recent failures and delivery counters. |
| `bridgeLogPath` | `logs/bridge.stderr.log` | launchd stderr log. Useful when the bridge crashes before it can write structured events. |
| `nativeHelperPath` | `scripts/send_via_app_control.js` | app-control helper path. |
| `nativeFallbackHelperPath` | `scripts/send_via_app_server.js` | app-server fallback helper path. |
| `nativeChatStartHelperPath` | `scripts/start_via_app_server.js` | Experimental app-server `thread/start` helper for private-topic auto-create. Not the normal Desktop `Chats` path. |
| `projectIndexPath` | `state/bootstrap-result.json` | Project/group/topic index produced by bootstrap. |
| `threadsDbPath` | `~/.codex/state_5.sqlite` | Local Codex Desktop threads DB. |
| `syncDefaultLimit` | `3` | Default project working-set size for `/project-status` and `/sync-project`. |
| `topicAutoSyncEnabled` | `false` | Optional curated auto-sync. When enabled, the bridge periodically syncs fresh active Codex threads into already bootstrapped Telegram project groups. Off by default because surprise topic creation is annoying. |
| `topicAutoSyncLimit` | `3` | Max active sync-managed topics per project group for auto-sync. Manual bindings do not count as disposable trash. |
| `topicAutoSyncPollIntervalMs` | `60000` | How often auto-sync scans the local Codex DB. |
| `topicAutoSyncMaxThreadAgeMs` | `604800000` | Freshness window for auto-created topics. Default is 7 days; `0` disables the age cutoff. |
| `topicAutoSyncMaxActionsPerTick` | `8` | Safety cap for one auto-sync pass. If a project needs more, run `/sync-project` manually and look at the preview. |
| `privateTopicAutoSyncEnabled` | `true` | Auto-sync existing Codex Desktop `Chats` into bot-private topics when the bot has private threaded mode enabled. This only follows real local Codex Chats; it does not fake-create new Desktop Chats. |
| `privateTopicAutoSyncLimit` | `5` | Max fresh Codex Chats tracked in the bot direct chat. Keep this small, because private chat topics should feel like a working set, not an archive dump. |
| `privateTopicAutoSyncPollIntervalMs` | `60000` | How often the bridge scans the local Codex DB for new Codex Chats. |
| `privateTopicAutoSyncMaxThreadAgeMs` | `604800000` | Freshness window for auto-created private topics. Default is 7 days; `0` disables the age cutoff. |
| `privateTopicAutoSyncMaxActionsPerTick` | `3` | Safety cap for one private-topic sync pass. Extra creates/renames are deferred to later ticks instead of flooding Telegram. |

Hard take: keep this file boring. If a setting can make the bridge unusable, do not expose it casually in Telegram until there is validation and rollback.

## 2. Secrets And Local Setup

These are not product settings; they are local machine plumbing.

- Bot token: env var from `botTokenEnv`, `botToken` in local config, or macOS Keychain.
- STT key for voice: prefer `DEEPGRAM_API_KEY` or Keychain service `codex-telegram-bridge-deepgram-api-key`; OpenAI also works through `OPENAI_API_KEY` or `codex-telegram-bridge-openai-api-key`.
- Telegram user API credentials: `admin/.env` with `API_ID` and `API_HASH` from [my.telegram.org/apps](https://my.telegram.org/apps). These are user-side app credentials, not the bot token.
- Telegram user session: `state/telegram_user.session`, created by phone login by default or QR login as a fallback.
- launchd overrides: `CODEX_TELEGRAM_CONFIG`, `CODEX_TELEGRAM_LAUNCHD_LABEL`, `CODEX_TELEGRAM_KEYCHAIN_SERVICE`.

Run the doctor before blaming Telegram:

```bash
npm run onboard:doctor
npm run state:doctor
npm run bot:topics
```

`onboard:doctor` checks setup prerequisites. `state:doctor` checks the bridge's live local memory: stale bindings, dead-topic errors, orphan mirror state and bootstrap entries that no longer match `state/state.json`.
`bot:topics` checks whether the bot can create private chat topics for Codex Desktop `Chats`.

## 3. Telegram Commands

Bot commands are for operational state, not full config editing.

Working commands today:

- `/help` or `/start` - shows help in the chat/topic where it was asked.
- `/model [model-id]` - shows or changes the default Codex model through local app-server config.
- `/think [low|medium|high|xhigh]` or `/reasoning ...` - shows or changes default reasoning for new turns.
- `/fast [on|off]` - toggles the fast tier for new turns.
- `/compact` - starts compaction for the bound Codex thread.
- `/attach <thread-id>` - binds the current chat/topic to a Codex thread.
- `/attach-latest` - binds this forum topic to the newest unbound thread for the mapped project.
- `/detach` - removes the current binding.
- `/status` - shows current binding status.
- `/health` - checks current chat/topic, project mapping and transport endpoints.
- `/settings` or `/config` - shows safe read-only runtime settings without secrets.
- `/queue` - shows queued prompts for this topic.
- `/pause` and `/resume` - pause/resume the topic queue.
- `/cancel-queue` - clears queued prompts in this topic.
- `/steer <text>` - explicitly sends guidance into the currently running Codex turn. It needs live `app-control`; normal text queues instead.
- `/project-status [count]` - previews desired project thread working set.
- `/sync-project [count] dry-run` - safe preview for topic rename/reopen/create/park.
- `/sync-project [count]` - applies that working-set sync.
- `/mode native` - pins the binding transport to native. It is the only supported v1 mode.

Project auto-sync uses the same sync plan as `/project-status` and `/sync-project`, but only when `topicAutoSyncEnabled` is explicitly true. It creates/reopens/renames/parks sync-managed topics inside the configured working-set limit. It does not delete topics and does not mutate manual bindings.

Private Codex Chat auto-sync is separate. When `privateTopicAutoSyncEnabled` is on, the bridge periodically looks for fresh projectless Codex Desktop `Chats` and creates or renames matching private topics inside the bot direct chat. It never deletes topics, never parks old private topics, and deliberately does not use the experimental app-server `thread/start` path.

Telegram's command menu prefers underscores, so the bridge also accepts `/attach_latest`, `/project_status`, `/sync_project`, `/mode_native` and `/cancel_queue`. The old hyphen commands still work; the menu-safe aliases are just less annoying in real Telegram clients.

What commands mutate:

- Codex local config for model, reasoning and fast tier
- current bound Codex thread compaction state
- bindings in `state/state.json`
- project/topic sync state
- topic queue state
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
