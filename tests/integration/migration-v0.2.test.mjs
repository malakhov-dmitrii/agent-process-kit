import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, lstatSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyMigration, dryRunMigration, rollbackMigration } from '../../runtime/adapters/migrate-v0.2.mjs';
import { releaseLease } from '../../runtime/core/leases.mjs';
import { compareAndSwapTask, readTask } from '../../runtime/core/store.mjs';
import { resolveCurrentTask } from '../../runtime/adapters/sessions.mjs';

function fixture({ receiver = false, prepared = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'apk-cp013-'));
  const sourceRoot = join(base, 'v02-state');
  const destinationRoot = join(base, 'v04-state');
  const repo = join(base, 'repo');
  const worktree = join(base, 'worktree');
  const journalPath = join(base, 'task.md');
  for (const path of [sourceRoot, repo, worktree]) mkdirSync(path, { recursive: true });
  cpSync(new URL('../fixtures/migration-v0.2-legacy', import.meta.url), sourceRoot, { recursive: true });
  mkdirSync(join(sourceRoot, 'handoffs'), { recursive: true });
  writeFileSync(join(sourceRoot, 'CURRENT'), 'task-1\n');
  writeFileSync(journalPath, '# Task\nTask-ID: task-1\n\n## Acceptance\n- [ ] migrate\n');
  const bindingPath = join(sourceRoot, 'sessions', 'session-1.json');
  writeFileSync(bindingPath, readFileSync(bindingPath, 'utf8').replaceAll('__REPO__', repo).replaceAll('__WORKTREE__', worktree).replaceAll('__JOURNAL__', journalPath));
  if (receiver) writeFileSync(join(sourceRoot, 'sessions', 'receiver.json'), JSON.stringify({
    version: 3, binding_kind: 'explicit', session_id: 'receiver', task_id: 'task-1',
    repo, worktree, journal_path: journalPath, owner_host: 'claude', bound_at: '2026-10-08T12:00:00.000Z', handoff_id: 'handoff-1', handoff_generation: 1,
  }));
  if (prepared || receiver) writeFileSync(join(sourceRoot, 'handoffs', 'handoff-1.json'), JSON.stringify({
    version: 1, handoff_id: 'handoff-1', generation: 1, status: receiver ? 'accepted' : 'prepared', task_id: 'task-1',
    journal_path: journalPath, repo, worktree, recipient_host: 'claude', recipient_session: receiver ? 'receiver' : 'receiver',
    accepted_session: receiver ? 'receiver' : undefined, prepared_at: '2026-10-08T12:00:00.000Z',
  }));
  return { base, sourceRoot, destinationRoot, repo, worktree, journalPath };
}

function snapshot(fx) {
  return dryRunMigration({ sourceRoot: fx.sourceRoot, taskId: 'task-1', sessionId: 'session-1', workspace: fx.repo });
}

test('dry-run imports one exact explicit binding and records source digest without journal text', () => {
  const fx = fixture();
  const result = snapshot(fx);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.taskId, 'task-1');
  assert.equal(result.snapshot.sessionId, 'session-1');
  assert.match(result.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('Acceptance'), false);
});

test('provisional, malformed, mismatched and duplicate bindings refuse dry-run', () => {
  const cases = [
    ['provisional', (fx) => writeFileSync(join(fx.sourceRoot, 'sessions', 'session-1.json'), JSON.stringify({ version: 1, binding_kind: 'candidate', task_id: 'task-1' }))],
    ['mismatched journal', (fx) => writeFileSync(fx.journalPath, 'Task-ID: other-task\n')],
    ['conflicting task', (fx) => writeFileSync(join(fx.sourceRoot, 'sessions', 'session-2.json'), JSON.stringify({ version: 3, binding_kind: 'explicit', session_id: 'session-2', task_id: 'other-task', repo: fx.repo, worktree: fx.worktree, journal_path: fx.journalPath }))],
    ['mismatched task', (fx) => writeFileSync(join(fx.sourceRoot, 'sessions', 'session-1.json'), JSON.stringify({ version: 3, binding_kind: 'explicit', session_id: 'session-1', task_id: 'other-task', repo: fx.repo, worktree: fx.worktree, journal_path: fx.journalPath }))],
  ];
  for (const [label, mutate] of cases) {
    const fx = fixture();
    mutate(fx);
    assert.throws(() => snapshot(fx), /explicit|invalid|multiple|match|Expected one|Task-ID/i, label);
  }
});

test('multiple explicit bindings for one task are accepted only when identities agree, and accepted handoff receiver becomes owner', () => {
  const fx = fixture({ receiver: true });
  const plan = dryRunMigration({ sourceRoot: fx.sourceRoot, taskId: 'task-1', sessionId: 'receiver', workspace: fx.worktree });
  assert.equal(plan.snapshot.sessionId, 'receiver');
  const receipt = applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerHost: 'claude', ownerSession: 'receiver', now: '2026-10-08T12:01:00.000Z' });
  assert.equal(receipt.sessionId, 'receiver');
  assert.equal(readTask({ root: fx.destinationRoot, taskId: 'task-1' }).leases[0].ownerSession, 'receiver');
  assert.equal(receipt.importedHandoffHashes.length, 1);
});

