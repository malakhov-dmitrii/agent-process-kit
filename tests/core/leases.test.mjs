import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  LeaseError,
  acquireLease,
  currentFence,
  mutateWithLease,
  releaseLease,
  renewLease,
} from '../../runtime/core/leases.mjs';
import { createTask, readTask } from '../../runtime/core/store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, '..', 'fixtures', 'lease-worker.mjs');
const T0 = '2026-10-08T12:00:00.000Z';
const T1 = '2026-10-08T12:01:00.000Z';
const T2 = '2026-10-08T12:02:00.000Z';
const T3 = '2026-10-08T12:03:00.000Z';
const T4 = '2026-10-08T12:04:00.000Z';

function fixture(taskId = 'lease-task') {
  const base = mkdtempSync(join(tmpdir(), 'apk-lease-'));
  const root = join(base, 'state');
  createTask({
    root,
    input: { taskId, request: 'Prove fenced ownership', mode: 'full-train', requestedBoundary: 'local', now: T0 },
  });
  return { base, root, taskId };
}

function acquire(fx, overrides = {}) {
  return acquireLease({
    root: fx.root,
    taskId: fx.taskId,
    scope: 'canonical',
    ownerHost: 'codex',
    ownerSession: 'session-1',
    expectedRecordVersion: 0,
    expectedFence: 0,
    renewBefore: T2,
    expiresAt: T3,
    now: T1,
    leaseId: 'lease-1',
    ...overrides,
  });
}

function context(result, overrides = {}) {
  return {
    leaseId: result.lease.leaseId,
    fenceToken: result.lease.fenceToken,
    leaseScope: result.lease.scope,
    expectedRecordVersion: result.record.recordVersion,
    specGeneration: result.record.specGeneration,
    planGeneration: result.record.planGeneration,
    ...overrides,
  };
}

test('acquires a monotonic fence and every canonical mutation validates its context', () => {
  const fx = fixture();
  const acquired = acquire(fx);
  assert.equal(acquired.record.recordVersion, 1);
  assert.equal(acquired.lease.fenceToken, 1);
  assert.equal(currentFence(acquired.record, 'canonical'), 1);

  const mutated = mutateWithLease({
    root: fx.root,
    taskId: fx.taskId,
    context: context(acquired),
    now: T2,
    mutate: (record) => ({ ...record, lastTrace: { step: 'owned-write' } }),
  });
  assert.equal(mutated.recordVersion, 2);
  assert.equal(mutated.lastTrace.step, 'owned-write');

  assert.throws(
    () => mutateWithLease({
      root: fx.root,
      taskId: fx.taskId,
      context: context(acquired, { expectedRecordVersion: 2, leaseScope: 'story:wrong' }),
      now: T2,
      mutate: (record) => record,
    }),
    (error) => error instanceof LeaseError && error.code === 'LEASE_SCOPE_MISMATCH',
  );
});

test('expired ownership never transfers until a new acquisition increments the fence', () => {
  const fx = fixture();
  const first = acquire(fx, { now: T0, renewBefore: T1, expiresAt: T2 });
  assert.throws(
    () => mutateWithLease({
      root: fx.root,
      taskId: fx.taskId,
      context: context(first),
      now: T2,
      mutate: (record) => record,
    }),
    (error) => error instanceof LeaseError && error.code === 'LEASE_EXPIRED',
  );

  const second = acquire(fx, {
    ownerSession: 'session-2',
    expectedRecordVersion: 1,
    expectedFence: 1,
    renewBefore: T3,
    expiresAt: T4,
    now: T2,
    leaseId: 'lease-2',
  });
  assert.equal(second.lease.fenceToken, 2);
  assert.throws(
    () => mutateWithLease({
      root: fx.root,
      taskId: fx.taskId,
      context: context(first, { expectedRecordVersion: 2 }),
      now: T3,
      mutate: (record) => record,
    }),
    (error) => error instanceof LeaseError && error.code === 'STALE_FENCE',
  );
});

test('renewal and release are fenced mutations and revoked leases cannot write', () => {
  const fx = fixture();
  const first = acquire(fx);
  const renewed = renewLease({
    root: fx.root,
    taskId: fx.taskId,
    context: context(first),
    renewBefore: T3,
    expiresAt: T4,
    now: T2,
  });
  assert.equal(renewed.record.recordVersion, 2);
  assert.equal(renewed.lease.expiresAt, T4);

  const released = releaseLease({
    root: fx.root,
    taskId: fx.taskId,
    context: context(renewed, { expectedRecordVersion: 2 }),
    reason: 'handoff',
    now: T3,
  });
  assert.equal(released.record.recordVersion, 3);
  assert.equal(released.lease.revokedAt, T3);
  assert.equal(released.lease.revokeReason, 'handoff');
  assert.throws(
    () => mutateWithLease({
      root: fx.root,
      taskId: fx.taskId,
      context: context(released, { expectedRecordVersion: 3 }),
      now: T3,
      mutate: (record) => record,
    }),
    (error) => error instanceof LeaseError && error.code === 'LEASE_REVOKED',
  );
});

