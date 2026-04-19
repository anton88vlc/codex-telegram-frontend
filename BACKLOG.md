# Backlog

## Product Guardrail

1. The goal is not a pixel clone. The goal is a credible remote Codex surface on a phone: Telegram folder `codex` = external container, one group = one Codex project, topic list inside the group = mobile version of the Codex project thread column, one topic = one Codex thread, a small number of direct chats = projectless/global chats.
2. Every UX decision should pass this check: does it feel closer to Codex Desktop, where project, thread list and working context are easy to scan, or did we slide back into a random bot chat?
3. Do not mirror every possible thread and do not turn Telegram into a dump. Keep a clean working set where topics represent the current project threads, not the infinite historical tail.
4. Do not turn the working surface into an admin panel. Ops/admin noise must support the chat-like work experience, not dominate it.
5. Telegram frontend copy should be English-first for open-source readiness. User prompts and final answers should keep the original thread language.

## P1 - Bring Telegram UX Closer To Codex

1. ~~In-place commentary/progress bubbles instead of silence followed by one final answer.~~
2. True streaming from Codex. Current progress is honest rollout/commentary mirroring, not raw app-server event streaming.
3. ~~Ops command reply policy corrected: help, health, settings, project-status and sync previews answer where they were asked instead of silently jumping to bot DM.~~
4. Dedicated ops topic or configurable explicit ops routing, so genuinely noisy admin flows can move away without surprising the user.
5. ~~Telegram HTML rendering for bold, italic, code, code fences, lists, task lists, links, blockquotes, spoilers and plain fallback.~~
6. ~~Richer rendering polish: Markdown tables and cleaner local file links.~~
7. ~~Onboarding wizard base: doctor, project/thread selection, plan write, optional bootstrap, clean rebuild preview, backfill and smoke.~~
8. ~~Onboarding polish base: safer reuse preview, clearer selectors and actionable recovery hints when setup is incomplete.~~
9. ~~Agent-led install docs: public docs let a new user open Codex in this repo, paste one clear install prompt, and let Codex drive doctor/setup/wizard/bootstrap/backfill/smoke while asking only for unavoidable Telegram steps.~~
10. ~~Agent-led onboarding automation hardening base: `onboard:prepare` creates local config/admin env files, can set up the admin Python venv, guides credential wiring and can run QR login before the wizard path.~~
11. Onboarding recovery hardening for bad-but-present Telegram credentials/session errors, not only missing files.

## P2 - Transport And Observability

1. Prototype app-server v2 event streaming as the next transport layer. Local Codex 0.121.0 exposes `item/agentMessage/delta`, `item/reasoning/*`, `turn/plan/updated`, `turn/diff/updated`, `thread/tokenUsage/updated`, `account/rateLimits/updated` and tool/file-change progress events, which is a much better source than renderer polling.
2. ~~Structured event/audit log at `logs/bridge.events.ndjson`, sampled by `/health`.~~
3. Event log retention and nicer operator views once the structured log gets real usage.
4. Codex Hooks spike: evaluate experimental `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop` hooks for lifecycle logging, completion checks and local guardrails. Do not treat hooks as the main streaming transport yet: current tool hooks mostly see Bash and do not cover MCP, WebSearch or other non-shell tools.
5. Telegram native streaming/draft spike: `sendMessageDraft` is interesting for private chats with topics, but it is not the project-group happy path because Bot API targets private chats for drafts.
6. ~~Telegram cleanup helper base: Bot API `deleteMessages` batching for bot-deletable cleanup where possible.~~ Keep Telethon/user-session cleanup for older or non-bot-owned history.
7. Wire app-server stream probe results into the live bridge once the probe has stable evidence from real turns.

## P3 - Product Surface

