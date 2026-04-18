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

Сделать self-check без запуска polling loop:

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/bridge.mjs \
  --config /Users/antonnaumov/code/codex-telegram-frontend/config.local.json \
  --self-check
```

Перезапустить:

```bash
launchctl kickstart -k gui/$(id -u)/com.antonnaumov.codex.telegram-bridge
```

## Если что-то сломалось

1. Убедись, что `Codex.app` открыт и запущен с `--remote-debugging-port=9222`.
   Если нет, bridge всё равно попробует fallback через local app-server, просто UX будет беднее.
2. Проверь `launchctl print ...`.
3. Прогони `--self-check`, чтобы быстро увидеть bot auth, state, index, threads DB и transport paths.
4. Посмотри `logs/bridge.stderr.log`.
5. Посмотри, двигается ли `state/state.json -> lastUpdateId`.
6. Если bridge жив, но тупит, сделай `launchctl kickstart -k ...`.

Если `self-check` пишет `app-control: fetch failed`, но `app-server: reachable`, это не авария.
Просто bridge сейчас работает через fallback transport.

Если хочешь проверить именно UX-слой, а не только живость процесса:

1. Напиши в topic обычный текст и проверь, что сначала появляется один status bubble, а не тишина.
2. Убедись, что bubble редактируется на месте, если ответ идёт дольше пары секунд.
3. Для `/project-status` или `/sync-project dry-run` проверь, что topic получает короткий след, а детали уходят в direct chat с ботом.
4. Для `/sync-project` проверь, что stale sync-topics паркуются, а не продолжают висеть как будто они всё ещё часть рабочего набора.
5. Сделай любой короткий turn прямо из Codex Desktop в уже привязанном thread и проверь, что surrogate user message, commentary updates и финальный текст сами прилетают в связанный Telegram topic без ручного backfill.
6. Проверь, что в active topic есть pinned compact status message. Он должен показывать `model | reasoning`, context load, remaining rate limits with reset countdown и короткий status.

## Bootstrap / Telegram admin

- plan: `/Users/antonnaumov/code/codex-telegram-frontend/admin/bootstrap-plan.json`
- current bootstrap result: `/Users/antonnaumov/code/codex-telegram-frontend/state/bootstrap-result.json`
- user session: `/Users/antonnaumov/code/codex-telegram-frontend/state/anton_user.session`
- onboarding flow: `/Users/antonnaumov/code/codex-telegram-frontend/docs/ONBOARDING.md`

Generate plan preview from Codex DB:

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/scripts/onboard.mjs scan \
  --project-limit 12 \
  --threads-per-project 5
```

Write plan after selecting projects:

```bash
node /Users/antonnaumov/code/codex-telegram-frontend/scripts/onboard.mjs plan \
  --project /Users/antonnaumov/code/codex-telegram-frontend \
  --threads-per-project 3 \
  --history-max-messages 40 \
  --write
```

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

## Telegram ops команды

- `/health` — быстрый health текущего чата/topic: binding, project mapping, transport endpoints
- `/project-status [count]` — желаемая thread column, active topics, parked sync topics и sync preview
- `/sync-project [count] dry-run` — безопасный preview sync-managed topics перед rename/reopen/create/park

## History backfill

Для заливки clean history из текущего Codex thread в Telegram topic:

```bash
cd /Users/antonnaumov/code/codex-telegram-frontend
admin/.venv/bin/python admin/telegram_user_admin.py backfill-thread \
  --thread-id 019da196-14ae-78d0-a7b1-5b493dd26b4c \
  --chat-id -1003836615652 \
  --topic-id 3 \
  --max-history-messages 40 \
  --assistant-phase final_answer \
  --sender-mode labeled-bot
```

Notes:
- `labeled-bot` безопаснее live bridge: импорт идёт сообщениями `Anton:` / `Codex:` от бота и не зацикливается обратно в Codex thread.
- по умолчанию backfill берёт только clean tail: user prompts + assistant `final_answer`, без commentary/heartbeat шума и без полного бесконечного хвоста thread-а.
- перед реальной заливкой используй `--dry-run`; для более короткого контекста есть `--max-history-messages` и `--max-user-prompts`.
- backfill по умолчанию игнорирует live ids из `state/state.json` при resume/count: topic root, pinned status bar, последний mirrored user и последние outbound messages.
- команда пропускает уже залитые labeled messages по тексту, а не по тупому count: status bar, live mirror и cleanup gaps не сбивают импорт.
- отправка уважает Telegram `retry_after`, так что после partial 429 её можно просто запустить ещё раз.

## Topic cleanup

Безопасный preview мусора в topic:

```bash
cd /Users/antonnaumov/code/codex-telegram-frontend
admin/.venv/bin/python admin/telegram_user_admin.py cleanup-topic \
  --chat-id -1003836615652 \
  --topic-id 3 \
  --scan-limit 120
```

Удаление тех же кандидатов:

```bash
admin/.venv/bin/python admin/telegram_user_admin.py cleanup-topic \
  --chat-id -1003836615652 \
  --topic-id 3 \
  --scan-limit 120 \
  --delete
```

Notes:
- helper сам сохраняет базовые live ids из `state/state.json`: topic root и pinned status bar; дополнительные сообщения можно защитить через `--keep-message-id`.
- default cleanup ловит service-actions от pin/topic ops и явный ops-шум вроде `/health`, `/project-status`, `/sync-project`, `OUTBOUND_*`, `UX_*`, но рабочую историю не трогает.

## UX notes

- user-facing ответы рендерятся через Telegram HTML parse mode с fallback в plain text, если parse_mode ломается
- progress bubble нарочно честный: это не настоящий streaming из Codex, а аккуратный in-place status update, чтобы в Telegram не было немой паузы
- outbound mirror зеркалит human-visible `commentary` и `final_answer`; raw event stream и token streaming пока не льются в topic, чтобы не устроить ботоспам
- если turn пришёл из самого Codex Desktop, bridge сначала кладёт в topic bot-side surrogate user message (`User via Codex Desktop`, имя задаётся в config), а потом шлёт assistant replies именно на него, чтобы UX не лип к корню topic
- status bar живёт как отдельное pinned message в каждом active topic; bridge редактирует его only-on-change, а не спамит новый status на каждый poll
- transport/raw exceptions не вываливаются пользователю в чат целиком; детали ищи в `logs/bridge.stderr.log`
- parked sync topics считаются припаркованными слепками старого working set: они не участвуют в `attach-latest` и не должны восприниматься как активные рабочие thread-ы

Если privacy mode у бота мешает plain-text ingress в group topics, быстрый fallback:

```text
@cdxanton2026bot ваш текст
```
