---
name: orchestrate-task
description: Use when an ordinary coding request, continuation, status check, release intent, pause or stop should run through the durable task control plane without requiring the operator to name a skill. Recognize English and Russian verbs such as ship, кати, +, продолжай, дай статус, pause and stop.
---

# Orchestrate task

Treat a normal task message as a control-plane command. Resolve the exact task binding, read the canonical record and continue from its recorded phase. Keep the task record, versioned artifacts and evidence receipts as the source of truth.

1. Classify the message. Route `дай статус` to the status query, `+` or `продолжай` to the next authorized phase, `кати` or `ship` to the locked release boundary, and `pause` or `stop` to pause/cancel handling. A new natural-language request starts intake without requiring a skill name. Finish this step when the command and task binding are explicit.

2. Select the smallest safe mode from ambiguity and risk. Use `quick` for one-step mechanical work, `standard` for ordinary non-trivial work, and `full-train` for multi-story, Ralph, auth, data, security or production-risk work. Record the selection and every skipped ceremony with a reason. Finish this step when the mode decision is durable.

3. Keep material ambiguity in `clarify`. Ask one high-leverage question at a time, record the operator decision and only then draft the specification. Clear work may move directly to specification when its skip reason is recorded. Finish this step when pending decisions are empty or the task is parked.

4. Draft an observable specification and an executable plan. The specification names authority, lifecycle, failure and recovery behavior, non-goals, Definition of Done and local/release proof. The plan maps every requirement to a story and proof, with dependencies, ownership, RED/GREEN, ATDD/UAT, gates and recovery. Finish each draft only when every requirement has an owner and proof.

5. Run the phase self-check, then one bounded independent review for each required spec, plan and code stage. Store reviewer output as an immutable report artifact. Classify every finding as `blocking`, `deferred` or `approved-expansion`; only blocking findings and accepted expansions enter the fix train. The review cap stays at one independent round. Finish the review when its receipt is candidate and generation bound.

6. Freeze the reviewed specification and plan into generation-bound artifacts. Use the existing story and lease APIs for parallel work, and let only the integration writer advance canonical pointers. Finish the step when the story graph is frozen and its ready lanes are visible.

7. Continue through implementation, code review, real local UAT and the requested delivery boundary. Keep tests, commit, push, deploy and production proof as separate receipts. Production proof includes the exact deployed revision, authenticated UAT and the required observation. A missing reviewer or real path remains missing coverage. Finish with one delivery receipt that names the exact proven boundary and remaining proof.

Internal methods such as `depth-lock`, `codebase-design`, `capability-contract`, `capability-core-adapters`, `writing-for-agents` and `verify-delivery` are selected inside the phase when their branch applies. The operator only needs this natural task path.
