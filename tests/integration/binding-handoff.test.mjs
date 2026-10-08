import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compareAndSwapTask, createTask, readTask } from '../../runtime/core/store.mjs';
import { acquireLease } from '../../runtime/core/leases.mjs';
import { bindSession, resolveCurrentTask } from '../../runtime/adapters/sessions.mjs';
import { acceptHandoff, prepareHandoff } from '../../runtime/adapters/handoff.mjs';

const NOW = '2026-10-08T12:00:00.000Z';
const RENEW = '2026-10-08T12:01:00.000Z';
const EXPIRE = '2026-10-08T12:10:00.000Z';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'apk-cp008-'));
  const stateRoot = join(base, 'state');
  const repo = join(base, 'chat-repo');
  const worktree = join(base, 'execution-worktree');
  for (const dir of [repo, worktree]) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['-C', dir, 'init', '-q']);
    writeFileSync(join(dir, 'tracked.txt'), 'tracked\n');
    execFileSync('git', ['-C', dir, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'fixture']);
  }
  const journal = join(base, 'task.md');
  writeFileSync(journal, 'task\n');
  createTask({ root: stateRoot, input: { taskId: 'task-1', request: 'continue', mode: 'full-train', requestedBoundary: 'local', now: NOW } });
  return { base, stateRoot, repo, worktree, journal };
}

function lease(fx) {
  return acquireLease({ root: fx.stateRoot, taskId: 'task-1', scope: 'canonical', ownerHost: 'codex', ownerSession: 'sender', expectedRecordVersion: 0, expectedFence: 0, renewBefore: RENEW, expiresAt: EXPIRE, now: NOW, leaseId: 'sender-lease' });
}

test('exact session binding wins and repo/current/legacy hints remain candidate only', () => {
  const fx = fixture();
  mkdirSync(join(fx.repo, '.agent', 'tasks'), { recursive: true });
  writeFileSync(join(fx.repo, '.agent', 'CURRENT'), 'old-task\n');
  bindSession({ root: fx.stateRoot, sessionId: 'session-1', taskId: 'task-1', journalPath: fx.journal, repo: fx.repo, worktree: fx.worktree, ownerHost: 'codex' });
  assert.equal(resolveCurrentTask({ root: fx.stateRoot, sessionId: 'session-1', workspace: fx.repo }).status, 'exact');
  assert.equal(resolveCurrentTask({ root: fx.stateRoot, sessionId: 'fresh', workspace: fx.repo }).status, 'candidate');
});

test('mismatch and broken exact bindings fail closed', () => {
  const fx = fixture();
  bindSession({ root: fx.stateRoot, sessionId: 'session-1', taskId: 'task-1', journalPath: fx.journal, repo: join(fx.base, 'other'), worktree: fx.worktree, ownerHost: 'codex' });
  assert.equal(resolveCurrentTask({ root: fx.stateRoot, sessionId: 'session-1', workspace: fx.repo }).status, 'candidate');
  assert.equal(resolveCurrentTask({ root: fx.stateRoot, sessionId: 'session-1', workspace: fx.repo }).reasonCode, 'binding-mismatch');
  bindSession({ root: fx.stateRoot, sessionId: 'session-2', taskId: 'task-1', journalPath: join(fx.base, 'missing.md'), repo: fx.repo, worktree: fx.worktree, ownerHost: 'codex' });
  assert.equal(resolveCurrentTask({ root: fx.stateRoot, sessionId: 'session-2', workspace: fx.repo }).status, 'candidate');
  assert.equal(resolveCurrentTask({ root: fx.stateRoot, sessionId: 'session-2', workspace: fx.repo }).reasonCode, 'broken-binding');
});

test('binding written before CAS stays candidate until accepted lease exists', () => {
  const fx = fixture();
  const sender = lease(fx);
  const context = { leaseId: sender.lease.leaseId, fenceToken: sender.lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: sender.record.recordVersion, specGeneration: 0, planGeneration: 0 };
  const prepared = prepareHandoff({ root: fx.stateRoot, taskId: 'task-1', context, to: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, nextAction: 'resume', now: RENEW });
  bindSession({ root: fx.stateRoot, sessionId: 'receiver', taskId: 'task-1', repo: fx.repo, worktree: fx.worktree, ownerHost: 'claude', handoffId: prepared.handoffId, handoffGeneration: prepared.generation });
  const pending = resolveCurrentTask({ root: fx.stateRoot, sessionId: 'receiver', workspace: fx.worktree });
  assert.equal(pending.status, 'candidate');
  assert.equal(pending.reasonCode, 'pending-handoff');
  const accepted = acceptHandoff({ root: fx.stateRoot, handoffId: prepared.handoffId, receiver: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, now: RENEW, renewBefore: '2026-10-08T12:02:00.000Z', expiresAt: EXPIRE });
  assert.equal(resolveCurrentTask({ root: fx.stateRoot, sessionId: 'receiver', workspace: fx.worktree, now: RENEW }).status, 'exact');
  assert.equal(accepted.lease.ownerSession, 'receiver');
});

