# Runbook

## Текущее состояние

- launchd label: `com.antonnaumov.codex.telegram-bridge`
- repo root: `/Users/antonnaumov/code/codex-telegram-frontend`
- config: `/Users/antonnaumov/code/codex-telegram-frontend/config.local.json`
- state: `/Users/antonnaumov/code/codex-telegram-frontend/state/state.json`
- logs:
  - `/Users/antonnaumov/code/codex-telegram-frontend/logs/bridge.stdout.log`
  - `/Users/antonnaumov/code/codex-telegram-frontend/logs/bridge.stderr.log`

## Bot

- username: `@cdxanton2026bot`
- token service in macOS Keychain: `codex-telegram-bridge-bot-token`

## Статус / рестарт

Проверить:

```bash
launchctl print gui/$(id -u)/com.antonnaumov.codex.telegram-bridge | rg 'state =|pid =|last exit code'
```

Перезапустить:

```bash
launchctl kickstart -k gui/$(id -u)/com.antonnaumov.codex.telegram-bridge
```

## Если что-то сломалось

1. Убедись, что `Codex.app` открыт и запущен с `--remote-debugging-port=9222`.
   Если нет, bridge всё равно попробует fallback через local app-server, просто UX будет беднее.
2. Проверь `launchctl print ...`.
3. Посмотри `logs/bridge.stderr.log`.
4. Посмотри, двигается ли `state/state.json -> lastUpdateId`.
5. Если bridge жив, но тупит, сделай `launchctl kickstart -k ...`.

## Bootstrap / Telegram admin

- plan: `/Users/antonnaumov/code/codex-telegram-frontend/admin/bootstrap-plan.json`
- current bootstrap result: `/Users/antonnaumov/code/codex-telegram-frontend/state/bootstrap-result.json`
- user session: `/Users/antonnaumov/code/codex-telegram-frontend/state/anton_user.session`

## Полезные команды

Авторизация user-side Telegram helper:

```bash
cd /Users/antonnaumov/code/codex-telegram-frontend/admin
source .venv/bin/activate
python telegram_user_admin.py whoami
```

One-shot bridge poll:

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/bridge.mjs \
  --config /Users/antonnaumov/code/codex-telegram-frontend/config.local.json \
  --once
```
