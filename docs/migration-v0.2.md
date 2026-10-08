# Migrating the optional v0.2 runtime

The v0.2 runtime stores authority under a state root containing explicit session
bindings and root-level `handoffs/*.json` records. v0.4 imports one quiescent task into the canonical task
store. The journal remains a human projection; its only migration identity is a
single unfenced `Task-ID:` line.

The adapter is `runtime/adapters/migrate-v0.2.mjs`:

```js
const plan = dryRunMigration({ sourceRoot: oldStateRoot, taskId: 'task-1', sessionId: 'session-1', workspace: repo });
const receipt = applyMigration({ sourceRoot: oldStateRoot, destinationRoot: newStateRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerHost: 'codex', ownerSession: 'session-1' });
```

Dry-run refuses provisional or malformed bindings, duplicate task identities,
journal mismatches, workspace mismatches, inconsistent prepared or accepted
handoffs, symlinks, and any legacy lock. Multiple explicit sessions for one
task are allowed when their repo, worktree and journal identities agree. An
accepted handoff selects its matching receiver as the imported owner. It returns the exact source file list,
source fingerprint and a digest of the complete dry-run snapshot. Apply accepts
that digest from the caller and rechecks the source before changing state.

The adapter first writes a `prepared` receipt containing the source and
destination intent. Cutover then renames the old root to a read-only quarantine, verifies its byte
fingerprint, and creates a regular tombstone at the former path. A resumed
cutover with an existing quarantine must prove the exact deterministic
tombstone bytes; a missing or foreign replacement writes a `blocked` receipt
and cannot activate any v0.4 task, lease or binding. Legacy code cannot
recreate the old directory or write into it. The apply receipt persists
`quarantined`, `lease-acquired`, `binding-created` and `installed` phases, so
each activation boundary can resume idempotently. Only after this sequence
does the adapter create the v0.4 task, bind the imported session and acquire
the first canonical lease. The receipt is stored under
`<destination>/migrations/<task-id>.json` and records source, quarantine,
tombstone, destination, snapshot, imported session and lease digests.

If a process stops after the receipt or rename, rerunning with the same snapshot
resumes from the recorded phase. A quarantine fingerprint mismatch records a
blocked receipt before failing. A completed migration is idempotent when its receipt and
snapshot digest match. Rollback requires the exact imported lease context, no
post-import record, session or handoff mutation, grant or external attempt, and
no foreign edits. It persists `rollbackPhase` values `prepared`,
`ownership-revoked`, `removing` and `restored`. It first revokes the imported
lease so the v0.4 owner is unusable, removes the imported task and binding,
then validates the exact tombstone bytes before deleting it and restores the
unchanged quarantine. A resumed rollback accepts the durable
`ownership-revoked`, `removing` or `restored` phase without replaying the
revocation. A foreign tombstone replacement always survives and refuses
rollback. It never starts a host and preserves the migration receipt in its
`rolled-back` phase.
