---
name: verify-delivery
description: Use when verifying that a task is done, tests pass, a commit is pushed, a release is deployed, or production works, especially when evidence must distinguish local, committed, pushed, deployed, and production-verified states.
---

# Verify Delivery

Match every delivery claim to current evidence from the system that owns it.

## Workflow

1. **Name the claim.** State the requested delivery boundary and the exact behavior or artifact being claimed.

   Completion: one falsifiable claim is under review.

2. **Run the proof now.** Execute the relevant check after the final change. Read the result. For UI, API, CLI or integration behavior, exercise the real path available in scope.

   Completion: the proof refers to the current tree, commit, artifact or environment.

3. **Grade the stage.** Use [delivery stages](references/delivery-stages.md). Local verification, commit, push, deploy and production behavior require different receipts. Do not infer a later stage from an earlier one.

   Completion: every stage is proved, not requested, or missing a named receipt.

4. **Record limits.** Use [evidence receipts](references/evidence-receipt.md). Name mocked providers, synthetic fixtures, partial suites, unauthenticated views, stale data and unavailable tools.

   Completion: the user can see what the proof does and does not establish.

5. **Report once.** Start with exactly one receipt: `DELIVERED:`, `LOCAL-ONLY:`, `NOT-VERIFIED:`, or `BLOCKED:`. State the proof, remaining work, next owner and required user action.

Never reuse an old success after a relevant edit. A missing or failed check cannot become a passing claim.
