# Backlog

## Product Guardrail

1. The goal is not a pixel clone. The goal is a credible remote Codex surface on a phone: Telegram folder `codex` = external container, one group = one Codex project, topic list inside the group = mobile version of the Codex project thread column, one topic = one Codex thread, a small number of direct chats = projectless/global chats.
2. Every UX decision should pass this check: does it feel closer to Codex Desktop, where project, thread list and working context are easy to scan, or did we slide back into a random bot chat?
3. Do not mirror every possible thread and do not turn Telegram into a dump. Keep a clean working set where topics represent the current project threads, not the infinite historical tail.
4. Do not turn the working surface into an admin panel. Ops/admin noise must support the chat-like work experience, not dominate it.
5. Telegram frontend copy should be English-first for open-source readiness. User prompts and final answers should keep the original thread language.

## P1 - Bring Telegram UX Closer To Codex

1. ~~In-place commentary/progress bubbles instead of silence followed by one final answer.~~
2. True token streaming from Codex UI. Current progress is honest rollout/commentary mirroring, not raw token streaming.
3. ~~Basic ops/admin quiet path: help, health, settings, project-status and sync previews can route long replies to direct chat.~~
4. Dedicated ops topic or configurable ops routing, so the working topics stay chat-like even under heavier admin use.
5. ~~Telegram HTML rendering for bold, italic, code, code fences, lists, task lists, links, blockquotes, spoilers and plain fallback.~~
6. Richer rendering polish: Markdown tables and cleaner local file links.
7. ~~Onboarding wizard base: doctor, project/thread selection, plan write, optional bootstrap, clean rebuild preview, backfill and smoke.~~
8. Onboarding polish: safer restore/reuse flows, clearer selectors and nicer recovery when Telegram credentials/session are wrong.
9. ~~Agent-led install docs: public docs let a new user open Codex in this repo, paste one clear install prompt, and let Codex drive doctor/setup/wizard/bootstrap/backfill/smoke while asking only for unavoidable Telegram steps.~~
10. ~~Agent-led onboarding automation hardening base: `onboard:prepare` creates local config/admin env files, can set up the admin Python venv, guides credential wiring and can run QR login before the wizard path.~~

## P2 - Transport And Observability

1. Separate streaming mode on top of app-control if intermediate events can be extracted.
2. ~~Structured event/audit log at `logs/bridge.events.ndjson`, sampled by `/health`.~~
3. Event log retention and nicer operator views once the structured log gets real usage.
4. Codex Hooks spike: evaluate experimental `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop` hooks as a cleaner source for lifecycle events, completion checks, auto-continue and Telegram progress updates. This should complement app-control send-only, not replace it, unless the local proof says otherwise.

## P3 - Product Surface

1. Attachments and images.
2. Voice / audio ingress.
3. Auto-create topic rules for fresh threads without turning Telegram into a dump.
4. Heartbeat transport as an alternative mode for UI-visible jobs.

## P4 - UX Modes

1. Split Telegram UX into two explicit modes: `chat-like` for normal work and `ops-like` for service commands, so the system does not look like an admin panel after P1.
2. ~~First quiet-path slice: noisy ops replies can go to direct chat with a short trace in the topic.~~

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
