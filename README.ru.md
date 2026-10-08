# Agent Process Kit

## Дайте кодинг-агенту финишную черту.

[![CI](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml)
[English](README.md) · [Как это работает](docs/how-it-works.md) · [Совместимость](docs/compatibility.md)

`finish-task` проводит одно конкретное изменение в репозитории от первого чтения к проверяемому результату. Скилл фиксирует, что значит «готово», удерживает scope, сначала делает баг или acceptance красным, проверяет реальный пользовательский путь и отдельно называет локальную проверку, commit, push, deploy и production proof.

После установки это одна обычная папка с `SKILL.md`. Нет демона, хуков, аккаунта, фонового процесса, телеметрии и runtime-зависимости.

## Попробуйте на реальной задаче

Установите скилл в проект:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill finish-task
```

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

## Установка, обновление, удаление

Основная команда использует открытый установщик [`skills`](https://github.com/vercel-labs/skills) и предлагает выбрать найденного агента. Явная установка для Codex и Claude Code:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill finish-task -a codex -a claude-code
```

Флаг `-g` ставит скилл на уровне пользователя. Без `-g` он остаётся в проекте, где команда может видеть и версионировать его.

```sh
npx skills update finish-task
npx skills remove finish-task -a codex -a claude-code -y
```

В ограниченной или offline-среде можно напрямую скопировать [`skills/finish-task`](skills/finish-task) в каталог скиллов хоста.

## Что изменилось после v0.2

В версии 0.2 были starter contract, journal template, пять абстрактных skills и optional lifecycle runtime. Части были аккуратными, но продукт не имел убедительного входа. В версии 0.3 интерфейсом стала частая задача: закончить одно реальное изменение с доказательствами.

Старый runtime и отдельные skills сохранены в неизменяемом [релизе v0.2.0](https://github.com/malakhov-dmitrii/agent-process-kit/releases/tag/v0.2.0). Детали: [переход с v0.2](docs/migration-v0.2.md).

## Ограничения

Instruction skill не выдаёт разрешения, не делает модель надёжной сам по себе и не доказывает правдивость текста в Evidence. Доступ и безопасность остаются у project rules и host controls. `finish-task` делает видимыми работу и недостающий proof; доказательства дают реальные тесты, runtime, browser и release system проекта.

Исследование для редизайна: [competitive skill systems](docs/research/competitive-skill-systems-2026-10-08.md). Лицензии и происхождение: [THIRD_PARTY.md](THIRD_PARTY.md) и [docs/provenance.md](docs/provenance.md).
