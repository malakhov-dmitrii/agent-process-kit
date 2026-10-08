---
name: finish-task
description: Use when the user asks to fix, build, implement, migrate, refactor, or finish a concrete repository change and expects the work carried through to verified completion without scope drift or false delivery claims.
---

# Finish Task

Give the work a visible finish line, then continue until the requested boundary is proven or a real blocker remains. Input is the task plus an optional delivery boundary, which defaults to `local`. A later boundary requires the user's authorization.

Do not use this workflow for explanation-only, research-only, status-only, or review-only requests unless the user explicitly invokes `finish-task`.

## Workflow

1. **Discover.** Read the nearest project instructions, implementation, tests and related changes. Reproduce a bug before editing. For a feature, state observable acceptance first.

   Completion: behavior, owner and project gate are known.

2. **Set the finish line.** Show a compact **Finish Card** with goal, scope, acceptance and delivery boundary. Persist multi-step or long-session work in the project's task-doc location or `.agent/tasks/<slug>.md`. Keep a one-step task in chat.

   Use the [Finish Card template](references/finish-card.md). Cap plan and code review at two rounds each.

   Completion: the user can tell what will count as finished and what will not enter the task.

3. **Make proof go red.** A bug needs a reproduction or regression that fails for the actual defect. A feature needs an acceptance check at the boundary the user experiences. Resolve disputed UX or architecture with the smallest concrete prototype or decision first.

   Completion: the proof distinguishes current from intended behavior.

4. **Implement the whole card.** Make the smallest coherent change that satisfies every accepted item. Preserve unrelated work and put adjacent cleanup in follow-ups. Load [architecture decisions](references/architecture-decisions.md) only when ownership, authority, lifecycle, public contracts or module seams change.

   Completion: every accepted item is implemented.

5. **Review the final diff.** Compare it with the card and project rules. Use an independent reviewer for non-trivial work when available. Classify findings as blocking or deferred, fix blockers within the cap, and record the review.

   Completion: no blocking finding remains.

6. **Verify after the final edit.** Run affected tests and project gates. Exercise the real handler, CLI, browser or session path when one exists. On failure, follow [first-error recovery](references/first-error-recovery.md) and rerun the same proof.

   Completion: every acceptance item points to current evidence or names the exact unavailable proof and owner.

7. **Deliver to the authorized boundary.** Treat `LOCAL-ONLY`, `COMMITTED`, `PUSHED`, `DEPLOYED` and `PRODUCTION-VERIFIED` as separate facts. Use [delivery stages](references/delivery-stages.md) and [evidence receipts](references/evidence-receipt.md). A test pass never proves a push; a push never proves a deploy; a deploy never proves the real production flow.

   Completion: the requested boundary has a receipt, or the result is honestly `NOT-VERIFIED` or `BLOCKED`.

8. **Close the card.** Update acceptance, evidence, remaining work and next owner. The final reply starts with one receipt: `DELIVERED:`, `LOCAL-ONLY:`, `NOT-VERIFIED:`, or `BLOCKED:`. Link the Finish Card when persisted.

Continue through safe, authorized work without asking whether to continue. Ask only when a product, architecture, data, permission or external-action decision is still unresolved.
