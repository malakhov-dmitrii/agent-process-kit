# Agent Process Kit

[![CI](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml)
[Русский](README.ru.md) · [How it works](docs/how-it-works.md) · [Choose skills](docs/choosing-skills.md)

A copyable working agreement for coding agents: inspect the real project, agree on scope, test behavior, verify the user flow, and report the delivery stage honestly.

The default kit has no installer, package, daemon, hook, or model dependency.

## Start in two minutes

1. Copy [starter/AGENTS.md](starter/AGENTS.md) into a project with no agent instructions. If the project already has `AGENTS.md` or `CLAUDE.md`, merge the relevant rules instead of replacing it.
2. Copy [starter/task-journal.md](starter/task-journal.md) to your project's task-documentation folder when a task needs a durable scope and progress record.
3. Add only the [skills](docs/choosing-skills.md) that fit your work. You can copy a skill folder into your agent's skill directory or point the agent at its `SKILL.md` explicitly.
4. Give the agent the task.

Example prompt:

> Read AGENTS.md and the local instructions for the code you will touch. For this task, first inspect the implementation and propose observable acceptance criteria. Discuss product or architecture choices with me. After we agree, implement the full scope, verify the real user path, update affected docs, and report the exact delivery stage.

That is the complete default setup.

## What's included

```text
starter/
  AGENTS.md
  task-journal.md
skills/
  capability-contract/
  capability-core-adapters/
  codebase-design/
  depth-lock/
  writing-for-agents/
docs/
  how-it-works.md
  choosing-skills.md
optional-automation/
  README.md
```

The five skill folders are real, independently usable instruction sources. They are licensed and attributed in [THIRD_PARTY.md](THIRD_PARTY.md). Broader workflow libraries such as [Superpowers](https://github.com/obra/superpowers) stay upstream instead of being copied into this repository.

## What the contract changes

- Bugs begin with a reproduction that fails for the actual defect.
- Features begin with observable user acceptance.
- Significant product, architecture, data, permission, and external-action choices remain human decisions.
- Routine reversible work inside the agreed scope stays autonomous.
- Reviews have a cap. Blockers stay in the task; adjacent polish becomes a follow-up.
- Local checks, commits, pushes, deployments, and production proof are separate claims.
- Module knowledge stays near the module. Temporary execution state stays in the task journal.

Read [how it works](docs/how-it-works.md) for the full sequence.

## Optional automation

If you run several agents across long sessions and need explicit session binding, recoverable handoffs, checkpoints, or completion hooks, see [optional-automation](optional-automation/README.md).

It is an advanced, separate Node.js package. The playbook and skills do not need it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [provenance](docs/provenance.md). The root project is MIT licensed; included third-party skills keep their upstream notices.
