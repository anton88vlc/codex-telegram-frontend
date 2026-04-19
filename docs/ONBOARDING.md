# Onboarding

The goal is a clean Telegram working set, not a landfill copy of the entire Codex sidebar.

Model:

- Telegram folder `codex` = external container
- Telegram group = Codex project
- Telegram topic = Codex thread
- bootstrap plan = explicit choice of projects and threads the user wants in Telegram
- history import = bounded clean tail, only useful user prompts plus assistant final answers

## Recommended Path

Use Codex as the installer. Open this repo in Codex and paste the install prompt from [README.md](../README.md#install-with-codex).

Codex should do the boring parts:

1. Run `npm run onboard:doctor`.
2. Prepare local config and admin dependencies from examples.
3. Guide the few unavoidable Telegram steps.
4. Scan local Codex projects and ask which projects/threads belong on the phone.
5. Run the wizard with explicit side effects only after the plan looks sane.
6. Bootstrap Telegram folder/groups/topics, backfill a bounded clean history tail, start the bridge and run a smoke.

The user should not have to manually stitch together `scan -> plan -> bootstrap -> backfill` unless something weird happens.

## Human Steps

Some things still require a human because Telegram does not expose clean automation for them:

1. Create or reuse a Telegram bot through [@BotFather](https://t.me/BotFather).
2. Create or reuse Telegram app credentials at [my.telegram.org](https://my.telegram.org/) if the user-side admin helper needs them.
3. Authorize one local Telegram user session when prompted.
4. Keep `Codex.app` available. Best path:

```bash
npm run codex:launch
```

Codex should handle where token/API values are stored locally. Do not make the user cosplay as a secrets manager unless the automatic path fails.

## Main Command

The wizard is the product path:

```bash
npm run onboard:wizard
```

Useful side-effect flags:

- `--write` writes the generated bootstrap plan.
- `--apply` creates/reuses Telegram groups/topics and writes bridge bindings.
- `--cleanup-dry-run` previews visible topic messages that would be deleted for a clean rebuild.
- `--cleanup` deletes after preview; sharp tool, not casual tidying.
- `--backfill-dry-run` previews clean history import.
- `--backfill` sends clean history import.
- `--smoke` sends a Telegram smoke prompt and waits for the expected answer.

Disposable rehearsal:

```bash
npm run onboard:wizard:rehearsal
```

Rehearsal uses `codex-lab` / `Codex Lab - ` naming and a small working set. Use it before rebuilding the real `codex` surface.

## Escape Hatch

These commands exist for debugging and recovery, not for the normal install story:

```bash
npm run onboard:scan -- --project-limit 12 --threads-per-project 5
npm run onboard:plan -- --project /path/to/repo --threads-per-project 3 --write
admin/.venv/bin/python admin/telegram_user_admin.py bootstrap --plan admin/bootstrap-plan.json
```

Clean history import can be run directly when needed:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py backfill-thread \
  --thread-id <thread-id> \
  --chat-id <telegram-chat-id> \
  --topic-id <topic-id> \
  --sender-mode labeled-bot \
  --dry-run
```

Run without `--dry-run` only after the preview looks sane. Skipping the preview is how Telegram topics become archaeology.

## Good Defaults

- `threads-per-project`: 3
- `historyMaxMessages`: 40
- `historyAssistantPhases`: `["final_answer"]`
- `historyIncludeHeartbeats`: false
- `sender-mode`: `labeled-bot`
- topic display: `Tabs`
- auto-create new topics: off until rules are explicit

These defaults keep Telegram close to Codex Desktop: curated project/thread surface, not notification soup.

## Verify

```bash
npm run self-check
```

Expected UX:

- active topics have one pinned compact status bar
- user prompts from Codex Desktop appear as bot-side surrogate messages
- assistant progress appears as one editable message with recent visible updates
- final assistant replies attach to the triggering user/surrogate message
- Telegram-originated prompts get one editable progress bubble and a final reply
- `/project-status` and `/sync-project dry-run` do not flood working topics with ops walls
