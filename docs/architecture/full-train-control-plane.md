# Capability Contract: Full-Train Task Orchestration

Status: implementation authority; single spec review round complete

Date: 2026-10-08

## Summary

Agent Process Kit runs a coding task from natural-language intent through specification, planning, implementation, local acceptance, release and production verification. The operator gives the task and answers material decisions. The control plane selects internal skills, coordinates agents, persists state, resumes after interruption and reports the exact delivery stage.

The public interface is ordinary language:

```text
<task>
кати | ship
+ | продолжай
дай статус
pause | stop
```

The operator does not need to remember skill names or manually advance phases.

## Product Promise

A task is complete only when its locked Definition of Done is satisfied at the requested delivery boundary. Green unit tests, a commit, a push or a successful deploy are intermediate facts unless they are the agreed boundary.

## Entry Points

- Host chat: Codex, Claude Code or another supported agent host.
- CLI: task start, status, resume, handoff, check, pause and cancel.
- Host lifecycle adapters: session start, compaction, stop and task completion.
- Git adapter: branch/worktree state, commits and remote-ref readback.
- Review adapters: independent spec, plan and code review agents.
- Verification adapters: test runner, browser, API/CLI/session probes.
- Release adapters: repository, CI, deployment provider and build metadata.
- Issue/project adapters: optional task and proof publication.

Every entrypoint calls the same control-plane commands. Chat, CLI, hooks and scheduled continuation cannot each own their own lifecycle rules.

## Owner

The full-train control-plane core owns task lifecycle, artifact identity, phase transitions, grants, evidence freshness and completion eligibility.

Host adapters translate events and render status. Skills provide techniques inside a phase. Neither owns canonical task state.

## Source Of Truth

The canonical task record is a durable, atomically replaced record bound to one task ID. It points to immutable or versioned artifacts instead of embedding every document.

```text
task record
  ├── current phase and task status
  ├── operator intent and delivery boundary
  ├── artifact manifest
  ├── decision and grant records
  ├── story/dependency state
  ├── active owner and leases
  ├── evidence receipts
  ├── external-effect receipts
  └── checkpoint/handoff generation
```

The record is authoritative for orchestration state. It is not authoritative for code, provider state or production behavior:

- Git owns files, commits and remote refs.
- Test/runtime/browser systems own behavior evidence.
- Deployment providers own rollout state.
- Production readback owns production truth.
- The operator owns intent, product decisions and external authorization.

## Candidate And Evidence Identity

Every implementation candidate has a stable identity:

```text
CandidateIdentity
  taskId
  specGeneration
  planGeneration
  contentFingerprint
  commitSha?           # once committed
  artifactDigest?      # once packaged
```

`contentFingerprint` covers the actual working-tree content under evaluation, including relevant untracked source. It remains stable across commit amend/rebase when content is identical.

Every test, review and UAT receipt binds:

- candidate identity;
- producer and tool/model version;
- command or scenario identity;
- started/completed time and exit/verdict;
- coverage: full candidate or an explicit allowlist of paths/contracts;
- referenced fixture/runtime identity;
- output/log artifact hashes.

A content change invalidates a full-candidate receipt. A scoped receipt remains current only when the control plane proves every changed path and affected contract is outside its declared coverage. Unknown impact fails closed and marks the receipt stale.

Release and production receipts additionally bind:

```text
environmentId
deploymentId
artifactDigest
deployedRevision
observedAt
```

`completeTask` compares required receipts with the final candidate identity and requested environment. Similar filenames, an ancestor commit or a healthy different revision never satisfy the gate.

## Authority

### Operator

The operator owns:

- intent, success criteria and rejected outcomes;
- scope changes after the lock;
- product, architecture, data and permission decisions;
- credentials and external-access grants;
- commit/push/deploy/production intent when it was not already stated;
- acceptance of risks that weaken the locked DoD;
- pause, cancel and destructive rollback decisions.

`да`, `кати`, `ship`, `правь`, `+` or `продолжай` authorize the already proposed and locked next train or checklist. They do not silently authorize a new product direction or an external action outside that lock.

### Orchestrator

The orchestrator may autonomously:

