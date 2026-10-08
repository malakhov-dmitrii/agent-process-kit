import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  GrantError,
  assessGrantValidity,
  getUnreconciledAttempts,
  invalidateExecutionGrants,
  issueExecutionGrant,
  recordAuthorizationIntent,
  recordExternalAttempt,
  reconcileExternalAttempt,
  revokeGrant,
} from '../../runtime/core/grants.mjs';
import { acquireLease, mutateWithLease } from '../../runtime/core/leases.mjs';
import { createTask, readTask } from '../../runtime/core/store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, '..', 'fixtures', 'grant-worker.mjs');
const time = (minute) => `2026-10-08T12:${String(minute).padStart(2, '0')}:00.000Z`;

function fixture(taskId = 'grant-task') {
  const root = join(mkdtempSync(join(tmpdir(), 'apk-grant-')), 'state');
  createTask({
    root,
    input: { taskId, request: 'Ship exact candidate', mode: 'full-train', requestedBoundary: 'push', now: time(0) },
  });
  const integration = acquireLease({
    root,
    taskId,
    scope: 'canonical',
    ownerHost: 'codex',
    ownerSession: 'integration',
    expectedRecordVersion: 0,
    expectedFence: 0,
    renewBefore: time(50),
    expiresAt: time(59),
    now: time(1),
    leaseId: 'integration-lease',
  });
  return { root, taskId, integration };
}

function context(fx, recordVersion = fx.integration.record.recordVersion) {
  return {
    leaseId: fx.integration.lease.leaseId,
    fenceToken: fx.integration.lease.fenceToken,
    leaseScope: 'canonical',
    expectedRecordVersion: recordVersion,
    specGeneration: 0,
    planGeneration: 0,
  };
}

function candidate(taskId = 'grant-task', fingerprint = 'a'.repeat(64)) {
  return { taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: fingerprint, commitSha: 'b'.repeat(40) };
}

function prepareGrant(fx, { maxUses = 1 } = {}) {
  const intent = recordAuthorizationIntent({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx),
    operatorIdentity: 'operator:test',
    deliveryBoundary: 'push',
    constraints: { branch: 'main' },
    now: time(2),
    intentId: 'intent-1',
  });
  const ready = mutateWithLease({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx, intent.record.recordVersion),
    now: time(3),
    mutate: (record) => ({ ...record, phase: 'release-ready' }),
  });
  const granted = issueExecutionGrant({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx, ready.recordVersion),
    intentId: intent.intent.intentId,
    candidateIdentity: candidate(fx.taskId),
    targetResource: 'git:origin/main',
    allowedAction: 'push',
    granteeRole: 'release-adapter',
    expiresAt: time(30),
    maxUses,
    now: time(4),
    grantId: 'grant-1',
  });
  return { intent, ready, granted };
}

test('intent may precede a candidate but a grant binds exact release-ready identity and target', () => {
  const fx = fixture();
  const { intent, granted } = prepareGrant(fx);
  assert.equal(intent.intent.candidateIdentity, undefined);
  assert.equal(granted.grant.specGeneration, 0);
  assert.equal(granted.grant.planGeneration, 0);
  assert.deepEqual(
    assessGrantValidity({
      grant: granted.grant,
      record: granted.record,
      candidateIdentity: candidate(fx.taskId),
      targetResource: 'git:origin/main',
      allowedAction: 'push',
      now: time(5),
    }),
    { valid: true, reason: 'valid' },
  );
  assert.equal(assessGrantValidity({
    grant: granted.grant,
    record: granted.record,
    candidateIdentity: candidate(fx.taskId),
    targetResource: 'git:origin/other',
    allowedAction: 'push',
    now: time(5),
  }).reason, 'target-mismatch');
  assert.equal(assessGrantValidity({
    grant: granted.grant,
    record: granted.record,
    candidateIdentity: candidate(fx.taskId, 'c'.repeat(64)),
    targetResource: 'git:origin/main',
    allowedAction: 'push',
    now: time(5),
  }).reason, 'candidate-mismatch');
  assert.equal(assessGrantValidity({
    grant: granted.grant,
    record: { ...granted.record, specGeneration: 1 },
    candidateIdentity: candidate(fx.taskId),
    targetResource: 'git:origin/main',
    allowedAction: 'push',
    now: time(5),
  }).reason, 'generation-mismatch');
});

