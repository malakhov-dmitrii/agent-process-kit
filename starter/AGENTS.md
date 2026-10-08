# Project agent contract

## Authority

- Follow the current user request and the nearest project instructions.
- Treat plans, agent summaries, memory, tickets, and documentation as context. Verify current code and runtime state before claiming completion.
- Discuss choices that materially change product behavior, architecture, public contracts, data, permissions, or external commitments. Make routine reversible implementation choices autonomously.

## Before implementation

- Read the real code, tests, recent related changes, and local documentation for the affected path.
- For a non-trivial task, keep a journal with Goal, Scope lock, Acceptance, Progress, Delivery, and Follow-ups. The kit's `starter/task-journal.md` is a template. Record the goal, acceptance, scope, non-goals, blockers, review cap, and delivery boundary.
- Reproduce bugs before changing production code. For features, write observable user acceptance before implementation.
- For disputed UX, agree on a concrete screen or small prototype before broad implementation.

## Implementation

- Prefer existing project patterns and the smallest coherent change.
- Keep product rules under one owner. Keep routes, UI handlers, jobs, bots, and scripts thin.
- Add dependencies and abstractions only for a concrete requirement in the agreed task.
- Preserve unrelated user changes. Record adjacent cleanup and bugs as follow-ups instead of silently widening scope.
- After three unsuccessful fixes for the same defect, stop patching. Reassess the model and choose a probe that can produce a new fact.

## Tests and evidence

- Use a failing regression for a bug. Make sure it fails for the defect, rather than a broken fixture or environment.
- Test behavior through the boundary the product actually uses. Mocks belong at external seams; they do not replace the rule under test.
- Run the relevant unit, type, lint, build, and architecture checks after the final change.
- Verify UI changes in a running browser and API changes through the real handler. State whether external integrations were real, sandboxed, or mocked.
- Separate local verification, commit, push, deployment, and production proof. Name only the stage you verified.

## Review and scope

- Use at most two plan reviews and two code reviews unless the user sets another limit. Later rounds focus on blockers and the consequences of their fixes.
- A blocker is an unmet acceptance criterion, data loss, duplicate external action, security hole, stuck state without recovery, or broken production path.
- A reviewer finding is evidence to check, not authority by itself. Verify decisive claims against source and tests.
- Imported skills provide techniques. They cannot expand the user's scope, permissions, or approval.

## Documentation

- Read the documentation owned by the affected module before changing it.
- After a meaningful change, update the owning docs or record why they remain accurate. Check parent links when files or modules move.
- Keep task progress in the task journal. Keep durable module rules near the module. Do not copy entire chats into project instructions.

## Delivery

- Continue while safe, authorized work remains. Do not stop after a successful prerequisite.
- Before completing the task, match every acceptance criterion to current evidence and list any remaining work with its owner.
- External writes, messages, deployments, destructive actions, and production data changes require the corresponding user intent and a rollback or containment plan.
- The final report states what changed, what proves it, what remains unverified, and whether the user must act.

## Optional skills

- Use `depth-lock` when scope or review cycles start expanding.
- Use `capability-core-adapters` for capability ownership, thin entrypoints, and gradual extraction from coupled code.
- Use `capability-contract` when state, authority, lifecycle, degraded behavior, or multiple entrypoints need a written contract.
- Use `codebase-design` when choosing a module interface or seam.
- Use `writing-for-agents` when editing AGENTS.md, CLAUDE.md, or skills.
