# Backlog

## Product Guardrail

1. The goal is not a pixel clone. The goal is a credible remote Codex surface on a phone: Telegram folder `codex` = external container, one group = one Codex project, topic list inside the group = mobile version of the Codex project thread column, one topic = one Codex thread, a small number of direct chats = projectless/global chats.
2. Every UX decision should pass this check: does it feel closer to Codex Desktop, where project, thread list and working context are easy to scan, or did we slide back into a random bot chat?
3. Do not mirror every possible thread and do not turn Telegram into a dump. Keep a clean working set where topics represent the current project threads, not the infinite historical tail.
4. Do not turn the working surface into an admin panel. Ops/admin noise must support the chat-like work experience, not dominate it.
5. Telegram frontend copy should be English-first for open-source readiness. User prompts and final answers should keep the original thread language.

## P1 - Bring Telegram UX Closer To Codex

1. True streaming/commentary transport instead of timer-based progress bubbles.
2. Cleaner split between ops/admin quiet path and working replies, possibly with a dedicated ops topic or configurable routing.
3. Richer rendering: blockquotes, tables, cleaner local file links.
4. Onboarding wizard polish: safer clean rebuild flow, restore/reuse existing Telegram surfaces, clearer BotFather/token guidance and nicer selectors.

## P2 - Transport And Observability

1. Separate streaming mode on top of app-control if intermediate events can be extracted.
2. Proper event/audit log instead of manual `bridge.stderr.log` tailing.
3. Move clean history import defaults into config: how many recent messages/turns to import, which assistant phases to include, whether heartbeat/system-like user entries are included.

## P3 - Product Surface

1. Attachments and images.
2. Voice / audio ingress.
3. Auto-create topic rules for fresh threads without turning Telegram into a dump.
4. Heartbeat transport as an alternative mode for UI-visible jobs.

## P4 - UX Modes

1. Split Telegram UX into two modes: `chat-like` for normal work and `ops-like` for service commands, so the system does not look like an admin panel after P1.

## Done

1. Read-only `/settings` and `/config` command for safe non-secret runtime settings; Telegram-side config editing stays intentionally out.
2. Heavier `/health`: delivery clues, fallback counters and recent failures.
3. Explicit offline/degraded UX for closed or crashed `Codex.app`: short Telegram status, retry clues and clear distinction between preferred `app-control` and fallback app-server.
4. Configurable Telegram ingress transport with local `app-server`-first mode and app-control cooldown, so a flaky renderer debug endpoint does not keep crashing the desktop app during phone-originated prompts.
