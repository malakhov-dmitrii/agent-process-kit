# Workflow and evidence

## Establish the task

Read the request, project instructions and relevant code. Match the actual task before binding. Old plans and summaries are context, not current completion evidence.

Create a journal with `init` or the [template](../harness/docs/templates/task-journal.md). Record goal, delivery boundary, scope, non-goals, owner, blockers and review cap. Agree on user-visible acceptance before implementation. Ask about material product, architecture, permission or scope choices; perform routine reversible work autonomously.

For disputed UX, show a concrete screen or small prototype before broad implementation. Established patterns do not require a new design ceremony.

## Implement and verify

Reproduce a bug before fixing it. Define observable feature behavior before implementation. Test returned/persisted results at their owning boundary; avoid tests that repeat the algorithm.

Keep product rules under one owner and adapters thin. A file-size limit is a signal to inspect responsibilities. Apply [Capability Core + Adapters](../skills/capability-core-adapters/SKILL.md) one capability at a time.

Run relevant tests, type/syntax checks, build and the real user path. Distinguish real, sandboxed and mocked integrations. Update affected documentation or record why it remains accurate; check parent links when modules move.

## Review within scope

Give an independent reviewer the request, acceptance, scope, code and evidence. Findings need a concrete failure scenario and source location. Separate blockers from follow-ups.

Default to at most two plan and two code rounds. Later rounds focus on blockers and their fixes. Remaining blockers must be fixed and checked, not hidden by the cap. Imported skills cannot expand scope or authorize external actions.

## Record acceptance

One journal has one unfenced `Task-ID: ID` and one non-empty `## Acceptance` section. Each criterion is a single identified line:

```text
- [ ] A1: Required behavior still to verify
- [x] A2: Verified behavior | Evidence: result, artifact and revision
- [-] A3: Removed from scope | Decision: operator decision reference
```

Put substeps in other sections. Missing, malformed, duplicate or pending criteria and checked items without an evidence field are rejected. Exclusions must refer to actual human decisions.

`ready` is structural checklist readiness. Inspect actual results and match them to the final changed state before claiming success. For overall completion, use `Task complete: ID` on its own line. Compatible Stop adapters check this against the exact session binding. Partial receipts omit the marker and state remaining work and its owner. Subagents cannot close the parent task.

## Transfer and close

Handoff prepares a canonical JSON record and a journal note. It does not launch/message another agent. The receiver checks the request and accepts with its own session ID.

Acceptance writes a receiver binding referencing the handoff generation, then commits the handoff record. Interruption between them leaves `handoff-pending`; retry the same acceptance. Integrations must honor pending status. See [recovery](architecture.md).

The kit is not a distributed execution lock. Coordinate shared files, migrations and production releases separately. Distinguish local verification, commit, push, deployment and authenticated production checks. A local-only task may finish at that agreed boundary; a requested deployment cannot finish at push.

Run `check` after final changes. Continue safe authorized work. If blocked, identify the missing input, responsible actor and next step. Keep unrelated improvements as follow-ups.
