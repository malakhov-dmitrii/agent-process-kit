# Migrating from v0.2

Version 0.3 replaces the public interface. Existing v0.2 files keep working, but they no longer receive updates from `main`.

## What moved

| v0.2 | v0.3 |
|---|---|
| copy `starter/AGENTS.md` | install and invoke `finish-task` |
| choose five abstract skills | one promoted workflow with disclosed references |
| copy `starter/task-journal.md` | Finish Card created only when the task needs persistence |
| optional lifecycle runtime | preserved in the [v0.2.0 release](https://github.com/malakhov-dmitrii/agent-process-kit/releases/tag/v0.2.0) |

The old release remains immutable. Its source archive and optional automation tarball are still downloadable with checksums.

## Move a project to Finish Task

1. Keep your existing `AGENTS.md`, `CLAUDE.md`, task journals and project rules. They are user-owned and may contain stricter requirements.
2. Install the new skill:

   ```sh
   npx skills add malakhov-dmitrii/agent-process-kit --skill finish-task
   ```

3. Remove old installed skill copies only after checking that no project instruction points to them:

   ```sh
   npx skills remove capability-contract capability-core-adapters codebase-design depth-lock writing-for-agents -a codex -a claude-code -y
   ```

4. Start new work with `Use finish-task on this: ...`.

An existing task journal remains the task's record. `finish-task` should update it instead of creating a competing Finish Card.

## Optional automation

The v0.2 runtime is no longer part of `main`. Keep using the pinned v0.2.0 asset if you rely on its session binding, handoff or hook behavior. Do not combine a moving `main` checkout with the pinned runtime package and assume they share a contract.