test('canonical owner advances its lease generation atomically and story owners cannot change generations', () => {
  const fx = fixture('generation-task');
  const canonical = acquire(fx);
  const advanced = mutateWithLease({
    root: fx.root,
    taskId: fx.taskId,
    context: context(canonical),
    now: T2,
    mutate: (record) => ({ ...record, specGeneration: 1 }),
  });
  assert.deepEqual(advanced.leases[0].generation, { specGeneration: 1, planGeneration: 0 });
  assert.equal(mutateWithLease({
    root: fx.root,
    taskId: fx.taskId,
    context: context(canonical, { expectedRecordVersion: 2, specGeneration: 1 }),
    now: T2,
    mutate: (record) => record,
  }).recordVersion, 3);

  const storyFixture = fixture('story-generation-task');
  const integration = acquire(storyFixture);
  const storyLease = acquire(storyFixture, {
    scope: 'story:A',
    ownerSession: 'worker',
    expectedRecordVersion: 1,
    expectedFence: 0,
    leaseId: 'story-lease',
  });
  assert.throws(
    () => mutateWithLease({
      root: storyFixture.root,
      taskId: storyFixture.taskId,
      context: context(storyLease),
      now: T2,
      mutate: (record) => ({ ...record, planGeneration: 1 }),
    }),
    (error) => error instanceof LeaseError && error.code === 'LEASE_GENERATION_MUTATION_FORBIDDEN',
  );
  assert.equal(integration.lease.scope, 'canonical');
});

test('acquisition rejects an active owner and a stale expected fence', () => {
  const fx = fixture();
  acquire(fx);
  assert.throws(
    () => acquire(fx, { expectedRecordVersion: 1, expectedFence: 1, leaseId: 'lease-2', ownerSession: 'session-2' }),
    (error) => error instanceof LeaseError && error.code === 'LEASE_CONFLICT',
  );

  const expired = fixture('expired-task');
  acquire(expired, { now: T0, renewBefore: T1, expiresAt: T2 });
  assert.throws(
    () => acquire(expired, {
      expectedRecordVersion: 1,
      expectedFence: 0,
      leaseId: 'lease-2',
      ownerSession: 'session-2',
      renewBefore: T3,
      expiresAt: T4,
      now: T2,
    }),
    (error) => error instanceof LeaseError && error.code === 'STALE_FENCE',
  );
});

function spawnLeaseWorker(fx, scope, marker, retry = false) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, fx.root, fx.taskId, scope, marker, retry ? 'retry' : 'once'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('real processes allow one canonical claimant and eventually allow disjoint story scopes', async () => {
  const canonical = fixture('canonical-race');
  mkdirSync(join(canonical.root, 'barrier'), { mode: 0o700 });
  const c1 = spawnLeaseWorker(canonical, 'canonical', 'c1');
  const c2 = spawnLeaseWorker(canonical, 'canonical', 'c2');
  writeFileSync(join(canonical.root, 'barrier', 'start'), 'go', { mode: 0o600 });
  const canonicalResults = await Promise.all([c1, c2]);
  assert.equal(canonicalResults.filter((item) => item.status === 0).length, 1, JSON.stringify(canonicalResults));
  assert.equal(canonicalResults.filter((item) => item.status === 2).length, 1, JSON.stringify(canonicalResults));

  const stories = fixture('story-race');
  mkdirSync(join(stories.root, 'barrier'), { mode: 0o700 });
  const s1 = spawnLeaseWorker(stories, 'story:A', 's1', true);
  const s2 = spawnLeaseWorker(stories, 'story:B', 's2', true);
  writeFileSync(join(stories.root, 'barrier', 'start'), 'go', { mode: 0o600 });
  const storyResults = await Promise.all([s1, s2]);
  assert.deepEqual(storyResults.map((item) => item.status), [0, 0], JSON.stringify(storyResults));
  const record = readTask({ root: stories.root, taskId: stories.taskId });
  assert.equal(record.leases.filter((lease) => lease.scope.startsWith('story:')).length, 2);
  assert.equal(currentFence(record, 'story:A'), 1);
  assert.equal(currentFence(record, 'story:B'), 1);
});
