# Onboarding

The goal is a clean Telegram working set, not a landfill copy of the entire Codex sidebar.

Model:

- Telegram folder `codex` = external container
- Telegram group = Codex project
- Telegram topic = Codex thread
- bot direct chat with private topics = Codex Desktop `Chats`
- quickstart bootstrap plan = latest active Codex project threads plus Chats, grouped into the right Telegram surface
- history import = bounded clean tail, only useful user prompts plus assistant final answers

## Recommended Path

Use Codex as the installer. Open this repo in Codex and paste the install prompt from [README.md](../README.md#install-with-codex).

Codex should do the boring parts:

1. Run `npm run onboard:prepare`.
2. Run `npm run onboard:doctor`.
3. Guide the few unavoidable Telegram steps.
4. Run quickstart: scan the latest active Codex project threads and Chats, create a compact project/topic surface and import about 10 clean messages per topic.
5. Check the reuse preview so repeat runs reuse known groups/topics instead of creating Telegram confetti.
6. Bootstrap Telegram folder/groups/topics, put the bot direct chat in the same folder when possible, start the bridge and run a smoke.

The user should not have to manually choose projects and topics unless quickstart picked a weird working set. The old `scan -> plan -> bootstrap -> backfill` path is still there, but it is not the happy path.

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

One sharp rule: do not ask the user to paste bot tokens, API hashes, login codes or 2FA passwords into Codex chat. That chat is a transcript, not a password manager. Use QR login first:

```bash
npm run onboard:prepare -- --login-qr
```

If QR login gets stuck or Telegram asks for 2FA, use the local phone-login fallback and let the user type into the terminal prompt:

```bash
npm run onboard:prepare -- --login-phone
```

`prepare` checks whether an existing Telegram session is actually authorized before trusting it. If a stale session file is lying around, it removes the session artifacts before retrying login.

If the bot is yours, Codex can also apply the bundled project avatar:

```bash
npm run bot:avatar
```

## Main Command

Prepare is the setup preflight. It creates missing local config/admin env files, can create the admin Python venv and can guide credential/session setup.

```bash
npm run onboard:prepare
```

Quickstart is the product path:

```bash
npm run onboard:quickstart
```

By default it scans the 10 latest active Codex work items across the local Codex DB. Project threads become topics inside project groups. Codex Chats become private topics inside the bot direct chat when the bot has Threaded Mode enabled. Then it writes the bootstrap plan, applies Telegram surfaces, imports 10 clean messages per topic and runs a smoke. That is the "make my phone usable" button.

If private bot topics are not enabled yet, quickstart should keep project onboarding alive and report the Chats surface warning plainly. Rough beta edges are fine; silent fake project groups are not.

Check the bot-private `Chats` surface directly:

```bash
npm run bot:topics
```

If it says private topics are off, open @BotFather, select the bot, enable forum/topic mode in private chats in the BotFather Mini App, then rerun quickstart. This is Telegram plumbing, not user failure. The product should say that plainly.

Preview without side effects:

```bash
npm run onboard:quickstart -- --preview
```

The wizard is the manual escape hatch:

```bash
npm run onboard:wizard
```

The wizard shows recency/model/token hints in selectors and prints a reuse preview before side effects. If a group/topic is already in the local bootstrap index, it should be listed as reused; if the index is stale, the lower-level bootstrap still tries to reuse live Telegram groups/topics by title.

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

For bot-private Codex `Chats` topics, use `npm run bot:topics -- --smoke --chat-id <telegram-user-id>` for the create/delete capability check, then do the real prompt smoke from Telegram itself. The user-side admin helper intentionally refuses `send-topic-message`, `wait-topic-text` and cleanup there until Telegram's private-topic MTProto path is boring enough.

## Good Defaults

- quickstart thread limit: 10 latest active threads total
- quickstart `historyMaxMessages`: 10
- quickstart Codex Chats surface: private topics in the bot direct chat
- manual wizard `threads-per-project`: 3
- manual wizard `historyMaxMessages`: 40
- `historyAssistantPhases`: `["final_answer"]`
- `historyIncludeHeartbeats`: false
- `sender-mode`: `labeled-bot`
- topic display: `Tabs`
- auto-create new topics: off by default; optional curated auto-sync can be enabled later per local config

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
- Telegram photos/documents in a bound topic are saved locally and sent to Codex as attachment paths
- Telegram voice/audio gets a short italic quoted transcript first; Codex replies to that transcript so the mobile flow stays readable
- `/project-status` and `/sync-project dry-run` do not flood working topics with ops walls