- discover code, docs, history and runtime evidence;
- choose internal skills and role agents;
- make routine reversible decisions inside the lock;
- create isolated branches/worktrees and synthetic fixtures;
- execute ready stories in parallel;
- fix blockers and rerun required proof;
- continue through phases whose gates are already satisfied and authorized.

### Writer And Workers

One integration owner writes canonical task state and shared integration state at a time. Parallel workers own isolated stories, branches, worktrees or artifact drafts. A lease identifies the current writer and expires or is explicitly handed off.

Every lease has:

```text
WriterLease
  leaseId
  taskId
  scope                 # canonical task or story/worktree
  ownerHost
  ownerSession
  generation
  fenceToken            # monotonically increasing per scope
  acquiredAt
  renewBefore
  expiresAt
  revokedAt?
```

Every mutation supplies the lease ID, fence token and expected record version. The store atomically rejects an expired/revoked lease, a lower fence token, the wrong scope or a stale version. Expiry alone does not transfer ownership; a new acquisition increments the fence token before it can write.

Story workers hold story-scoped leases and submit immutable results. Only the integration lease may advance canonical phase/artifact pointers. Handoff revokes the sender lease and increments the fence only after receiver acceptance; a prepared handoff changes no ownership.

### Reviewers

Reviewers produce evidence and findings. They cannot mutate canonical spec, plan, task state or product code unless separately assigned as a writer. The integration owner verifies decisive claims and incorporates accepted blockers.

### Release Adapter

The release adapter may execute only the delivery boundary granted by the operator and allowed by project release rules. It never substitutes a generic deploy path for a project-specific one.

### External Intent And Execution Grants

Operator intent and an executable grant are separate records.

- Intent such as `кати` may be recorded before a release candidate exists and persists across sessions.
- At `release-ready`, the control plane may materialize that existing intent into a grant only when the locked scope and requested boundary still match.
- The execution grant binds the exact candidate, target and allowed action.

```text
ExecutionGrant
  grantId
  taskId
  operatorIdentity
  granteeRole
  allowedAction
  targetResource
  deliveryBoundary
  specGeneration
  planGeneration
  candidateIdentity
  constraints
  issuedAt
  expiresAt
  maxUses
  revokedAt?
```

The grant is invalid after expiry, revocation, pause, cancel, rollback, spec/plan generation change, candidate content change or target change. Resume revalidates intent and creates a new execution grant; it never revives an old grant. Handoff preserves operator intent but the new active writer must acquire its own lease before using a still-valid role grant.

Every external attempt consumes or references the grant, active fencing lease and idempotency key. A grant cannot authorize an action whose target or candidate was unknown when the grant was created.

## Task Modes

The orchestrator selects a mode from discovered complexity and risk. The operator may override it.

| Mode | Use when | Required phases |
|---|---|---|
| `quick` | Clear one-step mechanical work with no product, architecture, data, permission or external-effect decision | Intake, compact acceptance, implementation, self-review, affected gates, real-path check for any externally observable behavior, delivery receipt |
| `standard` | Default non-trivial feature, bug, migration or refactor | Full lifecycle, one bounded independent review of spec, plan and code, local UAT, requested release boundary |
| `full-train` | Explicit Ralph/goal train, multi-story product work, auth/data/high-risk architecture, or operator request | Zero-ambiguity spec and plan, machine story graph, max safe parallelism, independent plan/code challenge, fix train, machine completion gates, local and requested production proof |

Mode changes are decisions in the journal. A task cannot downgrade mode to bypass a failed gate. In `quick`, only a pure docs/internal-metadata change with no runtime-facing acceptance may skip the real-path check, and the card records that reason. Clear work skips unnecessary ceremony; every skipped phase records why its gate is already satisfied.

## Lifecycle

Task status and execution phase are separate.

Task status:

```text
active | parked | blocked | paused | cancelled | complete | rolled-back
```

Execution phase:

```text
intake
  → clarify
  → spec-draft
  → spec-review
  → plan-draft
  → plan-review
  → implement
  → code-review
  → local-uat
  → release-ready
  → release
  → production-uat
  → observe
  → close
```

Phases may loop backward through named failure transitions. They never skip a required gate because a later phase appears green.

## Transition Matrix

Task-status transitions:

