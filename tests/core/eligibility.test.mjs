import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EligibilityError,
  canAdvance,
  canComplete,
  completeTask,
  getDeliveryState,
  getEvidence,
} from '../../runtime/core/eligibility.mjs';
import { acquireLease, mutateWithLease } from '../../runtime/core/leases.mjs';
import { createInitialTaskRecord } from '../../runtime/core/schema.mjs';
import { createTask } from '../../runtime/core/store.mjs';
import { getStatus } from '../../runtime/core/status.mjs';

const time = (minute) => `2026-10-08T12:${String(minute).padStart(2, '0')}:00.000Z`;

function candidate(taskId = 'eligible-task', fingerprint = 'a'.repeat(64)) {
  return {
    taskId,
    specGeneration: 1,
    planGeneration: 1,
    contentFingerprint: fingerprint,
    commitSha: 'b'.repeat(40),
    artifactDigest: 'c'.repeat(64),
  };
}

function environment(revision = 'b'.repeat(40)) {
  return {
    environmentId: 'production',
    deploymentId: 'deploy-1',
    artifactDigest: 'c'.repeat(64),
    deployedRevision: revision,
    observedAt: time(10),
  };
}

function receipt(type, candidateIdentity, overrides = {}) {
  return {
    receiptId: `${type}-receipt`,
    type,
    candidateIdentity,
    producer: { kind: 'test', id: type },
    scenario: type,
    coverage: 'full-candidate',
    startedAt: time(2),
    completedAt: time(3),
    verdict: 'pass',
    ...overrides,
  };
}

function eligibleRecord(boundary = 'local', taskId = 'eligible-task') {
  const identity = candidate(taskId);
  const record = createInitialTaskRecord({
    taskId,
    request: 'Complete only with current proof',
    requestedBoundary: boundary,
    mode: 'full-train',
    now: time(0),
  });
  record.phase = 'close';
  record.specGeneration = 1;
  record.planGeneration = 1;
  record.artifacts = [
    { artifactId: 'spec:1', type: 'frozen-spec', generation: 1, contentHash: 'd'.repeat(64) },
    { artifactId: 'plan:1', type: 'frozen-plan', generation: 1, contentHash: 'e'.repeat(64) },
  ];
  record.storyGraph = {
    taskId,
    planGeneration: 1,
    reviewCaps: { spec: 1, plan: 1, code: 1 },
    frozenAt: time(1),
    stories: [{
      id: 'A',
      title: 'Required story',
      dependsOn: [],
      ownedPaths: ['runtime/a.mjs'],
      kind: 'work',
      required: true,
      status: 'integrated',
      claim: null,
      claimHistory: [],
      result: { candidateIdentity: identity, artifacts: [{ artifactId: 'result:A' }], submittedAt: time(2) },
      integrationReceipt: { receiptId: 'story:A', verdict: 'pass', candidateIdentity: identity },
      integratedAt: time(3),
    }],
  };
  record.evidence = [
    receipt('spec-review', identity, { blockingFindings: 0 }),
    receipt('plan-review', identity, { blockingFindings: 0 }),
    receipt('code-review', identity, { blockingFindings: 0 }),
    receipt('local-uat', identity),
    receipt('completion-records', identity),
    receipt('final-report', identity),
  ];
  if (['commit', 'push', 'deploy', 'production'].includes(boundary)) record.evidence.push(receipt('commit', identity));
  if (['push', 'deploy', 'production'].includes(boundary)) record.evidence.push(receipt('push', identity));
  if (['deploy', 'production'].includes(boundary)) record.evidence.push(receipt('deploy', identity, { environmentIdentity: environment() }));
  if (boundary === 'production') {
    record.evidence.push(receipt('production-uat', identity, { environmentIdentity: environment() }));
    record.evidence.push(receipt('observation', identity, { environmentIdentity: environment() }));
  }
  record.leases = [{
    leaseId: 'integration-lease',
    taskId,
    scope: 'canonical',
    ownerHost: 'codex',
    ownerSession: 'integration',
    generation: { specGeneration: 1, planGeneration: 1 },
    fenceToken: 1,
    acquiredAt: time(1),
    renewBefore: time(50),
    expiresAt: time(59),
    revokedAt: null,
  }];
  record.followUps = [{ id: 'later-polish', owner: 'maintainer' }];
  return { record, identity };
}

function blockerCodes(verdict) {
  return verdict.blockers.map((blocker) => blocker.code);
}