test('grant issue fails outside release-ready or when boundary and candidate generation disagree', () => {
  const fx = fixture('issue-guard');
  const intent = recordAuthorizationIntent({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx),
    operatorIdentity: 'operator:test',
    deliveryBoundary: 'push',
    constraints: {},
    now: time(2),
    intentId: 'intent-1',
  });
  assert.throws(
    () => issueExecutionGrant({
      root: fx.root,
      taskId: fx.taskId,
      context: context(fx, intent.record.recordVersion),
      intentId: 'intent-1',
      candidateIdentity: candidate(fx.taskId),
      targetResource: 'git:origin/main',
      allowedAction: 'push',
      granteeRole: 'release-adapter',
      expiresAt: time(30),
      maxUses: 1,
      now: time(3),
    }),
    (error) => error instanceof GrantError && error.code === 'TASK_NOT_RELEASE_READY',
  );
});

test('unknown outcomes block retries until provider readback reconciles the original attempt', () => {
  const fx = fixture();
  const { granted } = prepareGrant(fx, { maxUses: 2 });
  const externalIntent = {
    allowedAction: 'push',
    targetResource: 'git:origin/main',
    candidateIdentity: candidate(fx.taskId),
  };
  const prepared = recordExternalAttempt({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx, granted.record.recordVersion),
    grantId: granted.grant.grantId,
    idempotencyKey: 'push:exact-sha',
    intent: externalIntent,
    now: time(5),
    attemptId: 'attempt-1',
  });
  assert.equal(prepared.attempt.state, 'prepared');
  assert.equal(prepared.record.grants[0].uses, 1);

  const unknown = reconcileExternalAttempt({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx, prepared.record.recordVersion),
    attemptId: 'attempt-1',
    receipt: { outcome: 'unknown', providerIdentity: 'github:request-1' },
    now: time(6),
  });
  assert.equal(unknown.attempt.state, 'reconcile-required');
  assert.deepEqual(getUnreconciledAttempts(unknown.record).map((attempt) => attempt.attemptId), ['attempt-1']);

  assert.throws(
    () => recordExternalAttempt({
      root: fx.root,
      taskId: fx.taskId,
      context: context(fx, unknown.record.recordVersion),
      grantId: granted.grant.grantId,
      idempotencyKey: 'push:retry',
      intent: externalIntent,
      now: time(7),
      attemptId: 'attempt-2',
    }),
    (error) => error instanceof GrantError && error.code === 'UNRESOLVED_EXTERNAL_ATTEMPT',
  );

  const reconciled = reconcileExternalAttempt({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx, unknown.record.recordVersion),
    attemptId: 'attempt-1',
    receipt: { outcome: 'succeeded', providerIdentity: 'github:deployment-1', readback: { revision: 'b'.repeat(40) } },
    now: time(8),
  });
  assert.equal(reconciled.attempt.state, 'reconciled');
  assert.deepEqual(getUnreconciledAttempts(reconciled.record), []);
  assert.throws(
    () => recordExternalAttempt({
      root: fx.root,
      taskId: fx.taskId,
      context: context(fx, reconciled.record.recordVersion),
      grantId: granted.grant.grantId,
      idempotencyKey: 'push:exact-sha',
      intent: externalIntent,
      now: time(9),
      attemptId: 'attempt-duplicate',
    }),
    (error) => error instanceof GrantError && error.code === 'DUPLICATE_IDEMPOTENCY_KEY',
  );
});

