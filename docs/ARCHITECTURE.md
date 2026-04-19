# Architecture

This project has one job: make Telegram feel like a clean remote surface for local Codex Desktop.

It is not a new Codex runtime. `bridge.mjs` is still the process entrypoint, but it should keep shrinking into orchestration glue. Product logic belongs in `lib/`.

## Runtime Flow

Telegram inbound:

1. `bridge.mjs` polls Telegram updates and groups media albums.
2. `lib/message-routing.mjs` normalizes commands, mentions and unbound group messages.
3. Attachments and voice notes are prepared by `lib/telegram-attachments.mjs` and `lib/voice-transcription.mjs`.
4. Binding/state lookup happens through `lib/state.mjs`, `lib/project-data.mjs`, `lib/private-topic-bindings.mjs` and `lib/project-sync.mjs`.
5. Codex turns are sent through `lib/codex-native.mjs`.
6. Telegram progress, final answers, status bars and typing hints are updated from the bridge loop.

Codex outbound:

1. `bridge.mjs` watches Codex rollout files and app-server stream events.
2. `lib/thread-rollout.mjs` parses user/final/commentary/plan chunks.
3. `lib/outbound-progress.mjs` builds the live progress bubble.
4. `lib/worktree-summary.mjs` adds changed-file context.
5. `lib/telegram.mjs` sends or edits Telegram messages.

## Current Module Shape

- `bridge.mjs` - process entrypoint and orchestration loop. Keep it boring.
- `lib/config.mjs` - config defaults, local file parsing and secret lookup.
- `lib/telegram.mjs` - raw Telegram Bot API calls and rendering chunks.
- `lib/telegram-targets.mjs` - chat/topic target helpers and small Telegram formatting helpers.
- `lib/command-response.mjs` - command replies, including quiet ops-to-DM routing.
- `lib/codex-native.mjs` - `app-control` plus `app-server` transport wrapper.
- `lib/native-transport-state.mjs` - app-control cooldown and fallback state.
- `lib/private-topic-bindings.mjs` - private bot topics mapped to Codex Desktop `Chats`.
- `lib/project-sync.mjs` - project topic sync planning.
- `lib/outbound-progress.mjs` - progress bubble text.
- `lib/status-bar.mjs` - compact pinned topic status.
- `lib/runtime-health.mjs` and `lib/state-doctor.mjs` - diagnostics and safe repair planning.

## Refactor Direction

Do not build a giant framework around this. The right move is boring extraction:

1. Keep `bridge.mjs` as the only executable bridge entrypoint.
2. Move cohesive behavior into small `lib/*.mjs` modules.
3. Add tests for every extracted module before touching live Telegram state.
4. Prefer dependency injection in tests only where a module would otherwise hit Telegram, Codex or the filesystem.
5. Keep runtime files in `state/`, `logs/`, `config.local.json` and `admin/.env` out of git.

Good next slices:

- `lib/bridge-bindings.mjs` for binding payloads, attach/detach formatting and validation.
- `lib/outbound-mirror.mjs` for rollout mirror selection, suppression and final/progress message sending.
- `lib/status-bar-runner.mjs` for reserve/refresh status-bar orchestration.
- `lib/project-sync-runner.mjs` for applying sync plans through Telegram admin calls.

Bad next slices:

- A generic domain layer nobody asked for.
- A class hierarchy for Telegram messages.
- Moving code just to make imports look fancy while behavior stays impossible to test.

The target shape is simple: `bridge.mjs` tells the story, `lib/` does the work, tests guard the weird Telegram/Codex edge cases.
