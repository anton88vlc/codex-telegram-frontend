# Backlog

## Product Guardrail

1. The goal is not a pixel clone. The goal is a credible remote Codex surface on a phone: Telegram folder `codex` = external container, one group = one Codex project, topic list inside the group = mobile version of the Codex project thread column, one topic = one Codex thread, a small number of direct chats = projectless/global chats.
2. Every UX decision should pass this check: does it feel closer to Codex Desktop, where project, thread list and working context are easy to scan, or did we slide back into a random bot chat?
3. Do not mirror every possible thread and do not turn Telegram into a dump. Keep a clean working set where topics represent the current project threads, not the infinite historical tail.
4. Do not turn the working surface into an admin panel. Ops/admin noise must support the chat-like work experience, not dominate it.
5. Telegram frontend copy should be English-first for open-source readiness. User prompts and final answers should keep the original thread language.

## Telegram Platform Radar

These are the useful Telegram platform leads found during the April 2026 API pass. Treat this as a ranked implementation queue, not a shiny-object shopping list.

1. ~~Private bot topics for existing Codex Desktop `Chats`.~~ Base onboarding support exists, the live bot has Threaded Mode enabled, `bot:topics` can smoke create/delete private topics, bootstrap creates the bot-direct `Codex - Chats` surface, clean backfill works there and self-check surfaces the status. Keep two rough edges visible: user-side Telethon automation cannot reliably send/read inside bot-private topics yet, and brand-new Desktop `Chats` are not safely creatable from Telegram until we find a true Desktop/app-control create path.
2. True Telegram -> Codex Desktop `New chat` creation for the `Chats` surface. Do not fake this with app-server `thread/start`: it creates a backend thread, but not reliably the same visible Desktop Chat item. Find a renderer/debug action or a safe UI-control path, then re-enable auto-create.
3. `sendMessageDraft` for native "assistant is writing" UX. It streams animated drafts in private chats and private bot topics, so it is perfect for Codex `Chats`; it should not replace project-group progress bubbles unless Telegram opens drafts for supergroups.
4. Managed bots and `t.me/newbot/...` links. This is the big onboarding simplifier: fewer BotFather gymnastics, cleaner token handoff, maybe a future manager-bot flow. Keep it local/user-owned; do not turn the project into a weird SaaS control plane.
5. Official bot avatar API. Bot API now has `setMyProfilePhoto`, so replace the MTProto avatar workaround with the official path when practical.
6. Native Telegram checklists for Codex Todo. Tempting, but `sendChecklist`/`editMessageChecklist` are business-account-shaped right now. Spike before committing; text Todo is still the sane default.
7. Member/sender tags. Potentially useful for visual role clarity (`codex`, `owner`, `operator`) in groups, but low priority and easy to overdo.
8. Reply/quote/entity polish. Keep using compact `date_time` status entities; validate whether `ReplyParameters` quotes can make imported history and surrogate user prompts cleaner.
9. `copyMessages`/album preservation for history/backfill. Useful later if we want richer Telegram-native history import without rebuilding every media group by hand.
10. Local Bot API server for large media. Not needed for the normal install, but worth remembering if attachments move beyond casual screenshots/docs.
11. Skip for now: paid broadcast, message effects, quizzes/polls, channel direct-message suggested posts. Fun API confetti, wrong product surface.

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

1. ~~Prototype app-server v2 event streaming as the next transport layer.~~ The bridge now has an optional passive app-server stream feeding coalesced progress from reasoning, Todo, diff, command and tool events while app-control remains send-only.
2. ~~Structured event/audit log at `logs/bridge.events.ndjson`, sampled by `/health`.~~
3. Event log retention and nicer operator views once the structured log gets real usage.
4. Codex Hooks spike: evaluate experimental `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop` hooks for lifecycle logging, completion checks and local guardrails. Do not treat hooks as the main streaming transport yet: current tool hooks mostly see Bash and do not cover MCP, WebSearch or other non-shell tools.
5. Telegram native streaming/draft spike: wire `sendMessageDraft` into private bot topics first, then decide whether it is good enough for Codex `Chats` before touching project groups.
6. ~~Telegram cleanup helper base: Bot API `deleteMessages` batching for bot-deletable cleanup where possible.~~ Keep Telethon/user-session cleanup for older or non-bot-owned history.
7. ~~Wire app-server stream probe results into the live bridge once the probe has stable evidence from real turns.~~ Keep tuning event coverage with live smokes; raw token-by-token Telegram streaming is intentionally not the goal yet.

## P3 - Product Surface

