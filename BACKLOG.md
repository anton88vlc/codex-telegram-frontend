# Backlog

## P1 — Telegram UX приблизить к Codex

1. In-place progress updates вместо немой паузы и одного финального пузыря.
2. Markdown/rendering layer: bold, code, lists, links без сырого текстового месива.
3. Человеческий error UX: коротко в чат, техподробности только в лог.
4. Развести рабочие ответы и служебные ops-команды, чтобы `/sync-project` не пачкал активные topics.

## P2 — Transport и наблюдаемость

1. Отдельный streaming mode поверх app-control, если получится забирать промежуточные события.
2. Better health endpoint / self-check для bridge.
3. Событийный audit log без ручного tail `bridge.stderr.log`.

## P3 — Product surface

1. Вложения и картинки.
2. Voice / audio ingress.
3. Auto-create topic rules для свежих thread без превращения Telegram в свалку.
4. Heartbeat transport как альтернативный режим для UI-visible jobs.