test('expired or revoked accepted receiver lease becomes a candidate and cannot be read back as current', () => {
  const fx = fixture();
  const sender = lease(fx);
  const context = { leaseId: sender.lease.leaseId, fenceToken: sender.lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: sender.record.recordVersion, specGeneration: 0, planGeneration: 0 };
  const prepared = prepareHandoff({ root: fx.stateRoot, taskId: 'task-1', context, to: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, nextAction: 'resume', now: RENEW });
  const accepted = acceptHandoff({ root: fx.stateRoot, handoffId: prepared.handoffId, receiver: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, now: RENEW, renewBefore: '2026-10-08T12:02:00.000Z', expiresAt: EXPIRE });
  const expired = resolveCurrentTask({ root: fx.stateRoot, sessionId: 'receiver', workspace: fx.worktree, now: '2026-10-08T12:11:00.000Z' });
  assert.equal(expired.status, 'candidate');
  assert.equal(expired.reasonCode, 'handoff-lease-expired');
  assert.throws(() => acceptHandoff({ root: fx.stateRoot, handoffId: prepared.handoffId, receiver: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, now: '2026-10-08T12:11:00.000Z' }), /expired|revoked|current/i);
  compareAndSwapTask({ root: fx.stateRoot, taskId: 'task-1', expectedRecordVersion: accepted.record.recordVersion, now: '2026-10-08T12:11:01.000Z', mutate: (record) => ({ ...record, leases: record.leases.map((lease) => lease.leaseId === accepted.lease.leaseId ? { ...lease, revokedAt: '2026-10-08T12:11:01.000Z' } : lease) }) });
  const revoked = resolveCurrentTask({ root: fx.stateRoot, sessionId: 'receiver', workspace: fx.worktree, now: '2026-10-08T12:05:00.000Z' });
  assert.equal(revoked.status, 'candidate');
  assert.equal(revoked.reasonCode, 'handoff-lease-revoked');
});

test('legacy global CURRENT text remains a candidate', () => {
  const fx = fixture();
  writeFileSync(join(fx.stateRoot, 'CURRENT'), 'legacy-task\n');
  const result = resolveCurrentTask({ root: fx.stateRoot, sessionId: 'fresh', workspace: join(fx.base, 'unrelated') });
  assert.equal(result.status, 'candidate');
  assert.equal(result.taskId, 'legacy-task');
});

test('binding publishes a safe workspace discovery candidate for a fresh session', () => {
  const fx = fixture();
  bindSession({ root: fx.stateRoot, sessionId: 'bound', taskId: 'task-1', journalPath: fx.journal, repo: fx.repo, worktree: fx.worktree, ownerHost: 'codex' });
  const fresh = resolveCurrentTask({ root: fx.stateRoot, sessionId: 'fresh', workspace: fx.repo });
  assert.equal(fresh.status, 'candidate');
  assert.equal(fresh.taskId, 'task-1');
  assert.match(fresh.source, /registry\.json$/);
});

test('host-only handoff is claimed by the first actual recipient session exactly once', () => {
  const fx = fixture();
  const sender = lease(fx);
  const prepared = prepareHandoff({ root: fx.stateRoot, taskId: 'task-1', context: { leaseId: sender.lease.leaseId, fenceToken: sender.lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: sender.record.recordVersion, specGeneration: 0, planGeneration: 0 }, to: 'claude', repo: fx.repo, worktree: fx.worktree, nextAction: 'resume', now: RENEW });
  const accepted = acceptHandoff({ root: fx.stateRoot, handoffId: prepared.handoffId, receiver: { host: 'claude', sessionId: 'actual-receiver' }, repo: fx.repo, worktree: fx.worktree, now: RENEW, renewBefore: '2026-10-08T12:02:00.000Z', expiresAt: EXPIRE });
  assert.equal(accepted.handoff.recipientSession, 'actual-receiver');
  assert.equal(resolveCurrentTask({ root: fx.stateRoot, sessionId: 'actual-receiver', workspace: fx.worktree, now: RENEW }).status, 'exact');
  assert.throws(() => acceptHandoff({ root: fx.stateRoot, handoffId: prepared.handoffId, receiver: { host: 'claude', sessionId: 'other-receiver' }, repo: fx.repo, worktree: fx.worktree, now: RENEW }), /receiver|claim|match/i);
});

