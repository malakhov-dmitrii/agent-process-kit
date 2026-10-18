# Agent Process Kit

## Дайте кодинг-агенту проверяемую финишную черту.

[![CI](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml)
[English](README.md) · [Как это работает](docs/how-it-works.md) · [Совместимость](docs/compatibility.md)

Agent Process Kit — это dependency-free Node.js control plane и одиннадцать переносимых skills. `orchestrate-task` — входная точка: дайте агенту обычную задачу, а он сам выберет внутренние методы, сохранит состояние и покажет точную границу доказательств.

## Установка и настройка

Запустите стандартную настройку из корня проекта:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code && npx @malakhov-dmitrii/agent-process-kit setup --apply
```

Команда ставит одиннадцать skills в `.agents/skills/` и `.claude/skills/`, затем записывает hash-owned runtime adapter и receipt настройки в проект. Проверить или отменить настройку можно так:

```sh
npx @malakhov-dmitrii/agent-process-kit verify-setup
npx @malakhov-dmitrii/agent-process-kit rollback --apply
```

Для обновления project install используйте `skills update`. Runtime — это `bin/`, `runtime/` и `package.json`; отдельного daemon, аккаунта, telemetry service или фонового процесса нет.

## Попробуйте на реальной задаче

Дайте агенту обычный запрос. Называть skill не нужно:

> Исправь дубли строк в CSV export. Оставь scope в export path, сначала докажи баг, пройди реальный export flow и остановись на локальной проверке.

Для ясной механической задачи агент фиксирует mode и продолжает. Вопрос появляется только при материальном выборе по продукту, scope, архитектуре, данным, разрешениям или границе доставки. У каждой задачи есть durable record с целью, фазой, прогрессом, решениями, evidence, delivery state и следующим owner/action. Для большой задачи отдельно сохраняются immutable artifacts specification, plan, review и proof.

Последовательность выглядит так:

```text
обычный запрос
  → clarification только при материальной неоднозначности
  → reviewed specification и executable plan
  → ATDD red proof и TDD implementation
  → bounded code review
  → реальный local UAT
  → разрешённый release
  → production UAT и observation
```

Границы proof разделены: локальные checks и UAT, commit, push, deploy, authenticated production behavior. Commit не доказывает push, push не доказывает deploy, deploy не доказывает поведение production.

Для связанной задачи используйте обычные команды:

```text
дай статус   # durable status projection
продолжай    # следующая разрешённая фаза
кати         # зафиксированная граница release
pause        # пауза и отзыв активных grants
stop         # отмена после containment
```

Status показывает task, goal, phase, completed/total lanes, current/stale/missing evidence, delivery state, pending decisions, last trace и next action. Он не восстанавливает состояние из истории чата.

## Что входит в pack

| Слой | Skill | Задача |
|---|---|---|
| Начать здесь | [`orchestrate-task`](skills/orchestrate-task/SKILL.md) | Провести обычную задачу через durable control plane |
| Guardrail | [`depth-lock`](skills/depth-lock/SKILL.md) | Зафиксировать scope, review rounds и checkpoints |
| Guardrail | [`verify-delivery`](skills/verify-delivery/SKILL.md) | Привязать delivery claims к свежему evidence и receipts на точное дерево |
| Архитектура | [`codebase-design`](skills/codebase-design/SKILL.md) | Проектировать deep modules, interfaces и seams |
| Архитектура | [`capability-core-adapters`](skills/capability-core-adapters/SKILL.md) | Держать product behavior за тонкими adapters |
| Архитектура | [`capability-contract`](skills/capability-contract/SKILL.md) | Определить truth, authority, lifecycle и degraded states |
| Meta | [`writing-for-agents`](skills/writing-for-agents/SKILL.md) | Писать надёжные skills и agent instructions |
| Много агентов | [`run-agent-trains`](skills/run-agent-trains/SKILL.md) | Выпускать работу параллельных агентов через trains, одного release captain и heavy-job slots |
| Много агентов | [`brief-agents`](skills/brief-agents/SKILL.md) | Ставить builders задачи с копированными правилами, coverage inventory и decision log |
| Много агентов | [`design-gates`](skills/design-gates/SKILL.md) | Держать design rules ratchet-ами и visual gates, сначала показанными красными |
| Много агентов | [`audit-agent-program`](skills/audit-agent-program/SKILL.md) | Разобрать завершённую программу через линзы throughput, quality и parallelism |

Front door выбирает внутренние методы, когда нужен соответствующий branch. Для узкой задачи любой skill можно установить отдельно.

## Много агентов

Четыре skills «Много агентов» вышли из 114-часовой программы: около 60 builders за три часа собрали 58 задач, а медианная задача дошла до прода за сутки. В [разборе](docs/multi-agent-program.md) (на английском) есть цифры, что сработало и что нет.

## Обновление и удаление

```sh
npx skills update --project -y
npx skills update orchestrate-task --project -y
npx skills remove audit-agent-program brief-agents capability-contract capability-core-adapters codebase-design depth-lock design-gates orchestrate-task run-agent-trains verify-delivery writing-for-agents -a codex -a claude-code -y
```

В offline-среде можно скопировать каталог skill из [`skills/`](skills) вместе со всеми supporting files. В каждом skill есть собственные `LICENSE` и `NOTICE.md`.

## Ограничения и история

Instruction skills не выдают permissions, не делают модель надёжной сами по себе и не доказывают правдивость evidence. Источниками истины остаются project rules, host controls и реальные test, browser, provider и production systems.

В релизе v0.3.1 входной точкой был `finish-task`. В v0.4 этот публичный вход заменён на `orchestrate-task`, а в пакет добавлены runtime и setup. Неизменяемый [релиз v0.2.0](https://github.com/malakhov-dmitrii/agent-process-kit/releases/tag/v0.2.0) остаётся источником для migration. См. [совместимость](docs/compatibility.md), [security](SECURITY.md), [third-party notices](THIRD_PARTY.md) и [provenance](docs/provenance.md).
