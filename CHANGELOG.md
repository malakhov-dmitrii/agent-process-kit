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