test('prepared root-level handoff is imported with its ID and status', () => {
  const fx = fixture({ prepared: true });
  const plan = snapshot(fx);
  assert.equal(plan.snapshot.handoffs[0].handoff_id, 'handoff-1');
  const receipt = applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerSession: 'session-1', now: '2026-10-08T12:01:00.000Z' });
  assert.equal(receipt.importedHandoffHashes.length, 1);
  assert.equal(receipt.importedHandoffHashes[0].handoffId, 'handoff-1');
});

test('live or malformed legacy lock blocks activation', () => {
  const fx = fixture();
  writeFileSync(join(fx.sourceRoot, 'sessions', 'session-1.json.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => snapshot(fx), /lock/i);
});

test('apply atomically quarantines v0.2, tombstones old root, imports exact task and acquires fence', () => {
  const fx = fixture();
  const plan = snapshot(fx);
  const receipt = applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerHost: 'codex', ownerSession: 'session-1', now: '2026-10-08T12:01:00.000Z' });
  assert.equal(receipt.phase, 'installed');
  assert.equal(lstatSync(fx.sourceRoot).isFile(), true);
  assert.equal(existsSync(receipt.quarantineRoot), true);
  assert.equal(readFileSync(join(receipt.quarantineRoot, 'CURRENT'), 'utf8'), 'task-1\n');
  assert.equal(readTask({ root: fx.destinationRoot, taskId: 'task-1' }).leases[0].fenceToken, 1);
  assert.equal(resolveCurrentTask({ root: fx.destinationRoot, sessionId: 'session-1', workspace: fx.worktree }).status, 'exact');
  assert.throws(() => mkdirSync(fx.sourceRoot), /EEXIST|not a directory/i);
});

test('caller snapshot digest, source mutation and concurrent legacy writer refuse activation', () => {
  const fx = fixture();
  const plan = snapshot(fx);
  writeFileSync(join(fx.sourceRoot, 'CURRENT'), 'changed\n');
  assert.throws(() => applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerSession: 'session-1' }), /changed|fingerprint|source/i);
  const fx2 = fixture();
  const plan2 = snapshot(fx2);
  writeFileSync(join(fx2.sourceRoot, 'writer.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => applyMigration({ sourceRoot: fx2.sourceRoot, destinationRoot: fx2.destinationRoot, snapshot: plan2.snapshot, snapshotDigest: plan2.snapshotDigest, ownerSession: 'session-1' }), /source|fingerprint|lock/i);
});

test('partial cutover resumes idempotently and rollback refuses post-import mutation', () => {
  const fx = fixture();
  const plan = snapshot(fx);
  const quarantine = `${fx.sourceRoot}.quarantine-task-1`;
  // Simulate the crash window after rename+tombstone and before the receipt.
  renameSync(fx.sourceRoot, quarantine);
  chmodSync(quarantine, 0o555);
  writeFileSync(fx.sourceRoot, `${JSON.stringify({ version: 1, kind: 'agent-process-kit-v0.2-tombstone', taskId: 'task-1', snapshotDigest: plan.snapshotDigest })}\n`);
  const receipt = applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerSession: 'session-1', now: '2026-10-08T12:01:00.000Z' });
  assert.equal(receipt.phase, 'installed');
  const record = readTask({ root: fx.destinationRoot, taskId: 'task-1' });
  compareAndSwapTask({ root: fx.destinationRoot, taskId: 'task-1', expectedRecordVersion: record.recordVersion, now: '2026-10-08T12:01:30.000Z', mutate: (current) => ({ ...current, request: 'mutated after import' }) });
  const mutated = readTask({ root: fx.destinationRoot, taskId: 'task-1' });
  assert.throws(() => rollbackMigration({ receiptPath: join(fx.destinationRoot, 'migrations', 'task-1.json'), context: { leaseId: mutated.leases[0].leaseId, fenceToken: mutated.leases[0].fenceToken, leaseScope: 'canonical', expectedRecordVersion: mutated.recordVersion, specGeneration: 0, planGeneration: 0 }, now: '2026-10-08T12:02:00.000Z' }), /post-migration|mutat/i);
});

test('interrupted quarantine without an owned tombstone blocks before task, lease, or binding activation', () => {
  const fx = fixture();
  const plan = snapshot(fx);
  renameSync(fx.sourceRoot, `${fx.sourceRoot}.quarantine-task-1`);
  chmodSync(`${fx.sourceRoot}.quarantine-task-1`, 0o555);
  assert.throws(() => applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerSession: 'session-1' }), /tombstone.*missing/i);
  const receipt = JSON.parse(readFileSync(join(fx.destinationRoot, 'migrations', 'task-1.json'), 'utf8'));
  assert.equal(receipt.phase, 'blocked');
  assert.equal(existsSync(join(fx.destinationRoot, 'tasks', 'task-1', 'task.json')), false);
  assert.equal(existsSync(join(fx.destinationRoot, 'sessions', 'session-1.json')), false);
});

