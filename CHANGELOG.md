# Changelog

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