test('eligible local completion allows its integration lease and distinguishes delivery contours', () => {
  const local = eligibleRecord('local');
  assert.deepEqual(canComplete({ record: local.record, candidateIdentity: local.identity, now: time(10) }), {
    eligible: true,
    blockers: [],
  });
  assert.deepEqual(getDeliveryState({ record: local.record, candidateIdentity: local.identity, now: time(10) }), {
    local: true,
    commit: false,
    push: false,
    deploy: false,
    production: false,
  });

  const pushed = eligibleRecord('push');
  assert.deepEqual(getDeliveryState({ record: pushed.record, candidateIdentity: pushed.identity, now: time(10) }), {
    local: true,
    commit: true,
    push: true,
    deploy: false,
    production: false,
  });
});

test('completion reports each missing or unsafe proof without collapsing it into green tests', () => {
  const { record, identity } = eligibleRecord('production');
  record.evidence = record.evidence.filter((item) => item.type !== 'local-uat');
  record.storyGraph.stories[0].status = 'submitted';
  record.evidence.find((item) => item.type === 'code-review').blockingFindings = 1;
  record.externalAttempts = [{ attemptId: 'unknown', state: 'reconcile-required' }];
  record.grants = [{ grantId: 'live', revokedAt: null, expiresAt: time(40), uses: 0, maxUses: 1 }];
  record.leases.push({ leaseId: 'worker', scope: 'story:A', revokedAt: null, expiresAt: time(40), fenceToken: 1 });
  record.followUps = [{ id: 'ownerless' }];
  record.evidence = record.evidence.filter((item) => item.type !== 'completion-records');
  const verdict = canComplete({ record, candidateIdentity: identity, environmentIdentity: environment(), now: time(10) });
  assert.equal(verdict.eligible, false);
  assert.deepEqual(blockerCodes(verdict), [
    'required-story-incomplete',
    'blocking-code-review-finding',
    'missing-local-uat',
    'active-worker-lease',
    'active-execution-grant',
    'unreconciled-external-attempt',
    'missing-completion-records',
    'ownerless-follow-up',
  ]);
});

test('stale candidate and wrong deployed revision block the exact production boundary', () => {
  const { record, identity } = eligibleRecord('production');
  const changed = { ...identity, contentFingerprint: 'f'.repeat(64) };
  let verdict = canComplete({ record, candidateIdentity: changed, environmentIdentity: environment(), now: time(10) });
  assert.ok(blockerCodes(verdict).includes('stale-spec-review'));
  assert.ok(blockerCodes(verdict).includes('stale-local-uat'));

  verdict = canComplete({
    record,
    candidateIdentity: identity,
    environmentIdentity: environment('wrong-revision'),
    now: time(10),
  });
  assert.ok(blockerCodes(verdict).includes('missing-current-deploy'));
  assert.ok(blockerCodes(verdict).includes('missing-current-production-uat'));
  assert.ok(blockerCodes(verdict).includes('missing-current-observation'));
});

test('phase advancement names its owning missing gate', () => {
  const { record, identity } = eligibleRecord('push');
  record.phase = 'code-review';
  record.evidence = record.evidence.filter((item) => item.type !== 'code-review');
  assert.deepEqual(canAdvance({ record, targetPhase: 'local-uat', candidateIdentity: identity, now: time(10) }), {
    allowed: false,
    blockers: [{ code: 'missing-current-code-review', ownerPhase: 'code-review' }],
  });
  record.evidence.push(receipt('code-review', identity, { blockingFindings: 0 }));
  assert.deepEqual(canAdvance({ record, targetPhase: 'local-uat', candidateIdentity: identity, now: time(10) }), {
    allowed: true,
    blockers: [],
  });
});

test('standard and full-train tasks cannot omit the frozen story graph', () => {
  const { record, identity } = eligibleRecord('local');
  record.storyGraph = null;
  assert.ok(blockerCodes(canComplete({ record, candidateIdentity: identity, now: time(10) })).includes('missing-story-graph'));
  record.phase = 'implement';
  assert.deepEqual(canAdvance({ record, targetPhase: 'code-review', candidateIdentity: identity, now: time(10) }), {
    allowed: false,
    blockers: [{ code: 'missing-story-graph', ownerPhase: 'plan-review' }],
  });
});

