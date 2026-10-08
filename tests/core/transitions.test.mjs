import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createInitialTaskRecord,
  validateMutationContext,
  validateTaskRecord,
} from '../../runtime/core/schema.mjs';
import {
  TransitionError,
  resolvePhaseTransition,
  resolveTaskStatusTransition,
  validatePhaseSkip,
} from '../../runtime/core/transitions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

test('creates a canonical initial task record and rejects unsafe external input', () => {
  const record = createInitialTaskRecord({
    taskId: 'export-dedupe',
    request: 'Fix duplicate export rows',
    requestedBoundary: 'local',
    mode: 'standard',
    now: '2026-10-08T12:00:00.000Z',
  });

  assert.deepEqual(
    {
      schemaVersion: record.schemaVersion,
      taskId: record.taskId,
      recordVersion: record.recordVersion,
      status: record.status,
      phase: record.phase,
      mode: record.mode,
      requestedBoundary: record.requestedBoundary,
      specGeneration: record.specGeneration,
      planGeneration: record.planGeneration,
      checkpointGeneration: record.checkpointGeneration,
    },
    {
      schemaVersion: 1,
      taskId: 'export-dedupe',
      recordVersion: 0,
      status: 'active',
      phase: 'intake',
      mode: 'standard',
      requestedBoundary: 'local',
      specGeneration: 0,
      planGeneration: 0,
      checkpointGeneration: 0,
    },
  );
  assert.equal(validateTaskRecord(record), record);
  assert.throws(() => createInitialTaskRecord({ taskId: '../escape', request: 'x' }), /taskId/);
  assert.throws(() => createInitialTaskRecord({ taskId: 'ok', request: 'x', mode: 'ceremony' }), /mode/);
  assert.throws(() => createInitialTaskRecord({ taskId: 'ok', request: 'x', requestedBoundary: 'wishful' }), /requestedBoundary/);
});

test('mutation context requires the complete optimistic concurrency fence', () => {
  const context = {
    leaseId: 'lease-1',
    fenceToken: 4,
    leaseScope: 'canonical',
    expectedRecordVersion: 8,
    specGeneration: 2,
    planGeneration: 3,
  };
  assert.equal(validateMutationContext(context), context);
  for (const field of Object.keys(context)) {
    const invalid = { ...context };
    delete invalid[field];
    assert.throws(() => validateMutationContext(invalid), new RegExp(field));
  }
});

test('task status transition table accepts every contract success row', () => {
  const cases = [
    ['active', 'pause', {}, 'paused', ['revoke-execution-grants', 'revoke-active-leases']],
    ['paused', 'resume', { recoverySatisfied: true }, 'active', ['revalidate-candidate-evidence-intent', 'acquire-new-lease']],
    ['active', 'park', { noIndependentReadyLane: true }, 'parked', ['preserve-independent-work']],
    ['parked', 'decision-recorded', { recoverySatisfied: true }, 'active', ['regenerate-if-decision-changed']],
    ['active', 'block', { externalCondition: true }, 'blocked', ['record-blocking-receipt']],
    ['blocked', 'blocking-condition-changed', { recoverySatisfied: true }, 'active', ['rerun-owning-gate']],
    ['active', 'cancel', { containmentComplete: true }, 'cancelled', ['revoke-execution-grants', 'revoke-active-leases']],
    ['active', 'complete', { completionEligible: true }, 'complete', ['retire-integration-lease']],
    ['active', 'accept-rollback', { operatorAccepted: true, rollbackReceipt: true }, 'rolled-back', ['record-rollback-impact']],
  ];

  for (const [from, event, facts, to, effects] of cases) {
    assert.deepEqual(resolveTaskStatusTransition({ from, event, facts }), { from, event, to, effects });
  }
});

test('task status transition table rejects skipped recovery and terminal resume', () => {
  const cases = [
    ['paused', 'resume', {}],
    ['active', 'park', { noIndependentReadyLane: false }],
    ['active', 'cancel', { containmentComplete: false }],
    ['active', 'complete', { completionEligible: false }],
    ['active', 'accept-rollback', { operatorAccepted: true, rollbackReceipt: false }],
    ['cancelled', 'resume', { recoverySatisfied: true }],
    ['complete', 'resume', { recoverySatisfied: true }],
    ['rolled-back', 'resume', { recoverySatisfied: true }],
  ];

  for (const [from, event, facts] of cases) {
    assert.throws(
      () => resolveTaskStatusTransition({ from, event, facts }),
      (error) => error instanceof TransitionError && error.code === 'INVALID_STATUS_TRANSITION',
      `${from}:${event}`,
    );
  }
});

