# Agent Process Kit

## Give your coding agent a durable finish line.

[![CI](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml)
[Русский](README.ru.md) · [How it works](docs/how-it-works.md) · [Compatibility](docs/compatibility.md)

Agent Process Kit is a dependency-free Node.js control plane with seven portable skills. `orchestrate-task` is the front door: give the agent an ordinary coding request and it selects the internal methods, records durable task state and reports the exact proof boundary.

## Install and set up

Run the standard project setup from the repository root:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code && npx @malakhov-dmitrii/agent-process-kit setup --apply
```

This installs the seven skills into both `.agents/skills/` and `.claude/skills/`, then writes the hash-owned runtime adapter and setup receipt into the project. Check or undo the setup with:

```sh
npx @malakhov-dmitrii/agent-process-kit verify-setup
npx @malakhov-dmitrii/agent-process-kit rollback --apply
```

Use the same `skills` command with `update` to refresh a project install. The runtime is the package's `bin/`, `runtime/` and `package.json`; it has no daemon, account, telemetry service or background process.

## Try it on real work

Give your agent a normal request. You do not need to name a skill:

> Fix duplicate rows in CSV export. Keep the scope to the export path, prove the bug before changing code, run the real export flow, and stop at local verification.

For a clear mechanical request, the agent records the mode and proceeds. It asks a question only when a product, scope, architecture, data, permission or delivery choice is material. Every task leaves a durable record with its goal, phase, progress, pending decisions, evidence, delivery state and next owner/action. Large work also stores immutable specification, plan, review and proof artifacts.

The lifecycle is:

```text
natural request
  → conditional clarification
  → reviewed specification and executable plan
  → ATDD red proof and TDD implementation
  → bounded code review
  → real local UAT
  → authorized release
  → production UAT and observation
```

The proof contours stay separate: local checks and UAT, commit, push, deploy, authenticated production behavior. A commit does not prove a push; a push does not prove deployment; a deploy does not prove production behavior.

Use ordinary control words when the task is bound:

```text
дай статус   # durable status projection
продолжай    # continue the next authorized phase
кати         # continue to the locked release boundary
pause        # pause and revoke active grants
stop         # cancel after containment
```

The status projection names the exact task, goal, phase, completed/total lanes, current/stale/missing evidence, delivery state, pending decisions, last trace and next action. It does not reconstruct state from chat history.

## What's in the pack

| Layer | Skill | Job |
|---|---|---|
| Start here | [`orchestrate-task`](skills/orchestrate-task/SKILL.md) | Route ordinary tasks through the durable control plane |
| Guardrail | [`depth-lock`](skills/depth-lock/SKILL.md) | Lock scope, review rounds and checkpoints |
| Guardrail | [`verify-delivery`](skills/verify-delivery/SKILL.md) | Match delivery claims to current evidence |
| Architecture | [`codebase-design`](skills/codebase-design/SKILL.md) | Design deep modules, interfaces and seams |
| Architecture | [`capability-core-adapters`](skills/capability-core-adapters/SKILL.md) | Keep product behavior behind thin adapters |
| Architecture | [`capability-contract`](skills/capability-contract/SKILL.md) | Define truth, authority, lifecycle and degraded states |
| Meta | [`writing-for-agents`](skills/writing-for-agents/SKILL.md) | Write reliable skills and agent instructions |

Internal methods are selected by the front door when their branch applies. You can still install any skill alone for a narrow task.

## Install, update, remove

The standard installer keeps project copies that a team can inspect and version. To update the full project pack:

```sh
npx skills update --project -y
npx skills update orchestrate-task --project -y
```

To remove it from both claimed hosts:

```sh
npx skills remove capability-contract capability-core-adapters codebase-design depth-lock orchestrate-task verify-delivery writing-for-agents -a codex -a claude-code -y
```

In a restricted environment, copy a skill directory under [`skills/`](skills) with all its supporting files. Every skill contains its own `LICENSE` and `NOTICE.md`.

## Limits and history

Instruction skills do not grant permissions, make a model reliable by themselves or prove that evidence text is true. Project rules, host controls and real test, browser, provider and production systems remain authoritative.

The v0.3.1 release used `finish-task` as its front door. v0.4 replaces that public entrypoint with `orchestrate-task` and adds the runtime/setup package. The immutable [v0.2.0 release](https://github.com/malakhov-dmitrii/agent-process-kit/releases/tag/v0.2.0) remains the migration source. See [compatibility](docs/compatibility.md), [security](SECURITY.md), [third-party notices](THIRD_PARTY.md) and [provenance](docs/provenance.md).