test('evidence query and status expose current, stale, missing, lanes and next owner', () => {
  const { record, identity } = eligibleRecord('local');
  record.phase = 'implement';
  record.storyGraph.stories.push({
    id: 'B', title: 'Ready', dependsOn: [], ownedPaths: ['runtime/b.mjs'], kind: 'work', required: true,
    status: 'ready', claim: null, claimHistory: [], result: null, integrationReceipt: null,
  });
  record.lastTrace = { expected: 'story A', actual: 'story A integrated', decision: 'start B', nextOwner: 'worker-b', nextAction: 'claim B', attemptsSameCause: 1 };
  record.pendingDecisions = [{ id: 'decision-1', owner: 'operator' }];
  record.evidence.push(receipt('old-test', { ...identity, contentFingerprint: '0'.repeat(64) }));
  const evidence = getEvidence({ record, candidateIdentity: identity });
  assert.equal(evidence.find((item) => item.type === 'local-uat').freshness.status, 'current');
  assert.equal(evidence.find((item) => item.type === 'old-test').freshness.status, 'stale');
  const status = getStatus({ record, candidateIdentity: identity, now: time(10) });
  assert.deepEqual(status.progress, { completed: 1, total: 2 });
  assert.deepEqual(status.lanes.ready, ['B']);
  assert.equal(status.next.owner, 'worker-b');
  assert.equal(status.next.action, 'claim B');
  assert.deepEqual(status.pendingDecisions, [{ id: 'decision-1', owner: 'operator' }]);
  assert.equal(status.delivery.local, true);
});

test('completeTask uses then atomically retires its own integration lease', () => {
  const base = mkdtempSync(join(tmpdir(), 'apk-complete-'));
  const root = join(base, 'state');
  const taskId = 'eligible-task';
  createTask({ root, input: { taskId, request: 'close', mode: 'full-train', requestedBoundary: 'local', now: time(0) } });
  const integration = acquireLease({
    root, taskId, scope: 'canonical', ownerHost: 'codex', ownerSession: 'integration',
    expectedRecordVersion: 0, expectedFence: 0, renewBefore: time(50), expiresAt: time(59), now: time(1), leaseId: 'integration-lease',
  });
  const eligible = eligibleRecord('local');
  const prepared = mutateWithLease({
    root,
    taskId,
    context: {
      leaseId: integration.lease.leaseId,
      fenceToken: integration.lease.fenceToken,
      leaseScope: 'canonical',
      expectedRecordVersion: integration.record.recordVersion,
      specGeneration: 0,
      planGeneration: 0,
    },
    now: time(2),
    mutate: (current) => ({
      ...eligible.record,
      recordVersion: current.recordVersion,
      leases: current.leases,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    }),
  });
  const completionInput = {
    root,
    taskId,
    context: {
      leaseId: integration.lease.leaseId,
      fenceToken: integration.lease.fenceToken,
      leaseScope: 'canonical',
      expectedRecordVersion: prepared.recordVersion,
      specGeneration: 1,
      planGeneration: 1,
    },
    candidateIdentity: eligible.identity,
    recomputeCandidate: () => eligible.identity,
    now: time(10),
  };
  assert.throws(
    () => completeTask({
      ...completionInput,
      recomputeCandidate: () => ({ ...eligible.identity, contentFingerprint: 'f'.repeat(64) }),
    }),
    (error) => error instanceof EligibilityError && error.code === 'STALE_CANDIDATE',
  );
  const completed = completeTask(completionInput);
  assert.equal(completed.record.status, 'complete');
  assert.equal(completed.record.leases[0].revokedAt, time(10));
  assert.equal(completed.record.leases[0].revokeReason, 'task-complete');

  const unsafe = eligibleRecord('local');
  unsafe.record.leases.push({ leaseId: 'worker', scope: 'story:A', revokedAt: null, expiresAt: time(40), fenceToken: 1 });
  assert.ok(blockerCodes(canComplete({ record: unsafe.record, candidateIdentity: unsafe.identity, now: time(10) })).includes('active-worker-lease'));
});

test('completeTask refuses an ineligible record with structured blockers', () => {
  const base = mkdtempSync(join(tmpdir(), 'apk-ineligible-'));
  const root = join(base, 'state');
  const taskId = 'ineligible-task';
  createTask({ root, input: { taskId, request: 'close', mode: 'full-train', requestedBoundary: 'local', now: time(0) } });
  const integration = acquireLease({
    root, taskId, scope: 'canonical', ownerHost: 'codex', ownerSession: 'integration',
    expectedRecordVersion: 0, expectedFence: 0, renewBefore: time(50), expiresAt: time(59), now: time(1), leaseId: 'integration-lease',
  });
  assert.throws(
    () => completeTask({
      root,
      taskId,
      context: {
        leaseId: integration.lease.leaseId,
        fenceToken: 1,
        leaseScope: 'canonical',
        expectedRecordVersion: 1,
        specGeneration: 0,
        planGeneration: 0,
      },
      candidateIdentity: candidate(taskId),
      recomputeCandidate: () => candidate(taskId),
      now: time(10),
    }),
    (error) => error instanceof EligibilityError && error.code === 'TASK_INELIGIBLE',
  );
});
