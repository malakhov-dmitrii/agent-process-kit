# Migrating from v0.2

Version 0.3.1 keeps the five v0.2 craft skills, adds `finish-task` as their front door, and adds `verify-delivery` as a standalone guardrail. Existing project instructions and journals keep working.

## What moved

| v0.2 | v0.3 |
|---|---|
| copy `starter/AGENTS.md` | install and invoke `finish-task` |
| five standalone craft skills | the same five, refreshed and independently installable |
| no common entrypoint | `finish-task` orchestrates the common end-to-end path |
| delivery proof embedded in the contract/runtime | `verify-delivery` is a standalone skill and part of `finish-task` |
| copy `starter/task-journal.md` | Finish Card created only when the task needs persistence |
| optional lifecycle runtime | preserved in the [v0.2.0 release](https://github.com/malakhov-dmitrii/agent-process-kit/releases/tag/v0.2.0) |

The old release remains immutable. Its source archive and optional automation tarball are still downloadable with checksums.

## Move a project to the pack

1. Keep your existing `AGENTS.md`, `CLAUDE.md`, task journals and project rules. They are user-owned and may contain stricter requirements.
2. Install or refresh the full pack:

   ```sh
   npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code
   ```

3. If the v0.2 skills were copied manually, replace those five folders with the current versions. Do not delete project-authored skills with the same names; move or rename them first.

4. Start end-to-end work with `Use finish-task on this: ...`, or invoke one craft skill directly.

An existing task journal remains the task's record. `finish-task` should update it instead of creating a competing Finish Card.

## From v0.3.0

Run the full-pack install command above. The existing `finish-task` is updated and the six standalone skills are added. No project task records are rewritten.

## Optional automation

The v0.2 runtime is no longer part of `main`. Keep using the pinned v0.2.0 asset if you rely on its session binding, handoff or hook behavior. Do not combine a moving `main` checkout with the pinned runtime package and assume they share a contract.
