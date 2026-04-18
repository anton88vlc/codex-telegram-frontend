# Agent Notes

This repo is the Telegram frontend for Codex Desktop. Treat it like a real product, not a toy bot experiment.

## Voice

- Anton prefers Russian in direct conversation unless he clearly switches languages.
- Project docs and Telegram frontend copy are English-first for open-source readiness.
- Documentation should sound like a competent teammate at 2am: direct, practical, a little opinionated. No corporate fog. If something is rough, say it is rough.
- Be concise. If the useful answer fits in one sentence, do not inflate it into a committee memo.

## Product Shape

- Telegram folder `codex` = external container.
- One Telegram group = one Codex project.
- One Telegram topic = one Codex thread.
- Direct bot chat is for rare global/ops work.
- Keep Telegram as a clean working set. Do not mirror every historical Codex thread and turn the user's phone into a landfill.
- Keep ops/admin noise away from working topics whenever possible.

## Runtime Boundary

- This is a frontend, not a standalone Codex runtime.
- Current v1 assumes macOS with local `Codex.app`.
- Preferred transport is `app-control` at `http://127.0.0.1:9222`, usually from:

```bash
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222
```

- `app-server` fallback is useful resilience, not the happy path.
- If `Codex.app` is closed or crashed, say that plainly in Telegram UX instead of pretending the bridge can complete real Codex work.

## Local Files

These are local/runtime artifacts. Do not commit them unless the user explicitly asks and the file is intentionally sanitized:

- `config.local.json`
- `state/state.json`
- `state/bootstrap-result.json`
- `state/*.session`
- `admin/.env`
- `admin/bootstrap-plan.json`
- `admin/bootstrap-plan.rehearsal.json`
- `logs/*`

## Working Rules

- Inspect before editing. This repo has live Telegram state and local Codex state; guessing is how weird ghosts get created.
- Do not revert unrelated user changes. There may be intentional dirty work in progress.
- Use dry-run paths before destructive Telegram actions. Topic cleanup and backfill are especially easy to make ugly.
- Keep commits small and meaningful. Anton explicitly wants a readable project history.
- If you touch docs, keep the tone human and direct.

## Checks

Use the smallest check that proves the change, then go wider before committing important slices:

```bash
npm test
npm run check
node bridge.mjs --self-check --config /Users/antonnaumov/code/codex-telegram-frontend/config.local.json
```

For live UX changes, add a real Telegram smoke when safe. If Codex Desktop is down or only fallback is available, say so instead of hiding the weak evidence.
