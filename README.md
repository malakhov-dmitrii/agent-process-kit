# Agent Process Kit

## Give your coding agent a finish line.

[![CI](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml)
[Русский](README.ru.md) · [How it works](docs/how-it-works.md) · [Compatibility](docs/compatibility.md)

`finish-task` takes one concrete repository change from the first inspection to a reviewable result. It defines what done means, keeps scope from drifting, makes bugs or acceptance go red, verifies the real user path, and reports exactly what is local, committed, pushed, deployed, or proven in production.

The installed product is one plain `SKILL.md` folder. It has no daemon, hook, account, background process, telemetry, or runtime dependency.

## Try it on real work

Install the skill into a project:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill finish-task
```

Then give your agent a real task:

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

## Install, update, remove

The command above uses the open [`skills`](https://github.com/vercel-labs/skills) installer and lets you choose the detected agent. To target Codex and Claude Code explicitly:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill finish-task -a codex -a claude-code
```

Use `-g` for a user-level install shared by projects. Without `-g`, the installer keeps the skill with the current project so a team can review and version it.

```sh
npx skills update finish-task
npx skills remove finish-task
```

Restricted or offline environments can copy [`skills/finish-task`](skills/finish-task) directly into the host's skill directory. The source remains ordinary Markdown.

## What this replaces

Version 0.2 presented a starter contract, a journal template, five abstract skills, and an optional lifecycle runtime. They were correct parts with no convincing front door. Version 0.3 makes the common job the interface: finish one real coding task with proof.

The old runtime and standalone skills remain available in the immutable [v0.2.0 release](https://github.com/malakhov-dmitrii/agent-process-kit/releases/tag/v0.2.0). See [migration from v0.2](docs/migration-v0.2.md).

## Limits

An instruction skill cannot grant permissions, make a model reliable by itself, or prove that evidence text is true. Project rules and host controls still own access and safety. `finish-task` makes the work and its missing proof visible; the repository's real tests, runtime, browser and release system provide the evidence.

Research behind this redesign: [competitive skill systems](docs/research/competitive-skill-systems-2026-10-08.md). License and provenance: [THIRD_PARTY.md](THIRD_PARTY.md) and [docs/provenance.md](docs/provenance.md).
