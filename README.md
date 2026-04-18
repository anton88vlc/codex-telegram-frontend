# Codex App Telegram Frontend

Telegram как быстрый remote frontend для локального `Codex Desktop` на Mac.

Не “ещё один бот”, а аккуратный мост:

- `Telegram folder codex = внешний контейнер / shell`
- `Telegram group = Codex project`
- `Telegram topic list inside group = мобильный аналог project thread column`
- `Telegram topic = Codex thread`
- несколько direct chats = projectless / global chats
- `Codex Desktop` остаётся backend и source of truth
- мост живёт отдельно от `~/.codex`, как нормальный проект

## Что уже работает

- long polling через Telegram Bot API
- direct chat и forum topics
- `/attach`, `/attach-latest`, `/detach`, `/status`, `/health`, `/project-status`, `/sync-project`, `/mode native`
- native send через renderer-aware `app-control -> threads.send_message`, с fallback на local `app-server`, если Codex запущен без debug-port
- in-place progress bubble в Telegram: receipt живёт в одном сообщении и обновляется, пока Codex думает
- reply-style ответы на входящее сообщение
- HTML rendering layer для `**bold**`, `_italic_` / `*italic*`, quotes, lists, code, spoilers и links с fallback в plain text, если Telegram parse_mode закапризничал
- короткий human error UX в чат, техподробности в лог
- шумные ops-команды можно уводить в direct chat с ботом, чтобы не пачкать рабочие topics
- mention-aware ingress (`@bot текст`) как fallback, если group privacy мешает plain text
- `sync-project dry-run` и CLI `--self-check` для ops
- npm scripts для запуска, self-check, tests и onboarding preview
- `/project-status` показывает желаемую thread column, active topics, parked sync topics и preview sync-плана
- `/sync-project` больше не просто плодит темы: он rename/reopen/create/park для sync-managed topics под текущий working set
- user-side history backfill из `rollout_path` в Telegram topic через `admin/telegram_user_admin.py backfill-thread`: по умолчанию только user prompts + `final_answer`, без commentary, ограниченный хвост истории
- backfill использует тот же Markdown→Telegram HTML renderer, что и live bridge, чтобы импорт не выглядел как сырой `**markdown**`
- safe cleanup для topic-мусора через `admin/telegram_user_admin.py cleanup-topic`: сначала dry-run, удаление только с `--delete`
- bootstrap умеет создавать/обновлять Telegram folder `codex` и складывать туда проектные группы
- retry на временных Telegram fetch errors
- checkpoint на inbound updates, чтобы после рестарта не дублировать один и тот же turn
- live outbound mirror: user-turn surrogate, commentary updates и final answers из Codex Desktop долетают обратно в привязанный Telegram topic/chat
- для Codex-originated turn bridge сначала зеркалит безопасный user-turn surrogate (`User via Codex Desktop`, имя задаётся в config), а уже assistant messages приходят reply на него
- pinned compact status bar в active topics: bridge резервирует сообщение, пинит его и редактирует при изменении model/reasoning/context/rate-limit/activity данных
- persisted outbound checkpoint и suppression-слой, чтобы live mirror не дублировал ответы, которые bridge уже сам отдал в Telegram
- user-side Telegram admin helper на Telethon для bootstrap групп, topics и bot-admin прав

## Чего пока нет

- настоящий token streaming из Codex UI; сейчас live mirror шлёт human-visible chat messages, включая commentary и final answers
- вложения, картинки, voice
- auto-create topics по watcher-правилам
- heartbeat transport как отдельный режим

## Структура

