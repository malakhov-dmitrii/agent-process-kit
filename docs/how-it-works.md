# How Agent Process Kit works

`orchestrate-task` is the public front door. It turns an ordinary task message into the same durable commands used by the CLI and host lifecycle adapters. The operator speaks in normal task language; internal skills are selected only when the phase needs them.

## One task record

The runtime keeps one canonical record per task. It stores the request, mode, phase, status, specification and plan generations, story lanes, leases, pending decisions, evidence receipts, external attempts and the next trace. Large documents and proof outputs are immutable artifacts referenced by digest. Chat history is a projection and cannot substitute for the record.

The CLI exposes the same state:

```sh
npx @malakhov-dmitrii/agent-process-kit task start \
  --task-id csv-dedupe \
  --request 'Fix duplicate rows in CSV export' \
  --project .
npx @malakhov-dmitrii/agent-process-kit task status --task-id csv-dedupe
```

The status result includes goal, mode, phase, progress denominator, current/stale/missing evidence, delivery state, pending decisions, last trace and the next owner/action. A fresh session queries this record instead of guessing from prior messages.

## The train

```text
request
  → intake and mode selection
  → clarification when a material decision is missing
  → observable specification
  → executable plan and story graph
  → ATDD red proof
  → TDD implementation
  → bounded spec, plan and code review
  → real local UAT
  → authorized release and reconciliation
  → authenticated production UAT and observation
```

Clear work records why clarification was skipped. Ambiguous work becomes parked until the operator answers the recorded decision. A task can continue through independent ready lanes while one decision is pending.

The built-in method skills have narrow ownership:

- `depth-lock` fixes scope, review caps, non-goals and checkpoints.
- `codebase-design`, `capability-core-adapters` and `capability-contract` cover architecture and ownership branches.
- `writing-for-agents` covers skill and instruction authoring.
- `verify-delivery` checks the evidence required for each delivery boundary.

The front door keeps their choreography internal. A user does not need to remember names or issue phase commands by hand.

## Evidence contours

Every check binds to the candidate content fingerprint, task and spec/plan generations. Full-candidate evidence becomes stale after a relevant content change. Release and production evidence also bind to the target environment, artifact digest, deployment identity and observed revision.

The delivery claims are separate:

1. Local checks and real local UAT prove the candidate in the current workspace.
2. A commit proves one repository snapshot.
3. A push proves a remote ref contains the exact commit.
4. A deploy proves an environment reports that revision.
5. Production UAT and observation prove the authenticated behavior on that revision.

`verify-delivery` reports missing or stale contours. It never converts a green test, ancestor commit or healthy different revision into a later receipt.

## Recovery and controls

Pause revokes active execution grants and leases while preserving artifacts. Cancel is terminal after containment. Unknown provider outcomes enter reconciliation before retry. Handoff transfers the fenced writer only after receiver acceptance. Setup and rollback are hash-guarded and refuse foreign edits.

The package provides a runtime and project-local setup; it does not provide a daemon, hosted coordinator, browser engine, permissions, authentication or production truth. Project rules, host controls and real systems own those boundaries.