| From | Event / gate | To | Recovery rule |
|---|---|---|---|
| `active` | Operator pauses | `paused` | Revoke execution grants and active leases; preserve phase/artifacts |
| `paused` | Operator resumes | `active` | Revalidate candidate, evidence and intent; issue new lease/grants |
| `active` | Missing operator decision and no independent ready lane | `parked` | Park dependent stories; keep task `active` instead when another ready story can progress |
| `parked` | Decision recorded | `active` | Create a new spec/plan generation when the decision changes either |
| `active` | External condition prevents all meaningful progress | `blocked` | Resume only after a changed external receipt or operator input |
| `blocked` | Blocking condition changes | `active` | Re-run the gate that originally failed |
| `active` | Operator cancels and containment completes | `cancelled` | Terminal; restart requires a new task ID |
| `active` | Completion eligibility passes | `complete` | Terminal; later work is a new task |
| `active` | Operator accepts rollback as final outcome | `rolled-back` | Terminal with rollback and remaining-impact receipts |

Phase transitions:

| From | Success | Blocking/failure path |
|---|---|---|
| `intake` | `clarify` or `spec-draft` when ambiguity is already low | stay `intake` on ambiguous/missing task binding |
| `clarify` | `spec-draft` | remain `clarify`; park on required operator decision |
| `spec-draft` | `spec-review` | remain `spec-draft` until observable/owned |
| `spec-review` | `plan-draft` | blockers create a new `spec-draft` generation |
| `plan-draft` | `plan-review` | remain `plan-draft` until all spec items map to proof |
| `plan-review` | `implement` | blockers create a new `plan-draft` generation |
| `implement` | `code-review` after all required stories integrate | failed story returns to RED; changed architecture may reopen plan/spec |
| `code-review` | `local-uat` | blockers create a bounded fix story set and return to `implement` |
| `local-uat` | `release-ready` or `close` at local boundary | defect creates a regression story and returns to `implement` |
| `release-ready` | `release` with exact candidate grant | candidate change invalidates readiness and returns to affected gate |
| `release` | `production-uat` or `close` at deploy boundary | known failure returns to `release-ready`; unknown outcome stays for reconciliation; containment may return to `implement` |
| `production-uat` | `observe` | failure triggers containment/rollback and a new RED cycle |
| `observe` | `close` | blocking signal triggers containment and the owning earlier phase |
| `close` | task status `complete` | missing/stale receipt returns to the phase that owns it |

`resumeTask` accepts only `paused`, `parked` or `blocked` with their recovery precondition satisfied. `cancelled`, `complete` and `rolled-back` never resume under the same task ID.

## Phase Gates And Artifacts

| Phase | Required work | Gate | Durable artifact |
|---|---|---|---|
| Intake | Resolve/bind task, discover real project, identify delivery boundary | One task matches the request; authority is known | Task record + context snapshot |
| Clarify | Deep interview only unresolved intent, scope, non-goals or decisions | Ambiguity below configured threshold; decision boundaries explicit | Interview record + decisions |
| Spec draft | Define behavior, truth, authority, lifecycle, failure states and DoD | Every requirement is observable and owned | Versioned specification |
| Spec review | Self-check, then bounded independent lenses | No accepted blocking spec finding | Review reports + frozen spec receipt |
| Plan draft | Stories, dependencies, parallel lanes, RED/GREEN/ATDD, rollout/rollback | Every spec item maps to work and proof | Plan + machine story graph |
| Plan review | Self-check, then bounded independent challenge | No accepted blocking plan finding | Review reports + frozen plan receipt |
| Implement | ATDD outside, TDD inside, vertical stories, fresh story gates | Every required story passes on current content | Story receipts + progress ledger |
| Code review | Self-review, then bounded independent spec/quality/security lenses | No accepted blocking code finding | Review reports + fix-train ledger |
| Local UAT | Run real local browser/API/CLI/session flows and recovery states | Locked local acceptance passes on current content | Local UAT receipt |
| Release ready | Sync target branch, full gates, docs/migrations, containment | Exact candidate and rollback/containment are recorded | Release candidate receipt |
| Release | Commit/push/merge/deploy through project path | Provider and remote readback identify exact candidate | Release/deploy receipt |
| Production UAT | Authenticated real flow on exact deployed revision | Production acceptance passes | Production UAT receipt |
| Observe | Logs, errors, telemetry and canary window | No blocking regression or active containment | Observation receipt |
| Close | Reconcile DoD, artifacts, receipts, follow-ups and owner | Completion query returns eligible | Final delivery report |

