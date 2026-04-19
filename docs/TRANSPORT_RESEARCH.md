# Transport Research Spike

Date: 2026-04-19

This spike looked at the next serious path for making Telegram feel less like a clever bot and more like a real Codex surface. Short version: stop chasing renderer internals for streaming. The promising surface is Codex app-server v2 events.

## What Changed My Mind

Current bridge behavior is good but still indirect:

- Telegram sends a turn through app-control send-only when possible.
- Telegram progress/final mostly comes from the rollout mirror.
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

If that works, the bridge can move from `app-control send + rollout mirror` to `app-server turn/start + app-server stream`, with rollout mirror kept as a fallback and reconciliation source.

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
- `sendMessageDraft` streams a partial message while it is being generated, but the method targets private chats. Nice for a future private-topic mode, not a replacement for progress bubbles in project supergroups.
- Private chats can now have topics for bots. Interesting, but it fights our current product shape where one group maps to one Codex project.
- Managed Bots in Bot API 9.6 are the big onboarding lead. Telegram now has `request_managed_bot`, `getManagedBotToken`, `replaceManagedBotToken` and `https://t.me/newbot/{manager_bot_username}/...` links. If this is usable enough, the install flow can stop saying "go wrestle BotFather" and instead guide the user through a tighter manager-bot flow.
- Native Telegram Checklists look tempting for Codex Todo, but sending/editing checklists is currently business-account-shaped. Worth a spike, not a default.
- Inline keyboards are still the cleanest way to keep ops actions out of working topics: preview, apply, cleanup, smoke, retry, open runbook.

The first Bot API helper layer now covers `deleteMessages`, private-chat `sendMessageDraft`, inline-keyboard markup on messages, and bot profile/admin-rights calls. That is deliberately only plumbing; the product decision is still "use these where they keep the working surface clean."

The first install polish path now exposes those profile/admin-rights helpers through `npm run bot:polish`. It also uses underscore command aliases (`/sync_project`, `/project_status`) because Telegram's command menu is not fond of our nicer-looking hyphen commands. Tiny detail, real UX.

Pinned status bars now send reset times as Telegram `date_time` entities. The visible text stays compact (`reset 23:58`), while newer clients can attach the underlying Unix time and local formatting.

## Recommendation

Next implementation step:

- Build an app-server stream probe, not a full rewrite.
- Feed the probe into the existing `outbound-progress`/`progress-bubble` shapes.
- Keep app-control send-only as the current happy path until the probe proves app-server streaming is stable.
- Do not chase `sendMessageDraft` for project topics unless Telegram expands it beyond private chats.
- Add a managed-bot onboarding spike after streaming, because that could remove one of the ugliest install steps.

The first probe now lives in:

```bash
npm run app-server:probe -- --thread-id <codex-thread-id> --prompt "Reply exactly: STREAM_PROBE_OK" --out logs/app-server-stream-probe.ndjson
```

It does not wire Telegram yet. It records what Codex app-server actually emits so the next transport slice can be boring instead of brave.

## Sources

- Codex app-server docs: https://developers.openai.com/codex/app-server
- Codex hooks docs: https://developers.openai.com/codex/hooks
- Codex feature maturity docs: https://developers.openai.com/codex/feature-maturity
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Bot API changelog: https://core.telegram.org/bots/api-changelog