test('phase transition table covers success and named failure paths', () => {
  const cases = [
    ['intake', 'needs-clarification', {}, 'clarify', []],
    ['intake', 'ambiguity-low', { recordedReason: 'clear mechanical task' }, 'spec-draft', []],
    ['clarify', 'decisions-ready', {}, 'spec-draft', []],
    ['spec-draft', 'spec-observable', {}, 'spec-review', []],
    ['spec-review', 'review-approved', {}, 'plan-draft', ['freeze-spec']],
    ['spec-review', 'review-blocked', {}, 'spec-draft', ['increment-spec-generation']],
    ['plan-draft', 'plan-complete', {}, 'plan-review', []],
    ['plan-review', 'review-approved', {}, 'implement', ['freeze-plan']],
    ['plan-review', 'review-blocked', {}, 'plan-draft', ['increment-plan-generation']],
    ['implement', 'stories-integrated', {}, 'code-review', []],
    ['implement', 'story-failed', {}, 'implement', ['return-story-to-red']],
    ['implement', 'architecture-diverged', { ownerPhase: 'plan-draft' }, 'plan-draft', ['invalidate-affected-plan-evidence']],
    ['code-review', 'review-approved', {}, 'local-uat', []],
    ['code-review', 'review-blocked', {}, 'implement', ['create-bounded-fix-stories']],
    ['local-uat', 'uat-passed', { requestedBoundary: 'local' }, 'close', []],
    ['local-uat', 'uat-passed', { requestedBoundary: 'production' }, 'release-ready', []],
    ['local-uat', 'uat-defect', {}, 'implement', ['create-regression-story']],
    ['release-ready', 'grant-ready', { exactCandidateGrant: true }, 'release', []],
    ['release-ready', 'candidate-changed', { ownerPhase: 'code-review' }, 'code-review', ['invalidate-release-readiness']],
    ['release', 'release-confirmed', { requestedBoundary: 'deploy' }, 'close', []],
    ['release', 'release-confirmed', { requestedBoundary: 'production' }, 'production-uat', []],
    ['release', 'known-failure', {}, 'release-ready', ['record-release-failure']],
    ['release', 'unknown-outcome', {}, 'release', ['require-reconciliation']],
    ['production-uat', 'uat-passed', {}, 'observe', []],
    ['production-uat', 'uat-failed', {}, 'implement', ['contain-or-rollback', 'open-red-cycle']],
    ['observe', 'observation-passed', {}, 'close', []],
    ['observe', 'blocking-signal', { ownerPhase: 'release-ready' }, 'release-ready', ['contain-or-rollback']],
    ['close', 'receipt-stale', { ownerPhase: 'local-uat' }, 'local-uat', ['mark-receipt-stale']],
  ];

  for (const [from, event, facts, to, effects] of cases) {
    assert.deepEqual(resolvePhaseTransition({ from, event, facts }), { from, event, to, effects });
  }
});

test('phase transitions reject skipped gates and invalid recovery owners', () => {
  const cases = [
    ['intake', 'ambiguity-low', {}],
    ['local-uat', 'uat-passed', { requestedBoundary: 'wishful' }],
    ['release-ready', 'grant-ready', { exactCandidateGrant: false }],
    ['release-ready', 'candidate-changed', { ownerPhase: 'release' }],
    ['observe', 'blocking-signal', { ownerPhase: 'observe' }],
    ['close', 'receipt-stale', { ownerPhase: 'close' }],
    ['close', 'review-approved', {}],
  ];
  for (const [from, event, facts] of cases) {
    assert.throws(
      () => resolvePhaseTransition({ from, event, facts }),
      (error) => error instanceof TransitionError && error.code === 'INVALID_PHASE_TRANSITION',
      `${from}:${event}`,
    );
  }
});

test('quick mode can skip ceremony but cannot silently skip an observable real path', () => {
  assert.deepEqual(
    validatePhaseSkip({ mode: 'quick', phase: 'plan-review', reason: 'single mechanical edit' }),
    { allowed: true, reason: 'single mechanical edit' },
  );
  assert.deepEqual(
    validatePhaseSkip({
      mode: 'quick',
      phase: 'local-uat',
      reason: 'pure internal metadata',
      changeKind: 'internal-metadata',
      externallyObservable: false,
    }),
    { allowed: true, reason: 'pure internal metadata' },
  );
  assert.throws(
    () => validatePhaseSkip({ mode: 'quick', phase: 'local-uat', reason: 'small change', changeKind: 'runtime', externallyObservable: true }),
    /real-path/,
  );
  assert.throws(() => validatePhaseSkip({ mode: 'quick', phase: 'plan-review' }), /reason/);
  assert.throws(() => validatePhaseSkip({ mode: 'standard', phase: 'plan-review', reason: 'small' }), /standard/);
});

test('published JSON schemas carry the required canonical identities', () => {
  const expectations = {
    'task-record.schema.json': ['schemaVersion', 'taskId', 'recordVersion', 'request', 'requestedBoundary', 'status', 'phase', 'mode', 'specGeneration', 'planGeneration', 'checkpointGeneration', 'checkpointEvents', 'artifacts', 'decisions', 'storyGraph', 'leases', 'evidence', 'authorizationIntents', 'grants', 'externalAttempts', 'pendingDecisions', 'followUps', 'lastTrace', 'createdAt', 'updatedAt'],
    'artifact.schema.json': ['artifactId', 'taskId', 'type', 'generation', 'contentHash', 'producer', 'createdAt', 'sourceInputs'],
    'receipt.schema.json': ['receiptId', 'taskId', 'candidateIdentity', 'producer', 'scenario', 'coverage', 'startedAt', 'completedAt', 'verdict'],
    'story-graph.schema.json': ['taskId', 'planGeneration', 'reviewCaps', 'stories'],
    'execution-grant.schema.json': ['grantId', 'taskId', 'intentId', 'operatorIdentity', 'granteeRole', 'allowedAction', 'targetResource', 'deliveryBoundary', 'specGeneration', 'planGeneration', 'candidateIdentity', 'constraints', 'issuedAt', 'expiresAt', 'maxUses', 'uses', 'revokedAt'],
  };
  for (const [name, required] of Object.entries(expectations)) {
    const schema = JSON.parse(readFileSync(join(root, 'runtime', 'schemas', name), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepEqual(schema.required, required);
    assert.equal(schema.additionalProperties, false);
  }
});