## Clarification Rules

Deep interview is conditional. It runs when material ambiguity remains after discovery.

- Discoverable codebase facts are researched, not asked.
- One high-leverage question is asked per round.
- Intent and boundaries precede implementation detail.
- Non-goals and decision boundaries are mandatory.
- At least one prior answer receives an evidence, assumption or tradeoff challenge.
- A clear mechanical task may skip the phase with a recorded reason.

## Specification Contract

An execution-ready specification contains:

- user-visible or caller-visible behavior;
- scope, non-goals and delivery boundary;
- Definition of Done;
- source of truth and authority;
- lifecycle, transitions and invariants;
- commands, queries and entrypoints;
- stale, missing, contradictory, low-confidence and degraded behavior;
- reconciliation and recovery;
- security, data and external-effect constraints;
- local UAT and production evidence requirements;
- rollout, containment and rollback boundaries.

Bug specifications include a reproducible baseline. Feature specifications include observable acceptance.

## Review Contract

Each review stage starts with author self-check, followed by a capped independent round with distinct lenses. Review counts are part of the task lock.

- Spec: product completeness, architecture/data, security/external effects, testability/operations.
- Plan: spec coverage, dependency graph, parallelism, proof quality, release safety.
- Code: spec conformance, correctness, maintainability, security/reliability.

Findings are `blocking`, `deferred` or `approved-expansion`. Reviewers do not vote. Conflicts are resolved against source evidence and operator decisions. Fixes do not automatically open another full review round; the lock decides the targeted recheck.

Thermo-nuclear/iron-close review is required only when the selected task mode says Ralph/full train.

## Planning Contract

The plan is an executable dependency graph, not prose chronology.

Every story defines:

- owned behavior and files/seams;
- prerequisites and downstream dependents;
- safe parallelization boundary;
- RED proof;
- GREEN condition;
- ATDD or UAT step for user-visible behavior;
- project gates;
- artifact and evidence outputs;
- rollback or recovery when relevant.

Independent stories start concurrently. Shared mutable state has one writer or an explicit integration story.

## Implementation Contract

The outer loop is ATDD; the inner loop is TDD.

```text
acceptance goes red
  → owner-boundary test goes red
  → minimal coherent implementation
  → tests go green
  → refactor with behavior locked
  → fresh story gates
  → story receipt
```

Tests must fail for the actual missing behavior. A mock cannot perform the rule it is supposed to verify. A test-only export is rejected when production callers do not use that seam.

Three failed fixes for the same root cause force a model/architecture reassessment before another edit.

## Local UAT Contract

Local UAT is distinct from automated tests. It uses the closest safe version of the real path:

- real browser and interaction flow;
- real CLI command and filesystem result;
- real API handler and persistence boundary;
- real session/reconnect behavior;
- required roles and permissions;
- provider sandbox or an explicitly limited substitute;
- error, empty, stale and recovery states.

An unavailable real path is recorded as a missing receipt. It is never converted into a pass.

A UAT defect returns to a failing regression, fix, affected gates and the same UAT. A material risk change receives a targeted re-review within the cap.

## Release And Production Contract

Before release, the exact candidate is synchronized with the target branch and passes the complete project gate. Migration collisions, contracts, docs, release notes and rollback/containment are checked.

External actions follow project-specific commands and approvals. An unknown result is reconciled before retry to prevent duplicate sends, writes, charges, releases or deploys.

Production verification requires:

- exact deployed revision or immutable artifact readback;
- authenticated production acceptance;
- relevant logs/errors/telemetry;
- canary or observation window when the risk demands it;
- external-effect receipt/readback when the task produced one.

## Commands

Every mutation carries:

```text
MutationContext
  leaseId
  fenceToken
  leaseScope
  expectedRecordVersion
  specGeneration
  planGeneration
```