- [bridge.mjs](bridge.mjs) — основной polling bridge
- [lib/telegram.mjs](lib/telegram.mjs) — Telegram transport
- [lib/codex-native.mjs](lib/codex-native.mjs) — запуск native helper
- [scripts/send_via_app_control.js](scripts/send_via_app_control.js) — renderer-aware send через Codex app-control
- [scripts/send_via_app_server.js](scripts/send_via_app_server.js) — fallback transport через local Codex app-server
- [scripts/onboard.mjs](scripts/onboard.mjs) — onboarding scan/plan generator из локальной Codex DB
- [admin/telegram_user_admin.py](admin/telegram_user_admin.py) — user-side bootstrap для Telegram groups/topics
- [docs/ONBOARDING.md](docs/ONBOARDING.md) — recommended setup flow для нового пользователя
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — ops/runbook
- [BACKLOG.md](BACKLOG.md) — ближайшие продуктовые и UX долги

## Локальные runtime-файлы

Они живут в repo-local runtime, но в git не идут:

- `config.local.json`
- `state/state.json`
- `state/bootstrap-result.json`
- `state/anton_user.session`
- `logs/*`
- `admin/.env`
- `admin/bootstrap-plan.json`

## Запуск

Подготовка локальных конфигов:

```bash
cp config.example.json config.local.json
cp admin/.env.example admin/.env
python3 -m venv admin/.venv
admin/.venv/bin/pip install -r admin/requirements.txt
```

Сначала `Codex.app` в debug-режиме:

```bash
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222
```

Потом bridge:

```bash
npm start
```

One-shot self-check:

```bash
npm run self-check
```

Локальные проверки перед коммитом:

```bash
npm run check
```

## launchd

Установка/обновление launchd:

```bash
./ops/install-launchd.sh
```

## Telegram модель

- папка `codex` в Telegram — внешний контейнер всего remote frontend
- одна Telegram group = один Codex project
- внутри group включены topics, и их список должен ощущаться как колонка thread-ов этого проекта в Codex
- один topic = один Codex thread
- в идеале topics копируют рабочий set thread-ов проекта, а не случайный шум и не весь исторический мусор подряд
- direct chat с ботом — projectless / global / ops surface, но таких чатов должно быть немного

Это и есть правильный v1. Не надо зеркалить весь sidebar подряд, иначе всё быстро превращается в мусорку.

## Onboarding preview

Посмотреть проекты и свежие threads из локального Codex DB:

```bash
npm run onboard:scan -- \
  --project-limit 12 \
  --threads-per-project 5
```

Собрать preview bootstrap-plan по выбранным проектам:

```bash
npm run onboard:plan -- \
  --project /path/to/codex-project \
  --threads-per-project 3
```

Песочница без сноса текущего Telegram:

```bash
npm run onboard:rehearsal -- \
  --project /path/to/codex-project
```

Запись в ignored runtime plan `admin/bootstrap-plan.json` только с `--write`.
Для rehearsal запись идёт в ignored `admin/bootstrap-plan.rehearsal.json`.
Новые и переиспользованные forum groups по дефолту переводятся в topic display `Tabs`.
`bootstrap` merge-ит группы в `state/bootstrap-result.json`, чтобы rehearsal не затирал обычную `codex` поверхность.
Структурный пример: [admin/bootstrap-plan.example.json](admin/bootstrap-plan.example.json).
Полный flow: [docs/ONBOARDING.md](docs/ONBOARDING.md).

## Ops notes

- token можно брать не только из env, но и из macOS Keychain service `codex-telegram-bridge-bot-token`
- если `app-control` недоступен, bridge всё равно живёт через fallback `app-server`
- outbound mirror читает `rollout_path` bound thread-а и по умолчанию опрашивает его часто, поэтому user/commentary/final messages из Codex Desktop появляются в Telegram без ручного backfill
- clean history import не должен заливать весь бесконечный thread: `backfill-thread` по умолчанию берёт последние 40 clean messages и умеет `--max-history-messages`, `--max-user-prompts`, `--assistant-phase final_answer`
- если в group topic обычный текст не долетает до бота, quickest fallback это `@your_bot_username текст`; правильный фикс всё равно в privacy mode у бота
- длинные ops-ответы вроде `/project-status` и `/sync-project` bridge по возможности скидывает в direct chat с ботом, оставляя в topic только короткий след
- parked sync topics остаются отдельным классом: они не считаются активным working set и не мешают `/attach-latest` или следующему sync preview