1. ~~Attachments and images base.~~ Telegram photos/documents are downloaded into ignored local storage and forwarded to Codex as local file paths. Native binary attachment transport can still get better later.
2. ~~Voice / audio ingress base.~~ Telegram voice/audio is transcribed first, shown as an italic quoted transcript, then forwarded to Codex as text. Next polish is provider UX, live partial transcripts and confidence display.
3. ~~Auto-create topic rules for fresh threads without turning Telegram into a dump.~~ Base is optional curated topic auto-sync: off by default, limited per project, freshness-gated and only touches sync-managed topics.
4. Heartbeat transport as an alternative mode for UI-visible jobs.
5. Managed-bot onboarding spike: Bot API 9.6 added managed bots and `t.me/newbot/...` links. Investigate whether a manager bot can make first install less BotFather-heavy without adding a creepy SaaS control plane.
6. Native Telegram Checklist spike for Codex Todo blocks. Likely not default yet because Bot API checklist sending is business-account-shaped, but it is worth validating before we keep hand-rendering Todo forever.
7. ~~Telegram `date_time` entity base for compact rate-limit resets in the pinned status bar.~~ Live visual polish can still tune the exact format after mobile review.
8. ~~Bot profile/install polish base: default administrator rights, command menu, menu button and profile descriptions.~~ Cleaner topic/project icons still need a visual pass.
9. ~~Add the bot direct chat to the `codex` Telegram folder during bootstrap when possible.~~
10. ~~Bot avatar polish: bundled default avatar plus `bot:avatar` command using Telegram MTProto `photos.uploadProfilePhoto(bot=...)`.~~ Replace with official Bot API `setMyProfilePhoto` once the helper is wired.
11. ~~Private-topic enablement guide/check: detect `has_topics_enabled` from `getMe`, explain the BotFather Mini App switch plainly and retry Codex `Chats` topic bootstrap after it is enabled.~~ Live bot enablement and create/delete smoke are green.
12. Backfill/media polish: evaluate `copyMessages` for preserving Telegram albums/history shape where it beats rebuilding messages from scratch.

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
24. Optional passive app-server stream in the live bridge: subscribes to active threads, coalesces noisy reasoning/Todo/diff/command/tool events into the existing Telegram progress bubble, and leaves app-control as the send-only happy path.
25. Telegram typing heartbeat: while a bound topic has an active Codex turn, the bot keeps refreshing the native "typing" action instead of relying on one short-lived `sendChatAction`.
26. Telegram photos/documents ingress base: bot downloads media into `state/attachments`, builds a prompt with local file paths and image markdown hints, then uses the normal Codex transport/progress/reply flow.
27. Changed-files UX fix: progress bubbles compare against a turn-start worktree snapshot, so old dirty files are not reported as fresh work; default file list is full instead of `+N more`.
28. Telegram media albums are grouped by `media_group_id`, so several photos attached at once become one Codex turn, one progress bubble and one reply chain.
29. Telegram voice/audio ingress with Deepgram/OpenAI/custom-command STT, italic transcript bubble, reply-chain UX and no permanent audio file for built-in providers.
30. Public-readiness cleanup pass: secret/local-artifact scan, neutral repo examples, agent notes without personal user context and onboarding doctor validation for placeholder Telegram API credentials.
31. Mobile General/All rescue: plain messages accidentally sent to an unbound group surface are moved into the last active bound topic with a bot-side surrogate user bubble; commands still stay local.
32. Local state doctor base: detects stale topic bindings, dead Telegram topic errors, orphan mirror state and bootstrap-index drift; dry-run/apply repairs only local state files, and `/health` plus self-check surface the warning.
33. Curated topic auto-sync base: optionally scans bootstrapped project groups for fresh active Codex threads, creates/reopens/renames/parks only sync-managed Telegram topics within a small working-set limit and leaves manual topics alone.
34. Quickstart onboarding path: scan the latest active Codex threads, group them by project, create/reuse the Telegram surface, import a 10-message clean tail and run the smoke without forcing manual project/topic selection.
35. Codex Desktop `Chats` onboarding base: quickstart classifies projectless/home/scratch Codex Chats separately from projects and maps them to private topics in the bot direct chat when the bot has Threaded Mode enabled.
36. Private bot topics readiness layer: `npm run bot:topics`, self-check reporting, bootstrap preflight and clean BotFather recovery hints instead of repeated `chat is not a forum` failures.
37. App-server private-topic auto-create spike: proved useful as a backend-thread experiment, then disabled by default because it is not a trustworthy Desktop `Chats` creation path. The lesson is documented so we do not ship fake magic.
38. Private Chat binding hardening: app-server-created experimental bindings can be used before the legacy local threads DB catches up, and empty sqlite lookups no longer poison the bridge.
39. Runtime mode docs: README/RUNBOOK now explain `app-control` as the live near-Mac mode and `app-server` as the calmer remote mode; repeated onboarding/config prose was collapsed back down.
40. Bridge refactor base: outbound mirror text, progress message send/edit, status bar runner, app-server stream runner and typing heartbeat runner are now outside `bridge.mjs` with focused tests. The entrypoint is still big, but it is finally losing weight in the right places.
41. Outbound mirror runner extracted: rollout delivery, suppression handling, pending retry state, changed-files progress and final-answer routing now live in `lib/outbound-mirror-runner.mjs` with tests. This was one of the last high-risk loops sitting raw in `bridge.mjs`.
42. Turn worktree summaries moved into `lib/worktree-summary.mjs`: baseline capture, changed-file delta formatting and cache behavior are now tested outside the bridge.
43. Project sync runner extracted: project status, sync preview/apply and auto-sync orchestration now live in `lib/project-sync-runner.mjs` with Telegram API calls injected in tests.
44. Health report rendering extracted: `/status` and `/health` now live in `lib/health-report.mjs`, with tests for binding diagnostics, event-log fallback and state-doctor clues.
45. Binding send validation extracted: parked-topic blocking, private Chat DB grace, archived-thread rescue and outbound mirror rebasing now live in `lib/binding-send-validation.mjs`.
46. Command handlers extracted: slash-command routing is now in `lib/command-handlers.mjs`, with tests for attach/status/sync/mode flows instead of another blob inside `bridge.mjs`.