test('prepared handoff does not change ownership; acceptance transfers with a higher fence and is idempotent', () => {
  const fx = fixture();
  const sender = lease(fx);
  const prepared = prepareHandoff({ root: fx.stateRoot, taskId: 'task-1', context: { leaseId: sender.lease.leaseId, fenceToken: sender.lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: sender.record.recordVersion, specGeneration: 0, planGeneration: 0 }, to: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, nextAction: 'resume', now: RENEW });
  assert.equal(readTask({ root: fx.stateRoot, taskId: 'task-1' }).leases.find((item) => item.leaseId === sender.lease.leaseId).revokedAt, null);
  const accepted = acceptHandoff({ root: fx.stateRoot, handoffId: prepared.handoffId, receiver: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, now: RENEW, renewBefore: '2026-10-08T12:02:00.000Z', expiresAt: EXPIRE });
  assert.equal(accepted.lease.fenceToken, 2);
  const retry = acceptHandoff({ root: fx.stateRoot, handoffId: prepared.handoffId, receiver: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, now: RENEW, renewBefore: '2026-10-08T12:02:00.000Z', expiresAt: EXPIRE });
  assert.equal(retry.lease.leaseId, accepted.lease.leaseId);
  assert.equal(readTask({ root: fx.stateRoot, taskId: 'task-1' }).leases.filter((item) => item.revokedAt === null).length, 1);
});

test('handoff retains relevant untracked fingerprint and rejects conflicting receiver', () => {
  const fx = fixture();
  writeFileSync(join(fx.worktree, 'relevant-untracked.txt'), 'keep\n');
  const sender = lease(fx);
  const context = { leaseId: sender.lease.leaseId, fenceToken: sender.lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: sender.record.recordVersion, specGeneration: 0, planGeneration: 0 };
  const prepared = prepareHandoff({ root: fx.stateRoot, taskId: 'task-1', context, to: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, nextAction: 'resume', now: RENEW });
  assert.throws(() => acceptHandoff({ root: fx.stateRoot, handoffId: prepared.handoffId, receiver: { host: 'claude', sessionId: 'other' }, repo: fx.repo, worktree: fx.worktree, now: RENEW, renewBefore: '2026-10-08T12:02:00.000Z', expiresAt: EXPIRE }));
  const result = acceptHandoff({ root: fx.stateRoot, handoffId: prepared.handoffId, receiver: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, now: RENEW, renewBefore: '2026-10-08T12:02:00.000Z', expiresAt: EXPIRE });
  assert.equal(result.handoff.candidateIdentity.contentManifest.some((item) => item.path === 'relevant-untracked.txt'), true);
});

test('handoff IDs cannot overwrite and ambiguous IDs require an explicit task', () => {
  const fx = fixture();
  const sender = lease(fx);
  const context = { leaseId: sender.lease.leaseId, fenceToken: sender.lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: sender.record.recordVersion, specGeneration: 0, planGeneration: 0 };
  prepareHandoff({ root: fx.stateRoot, taskId: 'task-1', context, to: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, nextAction: 'resume', handoffId: 'fixed-handoff', now: RENEW });
  assert.throws(() => prepareHandoff({ root: fx.stateRoot, taskId: 'task-1', context, to: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, nextAction: 'overwrite', handoffId: 'fixed-handoff', now: RENEW }), /already exists|overwrite/i);
  const second = fixture();
  const secondSender = lease(second);
  prepareHandoff({ root: second.stateRoot, taskId: 'task-1', context: { leaseId: secondSender.lease.leaseId, fenceToken: secondSender.lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: secondSender.record.recordVersion, specGeneration: 0, planGeneration: 0 }, to: { host: 'claude', sessionId: 'other' }, repo: second.repo, worktree: second.worktree, nextAction: 'resume', handoffId: 'fixed-handoff', now: RENEW });
  // Same state root is needed for ambiguous lookup; copy the second task under it.
  const secondTaskDir = join(fx.stateRoot, 'tasks', 'task-2');
  mkdirSync(secondTaskDir, { recursive: true });
  writeFileSync(join(secondTaskDir, 'task.json'), readFileSync(join(second.stateRoot, 'tasks', 'task-1', 'task.json')));
  mkdirSync(join(secondTaskDir, 'handoffs'), { recursive: true });
  writeFileSync(join(secondTaskDir, 'handoffs', 'fixed-handoff.json'), readFileSync(join(second.stateRoot, 'tasks', 'task-1', 'handoffs', 'fixed-handoff.json')));
  assert.throws(() => acceptHandoff({ root: fx.stateRoot, handoffId: 'fixed-handoff', receiver: { host: 'claude', sessionId: 'receiver' }, repo: fx.repo, worktree: fx.worktree, now: RENEW, renewBefore: '2026-10-08T12:02:00.000Z', expiresAt: EXPIRE }), /ambiguous/i);
});
