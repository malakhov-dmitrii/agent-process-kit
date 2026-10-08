# Agent Process Kit

## Дайте кодинг-агенту финишную черту.

[![CI](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml)
[English](README.md) · [Как это работает](docs/how-it-works.md) · [Совместимость](docs/compatibility.md)

Agent Process Kit - это pack из семи обычных `SKILL.md`. Начинать проще всего с `finish-task`: он проводит одно изменение от scope к proof и подключает правила пака про границы, архитектуру, agent docs и доставку только когда они нужны.

Каждый skill можно использовать отдельно. У пака нет демона, хуков, аккаунта, фонового процесса, телеметрии и runtime-зависимости.

## Установите pack

Все семь skills для Codex и Claude Code:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code
```

Если нужен только end-to-end вход:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill finish-task
```

## Попробуйте на реальной задаче

Дайте агенту настоящую задачу:

> Use `finish-task` on this: исправь дубли строк в CSV export. Не выходи за export path, сначала докажи баг, затем пройди реальный export flow и остановись на локальной проверке.

Первый полезный результат — **Finish Card**:

```text
FINISH CARD

Цель              В CSV export каждая логическая строка встречается один раз.
Scope             Только pagination и deduplication экспорта.
Acceptance        Красная репродукция, regression, реальный export, gates проекта.
Граница доставки  Локальная проверка. Без заявлений про push или deploy.
```

В конце агент закрывает ту же карточку свежими доказательствами и одним честным receipt:

```text
LOCAL-ONLY: Дубли в экспорте исправлены.

Проверено: failing reproduction, regression, затронутые checks, реальный export flow.
Не заявлено: commit, push, deploy, production behavior.
```

Это и есть продукт. Перед полезной работой не нужно настраивать отдельный framework.

## Как это работает

```text
запрос
  → Finish Card
  → failing reproduction или наблюдаемый acceptance
  → полное изменение в согласованном scope
  → review diff против карточки и project rules
  → gates проекта + реальный пользовательский путь
  → evidence receipt на разрешённой границе доставки
```

- **Баг:** reproduce → причина → failing regression → fix → повтор реального пути.
- **Фича:** наблюдаемый acceptance → scope → implementation → acceptance и project gates.
- **Архитектура:** ownership, authority, lifecycle и module seams до широких правок.
- **Доставка:** local, commit, push, deploy и production verification остаются разными фактами.

Для длинной задачи скилл сохраняет Finish Card в принятом проектом месте или `.agent/tasks/<slug>.md`. Одношаговая правка может оставить карточку в чате.

Точная последовательность: [workflow и evidence model](docs/how-it-works.md).

## Что входит в pack

| Слой | Skill | Задача |
|---|---|---|
| Начать здесь | [`finish-task`](skills/finish-task/SKILL.md) | Провести одно изменение от scope к proof |
| Guardrail | [`depth-lock`](skills/depth-lock/SKILL.md) | Зафиксировать scope, review rounds и checkpoints |
| Guardrail | [`verify-delivery`](skills/verify-delivery/SKILL.md) | Привязать done, push, deploy и production claims к свежему evidence |
| Архитектура | [`codebase-design`](skills/codebase-design/SKILL.md) | Проектировать deep modules, interfaces и seams |
| Архитектура | [`capability-core-adapters`](skills/capability-core-adapters/SKILL.md) | Держать product behavior за тонкими entrypoint adapters |
| Архитектура | [`capability-contract`](skills/capability-contract/SKILL.md) | Определить truth, authority, lifecycle, commands и degraded states |
| Meta | [`writing-for-agents`](skills/writing-for-agents/SKILL.md) | Писать skills и agent instructions, которые надёжно вызываются |

`finish-task` - запоминаемый путь через pack. Остальные шесть skills остаются самостоятельными: для узкой архитектурной или authoring-задачи весь train не нужен.

## Установка, обновление, удаление

Команды выше используют открытый установщик [`skills`](https://github.com/vercel-labs/skills). Без `-g` skills остаются в текущем проекте, где команда может видеть и версионировать их. Флаг `-g` ставит pack на уровне пользователя.

```sh
npx skills update
npx skills remove capability-contract capability-core-adapters codebase-design depth-lock finish-task verify-delivery writing-for-agents -a codex -a claude-code -y
```

Для одного skill замените список его именем. В ограниченной или offline-среде можно напрямую скопировать любую папку из [`skills/`](skills) в каталог skills нужного хоста.

## Что изменилось после v0.2

В версии 0.2 было пять самостоятельных skills, но не было убедительного входа. Версия 0.3.0 перегнула в другую сторону и оставила только `finish-task`. Текущий pack сохраняет сильный front door, возвращает отдельные craft skills и добавляет `verify-delivery` как самостоятельный proof guardrail.

Старый runtime и отдельные skills сохранены в неизменяемом [релизе v0.2.0](https://github.com/malakhov-dmitrii/agent-process-kit/releases/tag/v0.2.0). Детали: [переход с v0.2](docs/migration-v0.2.md).

## Ограничения

Instruction skill не выдаёт разрешения, не делает модель надёжной сам по себе и не доказывает правдивость текста в Evidence. Доступ и безопасность остаются у project rules и host controls. `finish-task` делает видимыми работу и недостающий proof; доказательства дают реальные тесты, runtime, browser и release system проекта.

Исследование для редизайна: [competitive skill systems](docs/research/competitive-skill-systems-2026-10-08.md). Лицензии и происхождение: [THIRD_PARTY.md](THIRD_PARTY.md) и [docs/provenance.md](docs/provenance.md).
