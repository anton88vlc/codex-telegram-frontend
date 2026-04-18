# Onboarding

Цель onboarding: собрать в Telegram clean working set, а не выгрузить весь Codex sidebar.

Правильная модель:

- Telegram folder `codex` = внешний контейнер
- Telegram group = Codex project
- Telegram topic = Codex thread
- bootstrap plan = явное решение, какие проекты и threads пользователь хочет видеть
- history import = ограниченный clean tail, только user prompts + assistant `final_answer`

## What The User Must Do

Минимальный ручной кусок пока неизбежен:

1. Создать Telegram bot через BotFather и положить token в env или macOS Keychain.
2. Получить `API_ID` / `API_HASH` для user-side Telegram helper.
3. Из repo root скопировать локальные конфиги и поставить admin deps:

```bash
cp config.example.json config.local.json
cp admin/.env.example admin/.env
python3 -m venv admin/.venv
admin/.venv/bin/pip install -r admin/requirements.txt
```

4. Один раз авторизовать user session:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py login-qr
```

BotFather не даёт нормальный публичный API для полностью автоматического создания бота, поэтому этот шаг не надо притворяться автоматизируемым. Всё остальное должно быть максимально scripted.

## Step 1: Scan Codex Projects

Read-only preview из локальной Codex DB:

```bash
npm run onboard:scan -- \
  --project-limit 12 \
  --threads-per-project 5
```

JSON mode для будущего UI/wizard:

```bash
npm run onboard:scan -- \
  --project-limit 12 \
  --threads-per-project 5 \
  --json
```

Пользователь выбирает не всё подряд, а нужные project roots.

## Step 2: Generate Bootstrap Plan

Preview:

```bash
npm run onboard:plan -- \
  --project /path/to/codex-project \
  --project /path/to/another-project \
  --threads-per-project 3 \
  --history-max-messages 40
```

Write `admin/bootstrap-plan.json`:

```bash
npm run onboard:plan -- \
  --project /path/to/codex-project \
  --project /path/to/another-project \
  --threads-per-project 3 \
  --history-max-messages 40 \
  --write
```

Rehearsal preview for a disposable Telegram surface:

```bash
npm run onboard:rehearsal -- \
  --project /path/to/codex-project
```

Rehearsal defaults are intentionally small: 2 projects, 2 threads per project, last 20 clean history messages, group prefix `Codex Lab - `, folder `codex-lab`, output `admin/bootstrap-plan.rehearsal.json`.
Use it before deleting or rebuilding the real `codex` surface.

## Step 3: Create Telegram Surface

```bash
admin/.venv/bin/python admin/telegram_user_admin.py bootstrap \
  --plan admin/bootstrap-plan.json
```

This creates or reuses groups/topics from the plan and writes bridge bindings.
By default it also creates or updates the Telegram folder from the plan, usually `codex`, and puts the project groups there.
Forum topics are forced to display as `Tabs` by default because that maps better to Codex's project/thread column.
Use `--topic-display list` only when you explicitly want Telegram's list-style topic view.
Bootstrap merges groups into `state/bootstrap-result.json` instead of replacing unrelated groups, so rehearsal does not wipe the real project index.
Use `--replace-result` only for an intentional clean rebuild.
Use `--skip-folder` only when debugging Telegram folder behavior.
Bot username is read from `config.local.json -> botUsername`, `CODEX_TELEGRAM_BOT_USERNAME`, or `--bot-username`.

For rehearsal apply, use the rehearsal plan explicitly:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py bootstrap \
  --plan admin/bootstrap-plan.rehearsal.json
```

## Step 4: Clean History Backfill

Run dry-run first:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py backfill-thread \
  --thread-id <thread-id> \
  --chat-id <telegram-chat-id> \
  --topic-id <topic-id> \
  --max-history-messages 40 \
  --assistant-phase final_answer \
  --sender-mode labeled-bot \
  --dry-run
```

Then run without `--dry-run`.

Defaults intentionally skip commentary, heartbeat/system-like entries and smoke noise. If a future user wants more, make it configurable, not default.
Backfill renders through the same Telegram HTML renderer as the live bridge by default (`--render-mode html`), so imported history should not show raw `**bold**`/markdown syntax.
Use `--render-mode plain` only for debugging parser issues.

If a freshly reserved status bar exists but Telegram Desktop does not show the pinned banner, re-pin it through the user-side helper:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py pin-message \
  --chat-id <telegram-chat-id> \
  --message-id <status-bar-message-id> \
  --silent
```

## Step 5: Verify

```bash
npm run self-check
```

Expected UX:

- active topics have a pinned compact status bar
- user prompts from Codex Desktop appear as bot-side surrogate messages
- assistant replies attach to the surrogate user message
- Telegram-originated prompts get a progress bubble and final reply
- `/project-status` and `/sync-project dry-run` do not flood working topics with ops walls

## Recommended Defaults

- `threads-per-project`: 3
- `history-max-messages`: 40
- `assistant-phase`: `final_answer`
- `sender-mode`: `labeled-bot`
- auto-create new topics: off by default until rules are explicit

This keeps Telegram feeling like a credible remote Codex surface, not a database dump wearing a chat costume.
