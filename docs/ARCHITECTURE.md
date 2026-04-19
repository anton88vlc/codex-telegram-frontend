# Architecture

This project has one job: make Telegram feel like a clean remote surface for local Codex Desktop.

It is not a new Codex runtime. `bridge.mjs` is the process entrypoint and polling loop. Product logic belongs in `lib/`; if the entrypoint starts feeling clever again, something escaped its module.

## Runtime Flow

Telegram inbound:

1. `bridge.mjs` polls Telegram updates and groups media albums.
2. `lib/message-routing.mjs` normalizes commands, mentions and unbound group messages.
3. Attachments and voice notes are prepared by `lib/telegram-attachments.mjs` and `lib/voice-transcription.mjs`.
4. `lib/inbound-turn-runner.mjs` owns the Telegram-originated turn: binding validation, surrogate transcript/attachment bubbles, progress bubble setup and native send.
5. Binding/state lookup happens through `lib/state.mjs`, `lib/project-data.mjs`, `lib/private-topic-bindings.mjs` and `lib/project-sync.mjs`.
6. Codex turns are sent through `lib/codex-native.mjs`.
7. Telegram progress, final answers, status bars and typing hints are updated from the bridge loop.

Codex outbound:

1. `bridge.mjs` watches Codex rollout files and app-server stream events.
2. `lib/thread-rollout.mjs` parses user/final/commentary/plan chunks.
3. `lib/outbound-mirror-messages.mjs` formats mirrored user/assistant messages.
4. `lib/outbound-progress.mjs` builds progress text, while `lib/outbound-progress-message.mjs` owns send/edit state.
5. `lib/worktree-summary.mjs` adds changed-file context.
6. `lib/app-server-stream-runner.mjs` coalesces optional app-server events into the same progress path.
7. `lib/status-bar-runner.mjs` and `lib/typing-heartbeat-runner.mjs` keep pinned status and native typing hints current.
8. `lib/telegram.mjs` sends or edits Telegram messages.

## Current Module Shape

- `bridge.mjs` - process entrypoint, update checkpointing and orchestration loop. Keep it boring.
- `lib/config.mjs` - config defaults, local file parsing and secret lookup.
- `lib/telegram.mjs` - raw Telegram Bot API calls and rendering chunks.
- `lib/telegram-targets.mjs` - chat/topic target helpers and small Telegram formatting helpers.
- `lib/inbound-turn-runner.mjs` - Telegram-originated turn orchestration: prompt prep, transcript/attachment receipts, progress bubbles and native send result handling.
- `lib/unbound-group-rescue.mjs` - General/All accidental-message rescue into the most active bound topic.
- `lib/command-response.mjs` - command replies, including quiet ops-to-DM routing.
- `lib/command-handlers.mjs` - `/help`, `/attach`, `/status`, `/health`, `/settings`, `/project-status`, `/sync-project` and `/mode` routing.
- `lib/codex-native.mjs` - `app-control` plus `app-server` transport wrapper.
- `lib/binding-send-validation.mjs` - pre-send binding safety checks, private Chat DB grace and archived-thread rescue.
- `lib/native-transport-state.mjs` - app-control cooldown and fallback state.
- `lib/health-report.mjs` - `/status` and `/health` text shaping, state-doctor/event-log sampling and binding diagnostics.
- `lib/private-topic-bindings.mjs` - private bot topics mapped to Codex Desktop `Chats`.
- `lib/project-sync.mjs` - project topic sync planning.
- `lib/project-sync-runner.mjs` - project status rendering, `/sync-project` application and optional auto-sync orchestration.
- `lib/outbound-binding-eligibility.mjs` - shared checks for mirror/status/typing eligible bindings.
- `lib/outbound-mirror-messages.mjs` - pure text shaping for Codex Desktop-originated mirrors.
- `lib/outbound-memory.mjs` - shared outbound Telegram message ids and rollout suppression memory.
- `lib/outbound-mirror-runner.mjs` - rollout mirror delivery, suppression, pending retry state and progress/final routing.
- `lib/outbound-progress.mjs` - progress bubble text.
- `lib/outbound-progress-message.mjs` - progress bubble send/edit/finalization.
- `lib/app-server-stream-runner.mjs` - optional app-server stream subscription and progress coalescing.
- `lib/worktree-summary.mjs` - git changed-file summaries plus per-turn baseline/delta helpers.
- `lib/status-bar.mjs` - compact pinned topic status.
- `lib/status-bar-runner.mjs` - status bar reserve/refresh orchestration.
- `lib/typing-heartbeat.mjs` - raw Telegram typing heartbeat timer.
- `lib/typing-heartbeat-runner.mjs` - binding-aware typing heartbeat orchestration.
- `lib/runtime-health.mjs` and `lib/state-doctor.mjs` - diagnostics and safe repair planning.

## Refactor Direction

Do not build a giant framework around this. The right move is boring extraction:

1. Keep `bridge.mjs` as the only executable bridge entrypoint.
2. Move cohesive behavior into small `lib/*.mjs` modules.
3. Add tests for every extracted module before touching live Telegram state.
4. Prefer dependency injection in tests only where a module would otherwise hit Telegram, Codex or the filesystem.
5. Keep runtime files in `state/`, `logs/`, `config.local.json` and `admin/.env` out of git.

Current cleanup status:

- The big bridge split is done enough to stop doing refactor for refactor's sake.
- `bridge.mjs` now tells the outer story: poll, checkpoint, route, sync loops, save.
- New extraction should be driven by behavior pressure, not by a craving for prettier imports.

Bad next slices:

- A generic domain layer nobody asked for.
- A class hierarchy for Telegram messages.
- Moving code just to make imports look fancy while behavior stays impossible to test.

The target shape is simple: `bridge.mjs` tells the story, `lib/` does the work, tests guard the weird Telegram/Codex edge cases.
