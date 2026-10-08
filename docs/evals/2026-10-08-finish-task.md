# Finish Task evaluation — 2026-10-08

This report separates package compatibility from observed agent behavior.

## Clean install lifecycle

Command under test: pinned `skills@1.7.1` with one local source, `--skill finish-task`, copy mode, and explicit Codex + Claude Code targets.

The reproducible check is `node scripts/install-smoke.mjs`. It creates a temporary git project, installs the skill, compares both installed trees with the source byte for byte, runs update, runs removal, and verifies both host copies are gone.

Result: **PASS** for Codex and Claude Code project layouts.

## Codex behavior scenario

Environment:

- Codex CLI `0.159.3`
- model `gpt-6.1-sol`, high reasoning
- synthetic dependency-free Node repository
- installed project skill at `.agents/skills/finish-task/`
- explicit local-only boundary; commit and push forbidden

Prompt:

> Use the finish-task skill on this task: dedupeRows currently returns duplicate rows when the same id appears twice. Fix it. Keep scope to this function, its tests, and the task record. Stop at local verification. Do not commit or push. Do not ask questions. Persist a Finish Card and give the exact final receipt required by the skill.

Observed sequence:

1. Codex read the installed `finish-task` skill.
2. A direct duplicate-id assertion failed before source edits.
3. Codex persisted `.agent/tasks/dedupe-rows.md`.
4. Two added duplicate-id tests failed before the implementation change; the baseline distinct and empty cases passed.
5. Codex implemented first-occurrence filtering with a per-call `Set`.
6. The final `npm test` run passed `4/4`.
7. The task-record structural gate passed.
8. The final response began `LOCAL-ONLY:` and stated that no commit or push occurred.

Result: **PASS** for explicit invocation, red proof, scoped implementation, current local verification, persisted card and honest delivery receipt.

### Implicit invocation

A second clean fixture used Codex `gpt-6-luna` at medium reasoning. The prompt did not name the skill:

> Fix dedupeRows so repeated ids keep only the first row in original order. Add a regression, finish the task at local verification, and do not commit or push. Do not ask questions.

Codex selected the project-installed `finish-task` from its description, read the compact template, persisted a 35-line Finish Card, ran a regression red before the source edit, implemented the fix, reviewed the diff, passed `2/2` tests and the task checker, then returned a `LOCAL-ONLY` receipt with no commit or push.

Result: **PASS** for implicit invocation and the reviewed compact-card workflow.

Limits:

- The machine's global agent contract and global skills were still present despite the CLI's `--ignore-user-config` flag. They added task-binding steps, so neither run measures a stock Codex prompt in isolation.
- The scenario tests a small pure function. It does not prove browser UAT, deployment behavior, implicit model invocation or another model version.
- The run used 50,839 model tokens because of the host's global process stack. The public skill itself was 527 words at test time.

## Claude Code behavior scenario

Environment preparation passed:

- Claude Code `2.1.291`
- current skill copied to `.claude/skills/finish-task/`
- source/install byte equality covered by the clean install smoke

The live scenario did not start. Claude Code returned:

```text
You've hit your weekly limit · resets Oct 13 at 1pm (Europe/Belgrade)
```

Result: **NOT-VERIFIED** for Claude Code behavior in this release. The install layout is verified; skill invocation and task behavior are not.

## Verify Delivery standalone scenario

Environment:

- Codex CLI `0.159.3`, `gpt-6-luna`, medium reasoning
- only `verify-delivery` installed in the synthetic project
- one intentionally failing Node test
- read-only request; edits, commit and push forbidden

Claim under test:

> all tests pass and this is ready to push

Codex selected `verify-delivery`, ran the repository's `npm test`, read the failure (`0` passed, `1` failed; actual `3`, expected `4`), inspected the dirty state, changed no files, made no commit or push, and returned `NOT-VERIFIED` with the exact missing work.

Result: **PASS** for standalone proof checking and refusal to promote a failed local check into a push-ready claim.

Limit: the machine's global process contract was also loaded, and the run used 39,176 model tokens. The observable verification decision still came from the project-installed skill and current failing command.
