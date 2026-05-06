# Transport Research Spike

Date: 2026-04-19

This spike looked at the next serious path for making Telegram feel less like a clever bot and more like a real Codex surface. Short version: stop chasing renderer internals for streaming. The promising surface is Codex app-server v2 events.

## What Changed My Mind

Original bridge behavior was good but still indirect:

- Telegram sent a turn through app-control send-only when possible.
- Telegram progress/final mostly came from the rollout mirror.
- The progress bubble is honest, but not raw Codex event streaming.

The local `codex-cli 0.121.0` app-server schema exposes exactly the events we wanted:

- `item/agentMessage/delta` for assistant text streaming.
- `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta` and `item/reasoning/summaryPartAdded` for reasoning/progress visibility.
- `turn/plan/updated` and `item/plan/delta` for Todo/plan updates.
- `turn/diff/updated` and `item/fileChange/outputDelta` for changed-file UX.
- `thread/tokenUsage/updated` and `account/rateLimits/updated` for status bar data.
- `item/mcpToolCall/progress`, `item/commandExecution/outputDelta` and `item/completed` for tool-level state.

That is almost a checklist of our Telegram UX backlog. Very rude of it to be sitting there like a loaded buffet.

## App-Server Is The Next Transport

Official Codex docs describe app-server as the rich-client protocol for authentication, history, approvals and streamed agent events. It supports stdio and experimental WebSocket transport, uses JSON-RPC-style messages, and lets clients generate version-matched TypeScript or JSON Schema artifacts with:

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

For us, the next slice should be a small, boring probe:

1. Connect to local app-server with `experimentalApi: true`.
2. `thread/resume` the bound Codex thread.
3. Start one controlled test turn.
4. Log the exact notification sequence to `logs/bridge.events.ndjson`.
5. Map events into the existing Telegram progress model without changing Telegram UX yet.

That is now the migration direction: move from `app-control send + rollout mirror` to `app-server turn/start + app-server stream`, with rollout mirror kept as a fallback and reconciliation source.

## Hooks Are Useful, Not The Main Pipe

Codex hooks are real and official, but they are explicitly experimental. They are good for:

- lifecycle logging;
- local policy checks before simple Bash commands;
- post-turn validation;
- auto-memory or analytics experiments;
- adding context on session start.

They are not the streaming backbone for this project yet. Current tool hooks mainly intercept Bash and do not cover MCP, WebSearch, file writes or other non-shell tool calls. Treat hooks as guardrails and observability helpers, not as the thing that drives Telegram messages.

## Telegram Findings

Telegram also shipped a few useful things recently:

- `deleteMessages` can delete 1-100 message ids in one call, within normal Bot API deletion limits. This can make cleanup less slow and less fragile for bot-owned or admin-deletable messages.
- `sendMessageDraft` streams a partial message while it is being generated. The useful product target is Codex Desktop `Chats`, because drafts target private chats/private topics; it is not a replacement for progress bubbles in project supergroups. Keep it opt-in for now: live smokes showed Telegram can leave a stale draft bubble after the final answer, and the Bot API rejects an empty clear attempt.
- Private chats can now have topics for bots. This no longer fights our product shape: project groups still map to Codex projects, while bot-private topics map to Codex Desktop `Chats`. The live bot has Threaded Mode enabled now; keep the preflight because new installs still need that BotFather switch.
- Managed Bots in Bot API 9.6 are the big onboarding lead. Telegram now has `request_managed_bot`, `getManagedBotToken`, `replaceManagedBotToken` and `https://t.me/newbot/{manager_bot_username}/...` links. If this is usable enough, the install flow can stop saying "go wrestle BotFather" and instead guide the user through a tighter manager-bot flow.
- Bot API profile photo support means the avatar path has moved from the MTProto `photos.uploadProfilePhoto(bot=...)` workaround to official `setMyProfilePhoto`.
- Native Telegram Checklists looked tempting for Codex Todo, but the current Bot API methods are business-account-shaped: `sendChecklist` and `editMessageChecklist` both require `business_connection_id`. Do not build this into the normal group/topic UX. Keep Codex Todo as compact text in progress bubbles, and revisit only if Telegram exposes checklist send/edit for ordinary bots in groups and bot-private topics.
- Sender/member tags may help role clarity later, but they are easy to overuse. Keep the working surface calm.
- `copyMessages` is worth keeping in the back pocket for richer history/backfill and album preservation.
- Inline keyboards are still the cleanest way to keep ops actions out of working topics: preview, apply, cleanup, smoke, retry, open runbook.

The first Bot API helper layer now covers `deleteMessages`, private-chat `sendMessageDraft`, inline-keyboard markup on messages, and bot profile/admin-rights calls. `sendMessageDraft` remains an experimental opt-in for bot-private Codex Chat topics, not the default path, because it can leave sticky "Working..." drafts after completion. Project groups stay on progress bubbles until Telegram gives bots the same clean draft surface there.

The first install polish path now exposes those profile/admin-rights helpers through `npm run bot:polish`. It also uses underscore command aliases (`/sync_project`, `/project_status`) because Telegram's command menu is not fond of our nicer-looking hyphen commands. Tiny detail, real UX.

Pinned status bars now send reset times as Telegram `date_time` entities. The visible text stays compact (`reset 23:58`), while newer clients can attach the underlying Unix time and local formatting.

## Recommendation

Current implementation direction:

- Keep app-server `turn/start` as the default phone ingress.
- Feed app-server notifications into the existing `outbound-progress`/`progress-bubble` shapes. This is now the live path for progress and final answers.
- Keep rollout mirror as reconciliation/backfill, not as the source that fights app-server events.
- Keep app-control send-only as an optional Desktop-aware lane, not the default phone ingress.
- Tune `sendMessageDraft` only if Telegram exposes a reliable clear/finalize path. Until then, editable progress bubbles are the source of truth.
- Add a managed-bot onboarding spike soon, because that could remove one of the ugliest install steps.
- Keep avatar polish on official Bot API `setMyProfilePhoto`; leave the MTProto helper as a fallback probe only.
- Validate private bot topics end-to-end before making Codex Desktop `Chats` part of the public install promise.

The first probe now lives in:

```bash
npm run app-server:probe -- --thread-id <codex-thread-id> --prompt "Reply exactly: STREAM_PROBE_OK" --out logs/app-server-stream-probe.ndjson
```

The original probe records what Codex app-server actually emits. Keep it around as a diagnostic when Codex updates the protocol and Telegram starts acting haunted.

## Sources

- Codex app-server docs: https://developers.openai.com/codex/app-server
- Codex hooks docs: https://developers.openai.com/codex/hooks
- Codex feature maturity docs: https://developers.openai.com/codex/feature-maturity
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Bot API changelog: https://core.telegram.org/bots/api-changelog
- Telegram bot profile photo via Bot API: https://core.telegram.org/bots/api#setmyprofilephoto
- Telegram Bot API `sendChecklist`: https://core.telegram.org/bots/api#sendchecklist
- Telegram Bot API `editMessageChecklist`: https://core.telegram.org/bots/api#editmessagechecklist
- Legacy Telegram bot profile photo via MTProto: https://core.telegram.org/method/photos.uploadProfilePhoto
