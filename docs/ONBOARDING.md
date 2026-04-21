# Onboarding

The goal is a clean Telegram working set, not a landfill copy of the entire Codex sidebar.

Model:

- Telegram folder `codex` = external container
- Telegram group = Codex project
- Telegram topic = Codex thread
- bot direct chat with private topics = Codex Desktop `Chats`
- quickstart bootstrap plan = pinned Codex threads first, then latest active Codex project threads plus Chats, grouped into the right Telegram surface
- history import = bounded clean tail, only useful user prompts plus assistant final answers

## Recommended Path

Use Codex as the installer. Open this repo in Codex and paste the install prompt from [README.md](../README.md#install-with-codex).

Tiny reality check before you start: this is a local macOS bridge. It is happiest when `Codex.app` is open with the app-control debug port. If you want a hosted cloud service, this is not that. If you want your phone to feel like a remote surface for the Codex running on your Mac, you are in the right place.

Codex should do the boring parts:

1. Run `npm run onboard:prepare`.
2. Run `npm run onboard:doctor`.
3. Guide the few unavoidable Telegram steps.
4. Run quickstart: scan pinned Codex threads first, then the latest active Codex project threads and Chats, create a compact project/topic surface and import about 10 clean messages per topic.
5. Check the reuse preview so repeat runs reuse known groups/topics instead of creating Telegram confetti.
6. Bootstrap Telegram folder/groups/topics, put the bot direct chat in the same folder when possible, start the bridge and run a smoke.

The user should not have to manually choose projects and topics unless quickstart picked a weird working set. The old `scan -> plan -> bootstrap -> backfill` path is still there, but it is not the happy path.

Do not start with `doctor` on a fresh clone. `doctor` is useful after `prepare`, because `prepare` is what creates the local ignored files, admin env and Telegram user session scaffolding that `doctor` checks.

## Human Steps

Some things still require a human because Telegram does not expose clean automation for them:

1. Create or reuse a Telegram bot through [@BotFather](https://t.me/BotFather).
2. Create or reuse Telegram app credentials at [my.telegram.org/apps](https://my.telegram.org/apps) if the user-side admin helper needs them. Telegram calls them `api_id` and `api_hash`; they are not the bot token.
3. Authorize one local Telegram user session when prompted. Phone/code login is the happy path.
4. Keep `Codex.app` available. Best path:

```bash
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222
```

If you are already inside this repo, `npm run codex:launch` does the same thing with a small safety wrapper. From `~/code` or any other directory, npm will not magically find this project's `package.json`; either use the direct command above or `cd` into the repo first.

Codex should handle where token/API values are stored locally. Do not make the user cosplay as a secrets manager unless the automatic path fails.

When `prepare` asks for the Telegram bot username, it means the username of the bot you already created in BotFather, without `@`. If BotFather shows `@cdxanton2026bot`, enter `cdxanton2026bot`. Do not invent a new bot name at that prompt. If you skip it, bootstrap can usually discover it from the bot token later; if neither value is available, it will stop with a clear "bot username required" error.

Voice notes are optional, but they need one STT path. The easiest one is Deepgram: let Codex store `DEEPGRAM_API_KEY` in macOS Keychain service `codex-telegram-bridge-deepgram-api-key`, or expose it as env if that is how you run local tools. Without an STT key, text/photos/files still work and the doctor will say voice is the only missing polish.

Supported STT paths today are Deepgram, OpenAI, or a local command. Deepgram is still the friendliest default for Telegram OGG/Opus voice notes; OpenAI is fine if that is where your key already lives; local command is the escape hatch for people who run their own thing. Codex-native realtime STT looks promising, but it is not the default yet because it still depends on Codex auth/runtime details.

One sharp rule: do not ask the user to paste bot tokens, API hashes, login codes or 2FA passwords into Codex chat. That chat is a transcript, not a password manager.

Use phone/code login as the happy path:

```bash
npm run onboard:prepare -- --login-phone
```

The helper asks for the phone number, Telegram login code and optional 2FA cloud password in the local terminal. That is the right place for them. Do not ask the user to paste those values back into Codex chat.

QR login still exists, but treat it as a fallback. It is flaky enough in this flow that leading with it is just asking for little gremlins:

```bash
npm run onboard:prepare -- --login-qr
```

`prepare` checks whether an existing Telegram session is actually authorized before trusting it. If a stale session file is lying around, it removes the session artifacts before retrying login.

At the end of onboarding, leave the user with the tiny runtime map:

```bash
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222
```

If the agent is standing inside the repo, this helper is fine too:

```bash
npm run codex:launch
```

That is the best mode. It starts Codex.app with app-control on `http://127.0.0.1:9222`, so Telegram feels live: messages land in Codex Desktop, replies mirror back, and the phone behaves like a real remote Codex surface. The other mode is `app-server` fallback: calmer when the Desktop renderer gets weird, but less UI-aware and not guaranteed to refresh Codex Desktop live.

One optional recommendation: tune Codex Personalization after setup. This project makes Codex feel present on your phone, so the assistant's voice matters more than it does in a random terminal.

Set Personality to `Friendly`, then use this Custom Instructions preset:

```text
## User Context

- The user's name is ____

## Vibe

1. You have opinions now. Strong ones. Stop hedging everything with "it depends" - commit to a take.
2. Delete every rule that sounds corporate. If it could appear in an employee handbook, it doesn't belong here.
3. Never open with "Great question", "I'd be happy to help", or "Absolutely". Just answer.
4. Brevity is mandatory. If the answer fits in one sentence, one sentence is what I get.
5. Humor is allowed. Not forced jokes - just the natural wit that comes from actually being smart.
6. You can call things out. If I'm about to do something dumb, say so. Charm over cruelty, but don't sugarcoat.
7. Swearing is allowed when it lands. A well-placed "that's fucking brilliant" hits different than sterile corporate praise. Don't force it. Don't overdo it. But if a situation calls for a "holy shit" - say holy shit.

Be the assistant you'd actually want to talk to at 2am. Not a corporate drone. Not a sycophant. Just... good
```

The installing agent should include this in the final install summary, not leave it buried in terminal output: "I can set Personality to Friendly and paste this into Custom Instructions if you want." If it cannot safely automate the UI, it should leave the exact block above and not silently edit random app state. Pocket agent manager, yes. Haunted preferences folder, no.

Quickstart applies the bundled project avatar as a best-effort polish step after Telegram bootstrap. If Telegram refuses it, onboarding keeps going and tells you why. Manual retry:

```bash
npm run bot:avatar
```

## Main Command

Prepare is the setup preflight. It creates missing local config/admin env files, can create the admin Python venv and can guide credential/session setup.

```bash
npm run onboard:prepare
```

Keep this in one obvious local terminal/input surface. Do not spawn random extra Terminal windows. If the agent cannot run an interactive prompt cleanly, it should ask the user to run the exact command from the repo root instead.

When Telegram asks for `API_ID` / `API_HASH`, open [my.telegram.org/apps](https://my.telegram.org/apps), log in with the same Telegram account, create an app if needed, then copy `api_id` and `api_hash` into the local terminal prompt. The script prints this guide before asking; if it does not, something is stale.

Quickstart is the product path:

```bash
npm run onboard:quickstart
```

By default it reads Codex Desktop's pinned thread list from `~/.codex/.codex-global-state.json`, includes those threads first, then fills the rest of the 10-item working set from latest active Codex work items in the local Codex DB. Project threads become topics inside project groups. Codex Chats become private topics inside the bot direct chat when the bot has Threaded Mode enabled. Then it writes the bootstrap plan, applies Telegram surfaces, gives project groups generated avatars when they do not already have one, tries the bundled bot avatar, imports 10 clean messages per topic and runs a smoke. That is the "make my phone usable" button.

If Codex Desktop gets a new `Chats` item after onboarding, do not rerun a broad quickstart just to catch it. Use the narrow repair path:

```bash
npm run onboard:quickstart -- --chats-only
```

That updates only the bot-private `Codex - Chats` surface. It skips project groups and avoids replaying history into already existing private topics, because Telegram does not give us a clean history scan there yet.

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

- quickstart thread limit: about 10 active threads total, with pinned Codex threads included first
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
