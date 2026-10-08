# How Finish Task works

`finish-task` is the pack's front door: one deep workflow behind a concrete coding task and an optional delivery boundary. The other skills remain available for narrower work.

## The artifact chain

```text
request
  → Finish Card
  → red proof
  → scoped implementation
  → diff review
  → current verification
  → delivery receipt
```

The Finish Card stays stable while the implementation changes. It tells the agent and user what belongs in the task, what proves the result, and where delivery stops.

## How the pack composes

- `depth-lock` owns scope, review caps and checkpoints.
- `verify-delivery` owns current evidence and delivery-stage claims.
- `codebase-design`, `capability-core-adapters` and `capability-contract` own architecture branches.
- `writing-for-agents` owns skills and agent instruction documents.

`finish-task` carries a self-contained minimum of these rules so it can be installed alone. With the full pack installed, each specialist is also directly invokable. A narrow task should load the relevant specialist instead of paying for the whole end-to-end workflow.

## 1. Discover the real project

The workflow starts from project instructions, current code, affected tests, recent related changes and the repository's actual commands. Old plans, docs and agent summaries are context until verified.

A bug begins with a reproduction. A feature begins with behavior that a user or caller can observe. If the agent cannot find either, it has not earned an implementation plan yet.

## 2. Set the finish line

The first response presents the compact goal, scope, acceptance and delivery boundary. Multi-step work persists the [Finish Card template](../skills/finish-task/references/finish-card.md).

The delivery boundary defaults to local verification. Commit, push, deploy and production verification require the user's intent plus the project's own release rules.

The scope lock names non-goals and caps review. Later findings enter the current task only when they block acceptance, risk data loss or duplicate actions, create a security hole, leave an unrecoverable stuck state, or break a production path. Everything else becomes a follow-up.

## 3. Make the right thing red

For a bug, the reproduction must fail for the reported defect instead of a broken fixture or environment. For a feature, the acceptance check must cross the same boundary real callers use. A screenshot can prove visible state; it cannot prove keyboard access or production data. A mocked provider can prove local rules; it cannot prove the provider integration.

The workflow records those limits instead of erasing the useful part of the result.

## 4. Finish the whole card

The agent implements every accepted item, preserves unrelated work and continues after successful prerequisites. Architecture detail loads only when the task changes ownership, authority, lifecycle, public contracts or reusable interfaces.

The default is the smallest coherent change, not the smallest diff. A partial foundation does not satisfy a user-visible acceptance item.

## 5. Review the final diff

Review compares the completed diff with the Finish Card and project rules. Non-trivial work uses an independent reviewer when the host provides one. Findings are either blocking or deferred; only blockers enter the current fix train, and the review cap stays fixed.

The review receipt belongs in the Finish Card's Evidence section. Verification starts after blocking review findings are resolved.

## 6. Verify the final state

Verification runs after the last relevant edit. It combines the project's automated gates with the real handler, CLI, browser or session path when that path exists.

Failures follow [first-error recovery](../skills/finish-task/references/first-error-recovery.md): preserve the error, classify it, choose a discriminating probe, repair the cause and rerun the same proof. Three failed fixes trigger a model reset before another edit.

## 7. Report the delivery stage

[Delivery stages](../skills/finish-task/references/delivery-stages.md) are independent claims:

- local checks and UAT;
- a commit containing that state;
- a remote ref containing that commit;
- an environment reporting that revision;
- the real authenticated production flow on that revision.

The final response uses one receipt and links the Finish Card when it exists. Missing later stages remain visible. This prevents a green local test, commit or push from masquerading as a production result.

## What the skill cannot enforce

The skill is Markdown loaded by the host. It cannot grant permissions, prevent a model from ignoring instructions, authenticate a runtime, or independently validate evidence. Host controls, project rules and the product's real systems remain authoritative.

The value is a smaller, sharper interface for the work: one finish line, one durable card when needed, and claims that match their proof.
