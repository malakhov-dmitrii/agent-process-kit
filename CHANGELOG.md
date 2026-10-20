# Changelog

## 0.5.0 - unreleased

- Added `run-agent-trains`: roles, queue formats and a captain checklist for many parallel builders, integration trains and one serial release captain, with a batch cap of about six cards or sixty minutes, a main freeze while a batch is in flight, heavy-job slots, a follow-up claim queue and guards for stalls and session limits. Ships `heavy-slot.sh`, `claim.sh` and `watchdog.sh`.
- Added `brief-agents`: a brief template with copied rules, a coverage inventory built from the code, a decision log with a promise ledger, and a defect-cause classification (spec or coverage 14, verification 8, brief 3, churn 3, regression 1, ignored rule 0 in the audited program). Ships `uncovered.sh`.
- Added `design-gates`: a static ratchet, geometry specs and a style matrix run in two opposite themes, a new-surface rule, and a procedure that shows each gate red by planting a violation. Ships `ratchet.mjs` and an example config.
- Added `audit-agent-program`: a three-lens retrospective (throughput, quality, parallelism) with an audit brief, a finding format and lens definitions.
- Extended `verify-delivery` with tree-keyed gate receipts (`gate-receipt.sh`), the rule that DELIVERED needs evidence, and a specification for a stop-hook receipt gate.
- Added the case study `docs/multi-agent-program.md` with the numbers behind the new skills and the practices that are recommended but not yet exercised.
- The pack now has eleven skills. The install, update and remove commands, the compatibility page, the repository checks and the install smoke list all of them. `orchestrate-task` is unchanged.
- Added `tests/scale-out-skills.test.mjs`, which runs the shipped scripts: it races the slot script and the claim script, plants violations for the ratchet, and checks the receipt key.
- Fixed in review, before release:
  - `heavy-slot.sh` starts the command as the leader of its own process group (job control, else `setsid`, else `perl`), forwards INT, TERM and HUP to the whole group with KILL after `GRACE` seconds, stops what the command leaves behind, and frees the slot only once the group is gone. A claim on a slot is a directory `slot-N.G` that a job only creates and marks `released`; a later claim sweeps only stale claims older than `RETAIN` minutes, so a job normally cannot delete a claim that another job still uses. A claim is treated as stale when it is released or its wrapper and its group are gone, and the command publishes its own group id from inside the group before it runs. The command no longer inherits standard input. The script is documented as a best-effort single-host helper, with its remaining races listed in the script header and in `heavy-slots.md`.
  - `gate-receipt.sh` keys each path by `git ls-tree` mode, type and object id, so a chmod changes the key. It refuses an empty `RECEIPT_PATHS`, an invalid revision, a path outside the repository, a path spelled with a `.` segment, and a list that matches nothing. It checks cleanliness of the whole repository from its root, and `receipt_write` refuses an unclean one. New `receipt_invalidate` starts a numbered run record, so a red or crashed rerun, even one that overlaps with a passing run, takes an earlier pass away, and `receipt_write` refuses while another run of the tree is alive. Keys must be hex object ids. Plain repositories without submodules are supported and anything unusual is refused rather than guessed: a submodule, `core.fileMode=false`, `core.symlinks=false`, an assume-unchanged or skip-worktree entry anywhere, a symlink at or above a keyed path, and a failing `git status`.
  - `ratchet.mjs` compares the baseline file with the committed copy, so a hand-raised count fails unless `--allow-raise` is passed (also for `--write`). `--diff` follows renames and counts copies as new. A missing root, a scan that finds no files and an unknown `--diff` revision are errors, a recorded count that is not a non-negative integer is an error, and `--diff` counts untracked files and type changes as new, with no credit for the hits the old file held.
  - `audit-agent-program` stays read-only: it ranks recommendations and names the checks, and implementing them is a separate task the operator approves.
  - `watchdog.sh` claims the alert with `mkdir` before it sends, so overlapping runs send one alert, and a failed send gives the claim back; an overlap just as a batch opens can still send a second alert, which the script documents. `claim.sh` accepts only plain names and checks that the owner record was written. `uncovered.sh` fails outside git, on a missing cards directory and on a pattern that matches nothing.
  - Docs: the release lock is one absolute shared path with a bounded wait and a stale-lock recovery. Production proof is required only when the requested boundary includes production. Headless-engine and laptop limits are stated as what held in the audited environment. `docs/compatibility.md` says v0.5.
  - Tests: `tests/scale-out-regressions.test.mjs` pins each of these, and the slot-reservation test now uses explicit handshakes instead of sleeps.

## 0.4.0 - unreleased

- Replaced the v0.3.1 `finish-task` front door with `orchestrate-task` for ordinary natural-language requests.
- Added the dependency-free Node.js runtime, CLI, durable task record, artifact references and hash-guarded project setup/rollback.
- Added conditional clarification, reviewed specification and plan, ATDD/TDD, bounded review, local UAT and separate release/production proof contours to the public onboarding.
- Updated Codex and Claude clean-install smoke coverage, per-skill notices and licenses, and English/Russian command parity.

## 0.3.1 - 2026-10-08

- Kept `finish-task` as the front door and restored the five standalone v0.2 craft skills.
- Added `verify-delivery` as an independent proof and delivery-stage guardrail.
- Added complete-pack and single-skill clean install/update/remove coverage.
- Added license, notice and Codex display metadata to every distributed skill.
- Reworked the landing page around the pack taxonomy while preserving the fast first task.

## 0.3.0 - 2026-10-08

- Replaced the copy-a-contract front door with one promoted `finish-task` skill.
- Added the Finish Card and separate local, commit, push, deploy and production evidence contours.
- Made the standard `skills` CLI the recommended install/update/remove path.
- Moved specialist architecture and recovery rules behind progressive-disclosure references.
- Removed the v0.2 optional runtime and five abstract standalone skills from `main`; the immutable v0.2.0 release preserves them.
- Added clean Codex/Claude Code install smoke and public-interface checks.

## 0.2.0 - 2026-10-08

- Made the default kit zero-install: copy the starter contract and select only relevant skills.
- Added a concise journal template and guides for the workflow and skill selection.
- Moved the executable lifecycle package into `optional-automation/`.
- Removed the vendored Superpowers snapshot and linked to its upstream project.
- Kept the optional runtime test, smoke, packaging, and recovery gates intact.

## 0.1.0 - 2026-10-07

Initial public release:

- Explicit session/task binding and journal identity validation.
- Canonical handoff records with recoverable pending acceptance.
- Recorded-checklist readiness and explicit evidence-verification limits.
- Context, completion and checkpoint adapters.
- Portable CLI, opt-in project setup and guarded rollback.
- Licensed architecture/process skills and optional Superpowers snapshot.
- Linux/macOS CI and packaged-installation smoke tests.