test('foreign tombstone replacement survives and blocks activation', () => {
  const fx = fixture();
  const plan = snapshot(fx);
  renameSync(fx.sourceRoot, `${fx.sourceRoot}.quarantine-task-1`);
  chmodSync(`${fx.sourceRoot}.quarantine-task-1`, 0o555);
  writeFileSync(fx.sourceRoot, 'foreign\n');
  assert.throws(() => applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerSession: 'session-1' }), /tombstone.*bytes|foreign/i);
  assert.equal(readFileSync(fx.sourceRoot, 'utf8'), 'foreign\n');
  assert.equal(existsSync(join(fx.destinationRoot, 'tasks', 'task-1', 'task.json')), false);
});

test('prepared receipt is written before cutover and resumes after a crash window', () => {
  const fx = fixture();
  const plan = snapshot(fx);
  const receiptPath = join(fx.destinationRoot, 'migrations', 'task-1.json');
  mkdirSync(join(fx.destinationRoot, 'migrations'), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify({ version: 1, kind: 'v0.2-migration', phase: 'prepared', taskId: 'task-1', sessionId: 'session-1', sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, quarantineRoot: `${fx.sourceRoot}.quarantine-task-1`, tombstonePath: fx.sourceRoot, sourceFingerprint: plan.sourceFingerprint, snapshotDigest: plan.snapshotDigest }));
  const receipt = applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerSession: 'session-1', now: '2026-10-08T12:01:00.000Z' });
  assert.equal(receipt.phase, 'installed');
});

test('unrelated destination task or session collision refuses before cutover', () => {
  const fx = fixture();
  const plan = snapshot(fx);
  mkdirSync(join(fx.destinationRoot, 'tasks', 'task-1'), { recursive: true });
  writeFileSync(join(fx.destinationRoot, 'tasks', 'task-1', 'task.json'), JSON.stringify({ foreign: true }));
  assert.throws(() => applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerSession: 'session-1' }), /destination|foreign|corrupt|invalid/i);
});

test('eligible rollback revokes imported ownership before restoring unchanged quarantine and preserves receipt', () => {
  const fx = fixture();
  const plan = snapshot(fx);
  const receipt = applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerSession: 'session-1', now: '2026-10-08T12:01:00.000Z' });
  const record = readTask({ root: fx.destinationRoot, taskId: 'task-1' });
  const restored = rollbackMigration({ receiptPath: join(fx.destinationRoot, 'migrations', 'task-1.json'), context: { leaseId: record.leases[0].leaseId, fenceToken: record.leases[0].fenceToken, leaseScope: 'canonical', expectedRecordVersion: record.recordVersion, specGeneration: 0, planGeneration: 0 }, now: '2026-10-08T12:02:00.000Z' });
  assert.equal(restored.phase, 'rolled-back');
  assert.equal(lstatSync(fx.sourceRoot).isDirectory(), true);
  assert.equal(existsSync(join(fx.destinationRoot, 'tasks', 'task-1')), false);
  assert.equal(existsSync(join(fx.destinationRoot, 'migrations', 'task-1.json')), true);
  assert.equal(statSync(fx.sourceRoot).mode & 0o222, 0o200);
  assert.equal(statSync(join(fx.sourceRoot, 'sessions', 'session-1.json')).mode & 0o222, 0o200);
});

test('rollback resumes after the ownership-revoked boundary without rejecting its own revocation', () => {
  const fx = fixture();
  const plan = snapshot(fx);
  applyMigration({ sourceRoot: fx.sourceRoot, destinationRoot: fx.destinationRoot, snapshot: plan.snapshot, snapshotDigest: plan.snapshotDigest, ownerSession: 'session-1', now: '2026-10-08T12:01:00.000Z' });
  const receiptPath = join(fx.destinationRoot, 'migrations', 'task-1.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const record = readTask({ root: fx.destinationRoot, taskId: 'task-1' });
  const context = { leaseId: record.leases[0].leaseId, fenceToken: record.leases[0].fenceToken, leaseScope: 'canonical', expectedRecordVersion: record.recordVersion, specGeneration: 0, planGeneration: 0 };
  const revoked = releaseLease({ root: fx.destinationRoot, taskId: 'task-1', context, reason: 'migration-rollback', now: '2026-10-08T12:02:00.000Z' }).record;
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, phase: 'ownership-revoked', rollbackPhase: 'ownership-revoked', rollbackLeaseRecordVersion: revoked.recordVersion, tombstoneVerifiedHash: receipt.tombstoneHash }));
  const completed = rollbackMigration({ receiptPath, now: '2026-10-08T12:03:00.000Z' });
  assert.equal(completed.phase, 'rolled-back');
  assert.equal(completed.rollbackPhase, 'restored');
  assert.equal(lstatSync(fx.sourceRoot).isDirectory(), true);
});
