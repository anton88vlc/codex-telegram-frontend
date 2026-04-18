# Codex App Telegram Frontend

Telegram как быстрый remote frontend для локального `Codex Desktop` на Mac.

Не “ещё один бот”, а аккуратный мост:

- `Telegram group = Codex project`
- `Telegram topic = Codex thread`
- `Codex Desktop` остаётся backend и source of truth
- мост живёт отдельно от `~/.codex`, как нормальный проект

## Что уже работает

- long polling через Telegram Bot API
- direct chat и forum topics
- `/attach`, `/attach-latest`, `/detach`, `/status`, `/sync-project`, `/mode native`
- native send через renderer-aware `app-control -> threads.send_message`, с fallback на local `app-server`, если Codex запущен без debug-port
- immediate receipt в Telegram
- reply-style ответы на входящее сообщение
- retry на временных Telegram fetch errors
- checkpoint на inbound updates, чтобы после рестарта не дублировать один и тот же turn
- user-side Telegram admin helper на Telethon для bootstrap групп, topics и bot-admin прав

## Чего пока нет

- streaming / commentary updates как в Codex UI
- markdown-rich rendering layer для Telegram
- вложения, картинки, voice
- auto-create topics по watcher-правилам
- heartbeat transport как отдельный режим

## Структура

- [bridge.mjs](/Users/antonnaumov/code/codex-telegram-frontend/bridge.mjs) — основной polling bridge
- [lib/telegram.mjs](/Users/antonnaumov/code/codex-telegram-frontend/lib/telegram.mjs) — Telegram transport
- [lib/codex-native.mjs](/Users/antonnaumov/code/codex-telegram-frontend/lib/codex-native.mjs) — запуск native helper
- [scripts/send_via_app_control.js](/Users/antonnaumov/code/codex-telegram-frontend/scripts/send_via_app_control.js) — renderer-aware send через Codex app-control
- [scripts/send_via_app_server.js](/Users/antonnaumov/code/codex-telegram-frontend/scripts/send_via_app_server.js) — fallback transport через local Codex app-server
- [admin/telegram_user_admin.py](/Users/antonnaumov/code/codex-telegram-frontend/admin/telegram_user_admin.py) — user-side bootstrap для Telegram groups/topics
- [docs/RUNBOOK.md](/Users/antonnaumov/code/codex-telegram-frontend/docs/RUNBOOK.md) — ops/runbook
- [BACKLOG.md](/Users/antonnaumov/code/codex-telegram-frontend/BACKLOG.md) — ближайшие продуктовые и UX долги

## Локальные runtime-файлы

Они живут в repo-local runtime, но в git не идут:

- `config.local.json`
- `state/state.json`
- `state/bootstrap-result.json`
- `state/anton_user.session`
- `logs/*`
- `admin/.env`

## Запуск

Сначала `Codex.app` в debug-режиме:

```bash
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222
```

Потом bridge:

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/bridge.mjs \
  --config /Users/antonnaumov/code/codex-telegram-frontend/config.local.json
```

## launchd

Установка/обновление launchd:

```bash
/Users/antonnaumov/code/codex-telegram-frontend/ops/install-launchd.sh
```

## Telegram модель

- папка `codex` — руками
- одна group на проект — руками или через admin helper
- внутри groups включены topics
- один topic = один активный thread
- direct chat с ботом = projectless / ops

Это и есть правильный v1. Не надо зеркалить весь sidebar подряд, иначе всё быстро превращается в мусорку.