- `startTask(request, requestedBoundary?) -> taskId`
- `acquireLease(taskId, scope, owner, expectedFence) -> WriterLease`
- `renewLease(context, renewUntil) -> WriterLease`
- `releaseLease(context, reason) -> state`
- `recordDiscovery(context, snapshot) -> artifactRef`
- `recordDecision(context, decision) -> decisionId`
- `freezeSpec(context, specRef, reviewRefs) -> generation`
- `freezePlan(context, planRef, storyGraph, reviewRefs) -> generation`
- `advancePhase(context, targetPhase, gateRefs) -> state`
- `claimStory(context, storyId, worker, worktree) -> storyLease`
- `submitStoryResult(storyContext, resultArtifacts) -> immutableResult`
- `recordStoryReceipt(context, storyId, candidateIdentity, receipt) -> state`
- `recordReview(context, phase, candidateIdentity, report) -> findingSet`
- `recordUat(context, environment, candidateIdentity, receipt) -> state`
- `recordAuthorizationIntent(context, boundary, constraints) -> intent`
- `grantBoundary(context, intentId, candidateIdentity, target, expiresAt, maxUses) -> ExecutionGrant`
- `revokeGrant(context, grantId, reason) -> state`
- `recordExternalAttempt(context, grantId, idempotencyKey, intent) -> attempt`
- `reconcileExternalAttempt(context, attemptId, receipt) -> state`
- `checkpoint(context, host, session, candidateIdentity) -> checkpointRef`
- `prepareHandoff(context, to, candidateIdentity) -> handoffRef`
- `acceptHandoff(handoffRef, receiver, expectedFence) -> WriterLease`
- `scheduleContinuation(context, notBefore, reason) -> wakeRef`
- `pauseTask(context, reason) -> state`
- `resumeTask(taskId, session, expectedRecordVersion) -> state`
- `cancelTask(context, containment) -> state`
- `completeTask(context, candidateIdentity) -> finalReceipt`

Commands fail on a stale generation, record version, candidate identity, lease or fence token.

## Queries

- `resolveCurrentTask(session, workspace) -> exact | candidate | ambiguous | missing`
- `getStatus(taskId) -> progress map + last trace + remaining + next owner`
- `getPendingDecisions(taskId) -> decisions[]`
- `getReadyStories(taskId) -> stories[]`
- `getActiveOwners(taskId) -> leases[]`
- `getEvidence(taskId, claim?) -> receipts[]`
- `getDeliveryState(taskId) -> local/commit/push/deploy/production facts`
- `canAdvance(taskId, targetPhase) -> verdict`
- `canComplete(taskId) -> verdict`

## Artifact Contracts

Every artifact has task ID, type, generation, content hash, producer, created time and source inputs. Evidence-bearing artifacts also carry the exact candidate identity and environment identity defined above.

Required types:

- context snapshot;
- interview/decision record;
- specification;
- review report and finding set;
- plan and machine story graph;
- progress ledger;
- test/gate receipt;
- local UAT receipt;
- checkpoint and handoff;
- release/deploy receipt;
- production UAT and observation receipt;
- final delivery report.

Artifacts are append-only or versioned. Canonical pointers advance atomically. Reviewer reports and worker summaries are untrusted until decisive claims are verified.

## Handoff And Compaction

Before compaction or host handoff, the current writer records:

- task/generation;
- current phase and story claims;
- last completed step and receipts;
- pending decisions and blockers;
- dirty worktree fingerprint;
- next safe action.

The receiver verifies the generation, workspace, task ID and artifact hashes before accepting ownership. A prepared handoff is not acceptance. Interruption after receiver binding remains recoverable and idempotent.

## External-Effect Safety

- Every external attempt has an idempotency key or provider identity.
- Intent is persisted before execution.
- Result is persisted before follow-up work.
- Unknown outcomes enter reconciliation, never blind retry.
- Duplicate external action is a blocker.
- Credentials come from approved host/provider mechanisms and never from chat text.

## Degraded States And Recovery

