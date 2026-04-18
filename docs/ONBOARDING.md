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
3. Один раз авторизовать user session:

```bash
cd /Users/antonnaumov/code/codex-telegram-frontend
admin/.venv/bin/python admin/telegram_user_admin.py login-qr
```

BotFather не даёт нормальный публичный API для полностью автоматического создания бота, поэтому этот шаг не надо притворяться автоматизируемым. Всё остальное должно быть максимально scripted.

## Step 1: Scan Codex Projects

Read-only preview из локальной Codex DB:

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/scripts/onboard.mjs scan \
  --project-limit 12 \
  --threads-per-project 5
```

JSON mode для будущего UI/wizard:

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/scripts/onboard.mjs scan \
  --project-limit 12 \
  --threads-per-project 5 \
  --json
```

Пользователь выбирает не всё подряд, а нужные project roots.

## Step 2: Generate Bootstrap Plan

Preview:

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/scripts/onboard.mjs plan \
  --project /Users/antonnaumov/code/codex-telegram-frontend \
  --project /Users/antonnaumov/code/livekit-via-estilo \
  --threads-per-project 3 \
  --history-max-messages 40
```

Write `admin/bootstrap-plan.json`:

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/scripts/onboard.mjs plan \
  --project /Users/antonnaumov/code/codex-telegram-frontend \
  --project /Users/antonnaumov/code/livekit-via-estilo \
  --threads-per-project 3 \
  --history-max-messages 40 \
  --write
```

## Step 3: Create Telegram Surface

```bash
admin/.venv/bin/python admin/telegram_user_admin.py bootstrap \
  --plan /Users/antonnaumov/code/codex-telegram-frontend/admin/bootstrap-plan.json
```

This creates or reuses groups/topics from the plan and writes bridge bindings.
By default it also creates or updates the Telegram folder `codex` and puts the project groups there.
Use `--skip-folder` only when debugging Telegram folder behavior.

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

## Step 5: Verify

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/bridge.mjs \
  --config /Users/antonnaumov/code/codex-telegram-frontend/config.local.json \
  --self-check
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
