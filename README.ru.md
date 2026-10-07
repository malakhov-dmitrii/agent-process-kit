# Agent Process Kit

[English](README.md) · [Команды](docs/cli.md) · [Установка](docs/setup.md)

Локальные инструменты для явной привязки задач, восстанавливаемой передачи между сессиями и проверки записанных критериев приёмки.

Нужны Node.js 22+, Git и Bash. CI проверяет Linux и macOS с Node 22 и 24. Поддержка Windows не заявлена.

```sh
git clone https://github.com/malakhov-dmitrii/agent-process-kit.git
cd agent-process-kit
npm ci --ignore-scripts
npm run verify
node bin/agent-process-kit.mjs init --task demo --goal "Проверить пользовательский сценарий"
node bin/agent-process-kit.mjs check --task demo --journal .agent/tasks/demo.md
```

Пока критерии открыты, `check` возвращает exit code 2. Замените шаблонные критерии реальной договорённостью.

- `bind` связывает текущую сессию с конкретным журналом.
- `status` показывает выбранную задачу или кандидата.
- `handoff` готовит передачу, которую получатель принимает отдельно.
- `setup` показывает план интеграции; применение требует `--apply`.
- `rollback` удаляет только неизменённые файлы, принадлежащие setup.
- `review` отдельно вызывает ограниченное Codex-ревью с явно выбранной моделью.

`ready` означает заполненный чеклист. Поле `evidenceVerified: false` указывает, что достоверность доказательств скрипт не проверяет. Агент обязан запустить проверки и прочитать результат. Push и работающий production подтверждаются отдельно.

Setup не меняет глобальные настройки, не включает хуки и не выдаёт права. Состояние хранится в `~/.agent-process-kit`; для изоляции есть `--state-dir`.

Включены реальные механизмы процесса, архитектурные скиллы и optional snapshot Superpowers 6.4.1 с лицензией. Весь набор не активируется автоматически. Личные сессии, конфиги и production-адреса автора не публикуются.

Подробности: [workflow](docs/workflow.md), [архитектура](docs/architecture.md), [безопасность](SECURITY.md), [происхождение](docs/provenance.md).