1. Attachments and images.
2. Voice / audio ingress.
3. Auto-create topic rules for fresh threads without turning Telegram into a dump.
4. Heartbeat transport as an alternative mode for UI-visible jobs.
5. Managed-bot onboarding spike: Bot API 9.6 added managed bots and `t.me/newbot/...` links. Investigate whether a manager bot can make first install less BotFather-heavy without adding a creepy SaaS control plane.
6. Native Telegram Checklist spike for Codex Todo blocks. Likely not default yet because Bot API checklist sending is business-account-shaped, but it is worth validating before we keep hand-rendering Todo forever.
7. ~~Telegram `date_time` entity base for compact rate-limit resets in the pinned status bar.~~ Live visual polish can still tune the exact format after mobile review.
8. ~~Bot profile/install polish base: default administrator rights, command menu, menu button and profile descriptions.~~ Cleaner topic/project icons still need a visual pass.
9. ~~Add the bot direct chat to the `codex` Telegram folder during bootstrap when possible.~~
10. ~~Bot avatar polish: bundled default avatar plus `bot:avatar` command using Telegram MTProto `photos.uploadProfilePhoto(bot=...)`.~~ Future pass can make project-specific icons if that becomes useful.

## P4 - UX Modes

1. Split Telegram UX into two explicit modes: `chat-like` for normal work and `ops-like` for service commands, so the system does not look like an admin panel after P1.
2. ~~First routing lesson: silent DM detours feel worse than local replies. Commands now answer in-place by default.~~
3. Inline-keyboard ops actions: `Apply`, `Retry`, `Run smoke`, `Copy command`, `Open runbook`, routed explicitly to DM or ops topic instead of polluting work topics.

## Done

1. Read-only `/settings` and `/config` command for safe non-secret runtime settings; Telegram-side config editing stays intentionally out.
2. Heavier `/health`: delivery clues, fallback counters and recent failures.
3. Explicit offline/degraded UX for closed or crashed `Codex.app`: short Telegram status, retry clues and clear distinction between preferred `app-control` and fallback app-server.
4. Configurable Telegram ingress transport with local `app-server`-first mode and app-control cooldown, so a flaky renderer debug endpoint does not keep crashing the desktop app during phone-originated prompts.
5. Codex task plans are mirrored into Telegram progress bubbles as compact `Todo` blocks below live commentary updates.
6. App-control send-only mode is the default happy path: `threads.send_message` only, no renderer `threads.read` polling, with rollout mirror as the source for Telegram progress/final.
7. Compact changed-files summary in Telegram progress bubbles, sourced from the thread git worktree instead of renderer state, with turn-baseline commits plus the current dirty worktree.
8. `npm run codex:launch` starts the Codex Desktop happy path with the app-control debug port, and onboarding doctor now points users there instead of leaving them with a magic manual command.
9. Structured event/audit log at `logs/bridge.events.ndjson`; `/health` samples that instead of treating launchd stderr as the product observability layer.
10. Clean history import defaults moved into config/plan: message tail size, optional user prompt cap, assistant phases and heartbeat inclusion.
11. Telegram HTML rendering layer for common Markdown and safe plain-text fallback.
12. Onboarding wizard base flow with doctor, plan, optional bootstrap, cleanup/backfill preview and smoke.
13. Agent-led onboarding docs: README install prompt, simplified onboarding guide and lower-level commands reframed as escape hatches.
14. `onboard:prepare` for agent-led local setup: safe config/admin env creation, optional admin venv install, credential prompts and QR-login handoff.
15. Richer Telegram rendering polish: Markdown tables become compact monospace blocks, and local file links render as readable code text instead of broken phone links.
16. Onboarding polish base: doctor prints exact recovery steps, wizard shows reuse/create preview from the local bootstrap index, and selectors include recency/model/token hints.
17. Transport research spike: official Codex app-server, hooks and Telegram Bot API docs reviewed; app-server v2 events are the strongest next path, managed bots are the biggest onboarding lead, and Telegram drafts/checklists are useful but constrained.
18. App-server stream probe base: CLI probe plus tested event normalization for assistant deltas, reasoning, Todo, diffs, token/rate updates and tool progress.
19. Telegram Bot API helper base for cleanup batches, private-chat drafts, inline keyboard markup and bot profile/admin-rights polish.
20. Bot install polish script: dry-run/apply flow for command menu, profile text, menu button and suggested admin rights, plus Telegram-menu-safe command aliases.
21. Status bar reset times now use Telegram `date_time` entities while keeping the plain compact text readable.
22. Telegram command replies now stay in the chat/topic where the command was sent; direct chat is no longer the surprise default for project/status/sync output.
23. Bootstrap now includes the bot direct chat in the Telegram folder alongside project groups, with `--skip-bot-folder` as the escape hatch.
