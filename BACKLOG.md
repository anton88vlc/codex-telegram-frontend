# Backlog

## Product guardrail

1. Визуальная цель не в pixel-clone, а в credible remote Codex surface на телефоне: папка `codex` в Telegram = внешний контейнер, одна group = один Codex project, список topics внутри group = мобильный аналог колонки thread-ов проекта в Codex, один topic = один Codex thread, несколько direct chats = projectless/global chats.
2. Любое UX-решение проверять вопросом: это ощущается ближе к структуре Codex Desktop, где быстро сканируется проект, список thread-ов и рабочий контекст, или мы снова скатились в случайный bot chat.
3. Не зеркалить каждый возможный thread и не превращать Telegram в мусорку; держать clean working set, где topics отражают текущий рабочий набор thread-ов проекта, а не весь бесконечный хвост истории.
4. Не превращать рабочую поверхность в админку: ops/admin служебщина должна быть подчинена рабочему chat-like опыту, а не доминировать над ним.

## P1 — Telegram UX приблизить к Codex

1. Настоящий streaming/commentary transport вместо таймерного progress bubble.
2. Чище развести ops/admin quiet path и рабочие ответы, возможно с отдельным ops topic или configurable routing.
3. Богаче rendering: blockquotes, tables, более аккуратные локальные file links.

## P2 — Transport и наблюдаемость

1. Отдельный streaming mode поверх app-control, если получится забирать промежуточные события.
2. Нормальный event/audit log вместо ручного tail `bridge.stderr.log`.
3. Более жирный `/health`: delivery clues, fallback counters и recent failures.
4. Вынести defaults для clean history import в config: сколько последних сообщений/turns грузить, какие assistant phases импортировать, включать ли heartbeat/system-like user entries.

## P3 — Product surface

1. Вложения и картинки.
2. Voice / audio ingress.
3. Auto-create topic rules для свежих thread без превращения Telegram в свалку.
4. Heartbeat transport как альтернативный режим для UI-visible jobs.

## P4 — UX modes

1. Разделить Telegram UX на два режима: `chat-like` для обычной работы и `ops-like` для служебных команд, чтобы после P1 система не выглядела как админка.
