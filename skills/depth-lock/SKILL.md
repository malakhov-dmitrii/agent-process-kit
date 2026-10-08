---
name: depth-lock
description: Use when starting non-trivial work, fixing repeated review loops, stopping findings from widening scope, setting wall-clock checkpoints, or when the user says "не полируй", "не растягивай", "stop polishing" or "timebox".
---

# Depth lock

Finish the task at the agreed depth, fast. Robust means the safety invariants hold. It does not mean endless review rounds or cleanup of neighbouring code.

## 1. Before building: write the scope lock into the task journal

Use the active task journal (for example `.agent/tasks/<task>.md`). If there is no journal, put it in the plan file.

```
## Scope lock
Goal: <one user-visible sentence>
Acceptance: <testable bullets: what proves it works>
In scope: <items or conditions>
Non-goals: <explicit list, including tempting refactors>
Blockers (the only findings that stop the ship): <project list; default: duplicate action (double send, charge or write), lost data, stuck state with no recovery, security hole, broken production path>
Review caps: plan ≤ 2 rounds, code ≤ 2 rounds; every round after the first reports blockers only
Checkpoints (wall clock, UTC): plan HH:MM · build HH:MM · gate HH:MM · ship HH:MM
Follow-ups: <journal section, issue tracker or spawned tasks>
```

- Estimate in agent wall-clock time with parallel agents, not in human-team days.
- If the scope is clear, state the lock and proceed. Ask the operator only when the scope is genuinely ambiguous.

## 2. During the work

- Classify every review finding as `blocking`, `deferred` or `approved-expansion`. Only `blocking` findings and approved expansions enter the current work.
- A later review round gets the prompt "blockers only; no style, naming, nice-to-haves or scope expansion".
- If the last allowed round still finds blockers, fix them test-first and verify them in the code review or the gate. Do not open another round.
- Refactor only what the change forces, such as a file-size limit the change would break. Record every other refactor as a follow-up.
- When a checkpoint slips, cut non-safety scope and say what was cut. Never cut a blocker-class safeguard. Never add review rounds or stretch the timeline.
- Keep going between checkpoints without asking "should I continue?".

## 3. Follow-ups

Record each out-of-scope item with:
- what it is;
- where it was noticed (file:line or the review finding);
- why it matters;
- the suggested next step.

Record it in one of these places:
- the journal's `## Follow-ups` section;
- the project's issue tracker;
- a separate spawned task, when the host offers one (Claude Code desktop: `spawn_task`).

Never drop a follow-up silently, and never fold one into the current work silently.

## 4. Close-out

The final report covers:
- what was delivered against the acceptance list;
- what was cut, and why;
- the follow-ups created, with their location or links;
- the receipt, if your setup uses one (for example `DELIVERED:` or `LOCAL-ONLY:`).

## Anti-patterns

- A third plan-review round because "one more pass is safer".
- A cleanup of files next to the change "while we are here".
- Turning a reviewer's nice-to-have into a task.
- Answering a slipped checkpoint with a new review cycle.
- Estimating "9–11 days" for work that parallel agents finish in hours.
