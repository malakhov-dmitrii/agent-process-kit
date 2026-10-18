# Queue formats and the captain checklist

Three plain files carry the whole program. Keep them in a scratch directory that survives a reboot and sits outside the repository. One host reboot wiped a temp-folder scratch directory that held agent reports, screenshots and saved logins.

Example lines use invented ids and shas.

Rules for all three files:

- Append only. Fix a wrong line by appending a correction.
- One line per event, pipe-separated, so a script can read it.
- Start every line with a clock time and a time zone. Use the operator's local zone, not UTC.
- Always include a commit sha. A branch name moves, a sha does not.
- When a file and git disagree, git wins. Treat the files as an index.

## ready.md (builders append)

```text
HH:MM TZ | <card-id> | <branch> @ <sha> | base: <branch or tag> | spec: <file or none> | surfaces: <screens, routes, states> | risks: <what could break and what was not run>
```

Example:

```text
10:51 CEST | C-104 | agent/c-104 @ e811cf4 | base: release-0 | spec: tests/c-104.spec.ts (written, not run) | surfaces: list rows, filter bar, thread header | risks: row menu still nested in the row button, browser proof owed
```

## trains.md (integrators append)

```text
HH:MM TZ | train-<area> @ <sha> | cards IN: <id (sha), ...> | cards OUT (reason): <id (reason), ... or none> | proofs: <checks and results on the merged tree, review verdict> | risks: <ordering constraints and what was not verified>
```

Example:

```text
17:20 CEST | train-forms @ bfd8364 | cards IN: C-118 (55dcbac), C-119 (3c60d55), C-124 (b26cca8) | cards OUT (reason): C-122 (UAT failed twice, page stuck on loading, root cause not found in the time box) | proofs: typecheck, lint and unit tests pass on the merged tree, review round 1 found 3 blockers and 2 were fixed test first, 1 rejected with reason, UAT on a reduced matrix green for 3 of 3 | risks: C-124 needs live data the lane lacks, not browser verified, migration 0220 must run before the build
```

Spell out the ordering constraints in `risks`. A migration that must run before the deploy, a reload that old tabs will need and an environment variable that must exist all belong there, because the captain reads this line and nothing else.

## orchestrator-log.md (the captain appends)

```text
- HH:MM TZ: <what happened>. <ids and shas>. <verdict>. <next step>.
```

Example:

```text
- 10:27 CEST: gate on babd79c EXIT 0, receipt written. Review round 1: C-116 REJECT 2 majors, fixed test first in bd35370. Next: UAT pass 1.
```

Write a line at every step, including waits. A stall watchdog reads the age of the last line, and a retrospective rebuilds the timeline from it.

## Captain checklist

Copy this into the batch's first log line and tick it as you go.

1. Take the release lock: `until mkdir release.lock 2>/dev/null; do sleep 20; done`. Create `batch.open`. Only one batch is open at a time.
2. Take the oldest unshipped train from `trains.md`. Count the cards and estimate the time. Above about six cards or sixty minutes, split the train and ship part of it.
3. Merge the latest main into the train. Log the main sha.
4. Run the full gate once, in the release class of the slot queue. A green run writes a receipt keyed to the exact tree.
5. Run the UAT matrix once. Sort each failure into real defect, environment, flake or missing data. Fix real defects test first. Revert a card that cannot be fixed in about 30 minutes and return it to a builder.
6. Get one review round on the merged diff, blockers only. Give the reviewer the rule list and a contact sheet of screenshots, because a diff reviewer cannot see pixels.
7. Push main. If main moved, merge again and check whether the receipt key still matches. Deploy using the receipt.
8. Read the deployed revision from the environment. A script that exited 1 on a timer does not prove the deploy failed. Read the platform's deployment state and wait while a build is in progress.
9. Run a read-only production check of the core flows. It never sends, saves, deletes or pays.
10. Write the release note, append the final log line, remove `batch.open` and release the lock with `rmdir release.lock`.
11. Answer status questions from the log, as a clock time for the next release only.

## A status page from the logs

The same three files feed a status page, so the operator does not need to ask. Generate it from `ready.md`, `trains.md` and the log tail: cards built and waiting, the train in integration, the batch in flight with its last log line and age, and the last revision live. Label work that is built but not shipped as "built, in integration", not "integrating", because the shorter label suggested production to the operator.