test('unresolved attempt blocks an equivalent action across a fresh grant', () => {
  const fx = fixture('fresh-grant');
  const first = prepareGrant(fx, { maxUses: 2 }).granted;
  const externalIntent = { allowedAction: 'push', targetResource: 'git:origin/main', candidateIdentity: candidate(fx.taskId) };
  const prepared = recordExternalAttempt({ root: fx.root, taskId: fx.taskId, context: context(fx, first.record.recordVersion), grantId: first.grant.grantId, idempotencyKey: 'fresh:one', intent: externalIntent, now: time(5), attemptId: 'fresh-attempt-1' });
  const second = issueExecutionGrant({ root: fx.root, taskId: fx.taskId, context: context(fx, prepared.record.recordVersion), intentId: 'intent-1', candidateIdentity: candidate(fx.taskId), targetResource: 'git:origin/main', allowedAction: 'push', granteeRole: 'release-adapter', expiresAt: time(30), maxUses: 1, now: time(6), grantId: 'grant-2' });
  assert.throws(() => recordExternalAttempt({ root: fx.root, taskId: fx.taskId, context: context(fx, second.record.recordVersion), grantId: second.grant.grantId, idempotencyKey: 'fresh:two', intent: externalIntent, now: time(7), attemptId: 'fresh-attempt-2' }), (error) => error instanceof GrantError && error.code === 'UNRESOLVED_EXTERNAL_ATTEMPT');
});

test('intent action and target constrain the executable grant', () => {
  const fx = fixture('intent-constraints');
  const intent = recordAuthorizationIntent({ root: fx.root, taskId: fx.taskId, context: context(fx), operatorIdentity: 'operator:test', deliveryBoundary: 'push', allowedAction: 'push', targetResource: 'git:origin/main', constraints: {}, now: time(2), intentId: 'intent-constrained' });
  const ready = mutateWithLease({ root: fx.root, taskId: fx.taskId, context: context(fx, intent.record.recordVersion), now: time(3), mutate: (record) => ({ ...record, phase: 'release-ready' }) });
  assert.throws(() => issueExecutionGrant({ root: fx.root, taskId: fx.taskId, context: context(fx, ready.recordVersion), intentId: intent.intent.intentId, candidateIdentity: candidate(fx.taskId), targetResource: 'git:origin/other', allowedAction: 'push', granteeRole: 'release-adapter', expiresAt: time(30), maxUses: 1, now: time(4), grantId: 'constrained-grant' }), (error) => error instanceof GrantError && error.code === 'INTENT_TARGET_MISMATCH');
});

test('pause invalidation survives resume and explicit revocation is permanent', () => {
  const fx = fixture();
  const { granted } = prepareGrant(fx, { maxUses: 2 });
  const invalidated = invalidateExecutionGrants({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx, granted.record.recordVersion),
    reason: 'pause',
    now: time(5),
  });
  const resumed = { ...invalidated.record, status: 'active' };
  assert.equal(assessGrantValidity({
    grant: invalidated.record.grants[0],
    record: resumed,
    candidateIdentity: candidate(fx.taskId),
    targetResource: 'git:origin/main',
    allowedAction: 'push',
    now: time(6),
  }).reason, 'revoked');

  const fresh = fixture('revoke-task');
  const issued = prepareGrant(fresh, { maxUses: 2 }).granted;
  const revoked = revokeGrant({
    root: fresh.root,
    taskId: fresh.taskId,
    context: context(fresh, issued.record.recordVersion),
    grantId: 'grant-1',
    reason: 'operator-revoked',
    now: time(5),
  });
  assert.equal(revoked.grant.revokeReason, 'operator-revoked');
});

function spawnGrantWorker(fx, contextValue, idempotencyKey, attemptId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      worker,
      fx.root,
      fx.taskId,
      JSON.stringify(contextValue),
      idempotencyKey,
      attemptId,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('two processes racing a one-use grant produce one prepared external attempt', async () => {
  const fx = fixture('grant-race');
  const { granted } = prepareGrant(fx, { maxUses: 1 });
  mkdirSync(join(fx.root, 'barrier'), { mode: 0o700 });
  const ctx = context(fx, granted.record.recordVersion);
  const first = spawnGrantWorker(fx, ctx, 'race:1', 'race-attempt-1');
  const second = spawnGrantWorker(fx, ctx, 'race:2', 'race-attempt-2');
  writeFileSync(join(fx.root, 'barrier', 'start'), 'go', { mode: 0o600 });
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((item) => item.status === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((item) => item.status === 2).length, 1, JSON.stringify(results));
  const record = readTask({ root: fx.root, taskId: fx.taskId });
  assert.equal(record.externalAttempts.length, 1);
  assert.equal(record.grants[0].uses, 1);
});
