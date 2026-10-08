# Agent Process Kit

## Give your coding agent a finish line.

[![CI](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml)
[Русский](README.ru.md) · [How it works](docs/how-it-works.md) · [Compatibility](docs/compatibility.md)

Agent Process Kit is a pack of seven plain `SKILL.md` workflows. Start with `finish-task`: it takes one concrete repository change from the first inspection to a reviewable result, then pulls in the pack's scope, architecture, authoring and delivery disciplines when they fit.

Every skill also works on its own. The pack has no daemon, hook, account, background process, telemetry, or runtime dependency.

## Install the pack

Install all seven skills for Codex and Claude Code:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code
```

If you only want the end-to-end front door:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill finish-task
```

## Try it on real work

Give your agent a real task:

> Use `finish-task` on this: fix duplicate rows in CSV export. Keep the scope to the export path, prove the bug before changing code, run the real export flow, and stop at local verification.

The first useful output is a **Finish Card**:

```text
FINISH CARD

Goal             CSV export emits each logical row once.
Scope            Export pagination and deduplication only.
Acceptance       Red reproduction, regression, real export, project gates.
Delivery boundary
                 Local verification. No push or deploy claim.
```

The final output closes the same card with current evidence and one honest receipt:

```text
LOCAL-ONLY: Duplicate export rows are fixed.

Verified: failing reproduction, regression, affected checks, real export flow.
Not claimed: commit, push, deploy, production behavior.
```

That is the product. There is no framework to configure before useful work starts.

## How it works

```text
request
  → Finish Card
  → failing reproduction or observable acceptance
  → complete scoped change
  → diff review against the card and project rules
  → project gates + real user path
  → evidence receipt at the authorized delivery boundary
```

`finish-task` branches by the work in front of it:

- **Bug:** reproduce → isolate the cause → failing regression → fix → rerun the real path.
- **Feature:** observable acceptance → scope → implementation → acceptance and project gates.
- **Architecture change:** resolve ownership, authority, lifecycle and module seams before broad edits.
- **Delivery:** keep local, commit, push, deploy and production verification as separate facts.

For multi-step or long-session work, the skill persists the Finish Card in the project's task-doc location or `.agent/tasks/<slug>.md`. A one-step change can keep the card in chat.

Read [the workflow and evidence model](docs/how-it-works.md) for the exact sequence.

## What's in the pack

| Layer | Skill | Job |
|---|---|---|
| Start here | [`finish-task`](skills/finish-task/SKILL.md) | Carry one code change from scope to proof |
| Guardrail | [`depth-lock`](skills/depth-lock/SKILL.md) | Lock scope, review rounds and checkpoints |
| Guardrail | [`verify-delivery`](skills/verify-delivery/SKILL.md) | Match “done”, push, deploy and production claims to current evidence |
| Architecture | [`codebase-design`](skills/codebase-design/SKILL.md) | Design deep modules, interfaces and seams |
| Architecture | [`capability-core-adapters`](skills/capability-core-adapters/SKILL.md) | Keep product behavior behind thin entrypoint adapters |
| Architecture | [`capability-contract`](skills/capability-contract/SKILL.md) | Define truth, authority, lifecycle, commands and degraded states |
| Meta | [`writing-for-agents`](skills/writing-for-agents/SKILL.md) | Write skills and agent instructions that fire reliably |

`finish-task` is the memorable path through the pack. The other six remain independently discoverable and installable; you do not need to run the full train for a narrow architecture or authoring task.

## Install, update, remove

The commands above use the open [`skills`](https://github.com/vercel-labs/skills) installer. Without `-g`, the installer keeps the skills with the current project so a team can review and version them. Add `-g` for a user-level install shared by projects.

```sh
npx skills update
npx skills remove capability-contract capability-core-adapters codebase-design depth-lock finish-task verify-delivery writing-for-agents -a codex -a claude-code -y
```

To install or remove one skill, replace the list with its name. Restricted or offline environments can copy any folder under [`skills/`](skills) directly into the host's skill directory.

## What this replaces

Version 0.2 presented five independent skills but no convincing front door. Version 0.3.0 overcorrected and reduced the product to `finish-task`. The current pack keeps that strong entrypoint and restores the independent craft skills around it, with `verify-delivery` added as a reusable proof guardrail.

The old runtime and standalone skills remain available in the immutable [v0.2.0 release](https://github.com/malakhov-dmitrii/agent-process-kit/releases/tag/v0.2.0). See [migration from v0.2](docs/migration-v0.2.md).

## Limits

An instruction skill cannot grant permissions, make a model reliable by itself, or prove that evidence text is true. Project rules and host controls still own access and safety. `finish-task` makes the work and its missing proof visible; the repository's real tests, runtime, browser and release system provide the evidence.

Research behind this redesign: [competitive skill systems](docs/research/competitive-skill-systems-2026-10-08.md). License and provenance: [THIRD_PARTY.md](THIRD_PARTY.md) and [docs/provenance.md](docs/provenance.md).