| Condition | Behavior |
|---|---|
| No exact task binding | Return candidate/ambiguous/missing; do not resume by guess |
| Missing discoverable fact | Research it; do not ask the operator first |
| Missing product decision | Park the dependent lane; continue independent lanes |
| Reviewer unavailable | Record missing independent coverage; follow task mode rules |
| Browser/provider unavailable | Keep automated evidence, mark real-path receipt missing |
| Compaction or process crash | Resume from checkpoint and canonical generation |
| Stale writer or conflicting lease | Reject mutation; reconcile ownership |
| Dirty or changed tree after evidence | Mark affected receipts stale |
| Plan diverges from reality | Record decision, revise spec/plan generation, re-gate affected work |
| External result unknown | Reconcile provider state before retry |
| Production regression | Contain or roll back, open new red cycle, preserve receipts |
| Three failed fixes, same cause | Stop editing and reassess the model/architecture |

## Status Projection

At any point `дай статус` returns:

- goal and requested delivery boundary;
- phase map and active parallel lanes;
- last step: plan, expected result, actual result, decision, next step;
- completed/remaining denominator;
- current receipts and stale/missing evidence;
- pending operator decisions;
- loop warning;
- next owner and action.

Status is a query over durable state, not a reconstruction from chat memory.

## Completion Eligibility

`completeTask` succeeds only when:

- the current spec and plan generations are frozen and fully covered;
- the supplied final candidate identity matches the current content fingerprint and every required receipt subject;
- all required stories have current passing receipts;
- no blocking review finding remains;
- local UAT is current;
- the requested delivery boundary is reached;
- production UAT and observation are current when production is required;
- external attempts are reconciled;
- no unexpired execution grant or active worker lease can still mutate the candidate;
- required docs/issues/release records are updated;
- remaining limits and follow-ups have owners;
- the final report cites durable artifacts and receipts.

The final status distinguishes implementation, local verification, commit, push, deploy and production verification.

## Platform Dependencies

- atomic filesystem or transactional store;
- Git and worktree adapter;
- supported agent-host session and lifecycle adapter;
- model/role dispatcher;
- test/build command runner;
- browser/API/CLI/session verification adapters;
- issue tracker adapter when configured;
- CI/repository/deployment provider adapters;
- telemetry/log query adapters;
- secret manager and permission system.

## Required Tests

### Core

- every valid and invalid phase transition;
- every valid and invalid task-status transition, including terminal-state resume denial;
- generation, record-version and stale-writer rejection;
- lease expiry, renewal, revocation and monotonically fenced ownership transfer;
- single integration writer plus parallel story-scoped claims;
- full-candidate and scoped evidence invalidation after content changes;
- final candidate mismatch against test, UAT, release and production receipts;
- review cap and finding classification;
- completion eligibility for every delivery boundary;
- execution-grant expiry/revocation on pause, cancel, rollback, target, generation and candidate changes;
- unknown external outcome reconciliation;
- pause/cancel/rollback containment.

### Continuity

- checkpoint before compaction and exact resume;
- interrupted handoff before/after receiver binding;
- Codex ↔ Claude handoff with different chat and execution workspaces;
- crash recovery with dirty worktree fingerprint;
- ambiguous workspace with multiple tasks.

### End To End

- natural-language clear task skips interview and completes a local train;
- ambiguous task runs interview and freezes a reviewed spec;
- independent stories run concurrently and integrate once;
- failing code review creates a bounded fix train;
- local tests green while UAT fails, then regression/fix/UAT succeeds;
- push without deploy remains unshipped;
- deploy of wrong revision blocks production verification;
- exact deployed revision plus authenticated UAT and observation closes production task.

### Host UAT

- clean install and natural task in Codex;
- clean install and natural task in Claude Code;
- compaction continuation on both hosts;
- status query from a fresh chat;
- cancellation and later resume;
- operator `кати` continuing the already locked train.

## Known Risks

- Hosts expose different hook, session, tool and permission semantics.
- File-backed coordination is not hostile-process isolation.
- Model reviewers can agree on the same wrong claim; source verification remains required.
- Provider APIs can report success before behavior is available.
- Production UAT may require operator-only credentials or actions.
- A universal workflow can become ceremony for small tasks; task mode and conditional phases must stay explicit.

## Non-Goals

- Guarantee model correctness.
- Replace project-specific architecture, test or release rules.
- Require deep interview or multi-agent review for a clear one-step task.
- Force production delivery when it was not requested.
- Treat reviewer consensus as proof.
- Store private chain-of-thought.
- Provide a hosted fleet, issue tracker, browser engine or deployment platform.
- Recreate FanEmpire-specific paths, providers or release contours in the public core.
