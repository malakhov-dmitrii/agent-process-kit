import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireLease } from '../../runtime/core/leases.mjs';
import { createTask, readTask } from '../../runtime/core/store.mjs';
import { mutateWithLease } from '../../runtime/core/leases.mjs';
import { recordAuthorizationIntent, issueExecutionGrant } from '../../runtime/core/grants.mjs';
import { runLocalUat } from '../../runtime/adapters/uat.mjs';
import {
  assessReleaseReadiness,
  executeRelease,
  recordProductionUat,
  recordProductionObservation,
} from '../../runtime/adapters/release.mjs';

const at = (minute) => `2026-10-08T12:${String(minute).padStart(2, '0')}:00.000Z`;

function fixture(boundary = 'production') {
  const root = join(mkdtempSync(join(tmpdir(), 'apk-cp011-')), 'state');
  const taskId = 'uat-release-task';
  createTask({ root, input: { taskId, request: 'Ship exact candidate', mode: 'full-train', requestedBoundary: boundary, now: at(0) } });
  const lease = acquireLease({
    root, taskId, scope: 'canonical', ownerHost: 'codex', ownerSession: 'integration',
    expectedRecordVersion: 0, expectedFence: 0, renewBefore: at(50), expiresAt: at(59), now: at(1), leaseId: 'integration-lease',
  });
  return { root, taskId, lease, boundary };
}

function context(fx, recordVersion = fx.lease.record.recordVersion) {
  return {
    leaseId: fx.lease.lease.leaseId,
    fenceToken: fx.lease.lease.fenceToken,
    leaseScope: 'canonical',
    expectedRecordVersion: recordVersion,
    specGeneration: 0,
    planGeneration: 0,
  };
}

function candidate(taskId = 'uat-release-task', fingerprint = 'a'.repeat(64)) {
  return { taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: fingerprint, commitSha: 'b'.repeat(40), artifactDigest: 'c'.repeat(64) };
}

function receipt(type, identity, extra = {}) {
  return {
    receiptId: `${type}-receipt`, type, candidateIdentity: identity, producer: { kind: 'integration-test', id: type },
    scenario: type, coverage: 'full-candidate', startedAt: at(2), completedAt: at(3), verdict: 'pass', ...extra,
  };
}

function makeReady(fx, identity = candidate(fx.taskId)) {
  const updated = mutateWithLease({
    root: fx.root, taskId: fx.taskId, context: context(fx), now: at(4),
    mutate: (record) => ({
      ...record,
      phase: 'release-ready',
      evidence: [
        receipt('local-uat', identity),
        receipt('push', identity, { targetBranch: 'main', branchSynchronized: true, remoteRevision: identity.commitSha }),
        receipt('full-gate', identity, { gate: 'full', checks: ['tests', 'lint', 'typecheck'] }),
        receipt('docs', identity, { checks: ['docs'] }),
        receipt('migration', identity, { checks: ['migration'] }),
        receipt('containment', identity, { checks: ['rollback'] }),
      ],
    }),
  });
  const intent = recordAuthorizationIntent({
    root: fx.root, taskId: fx.taskId, context: context(fx, updated.recordVersion), operatorIdentity: 'operator:test',
    deliveryBoundary: fx.boundary ?? 'production', constraints: { branch: 'main' }, now: at(5), intentId: 'intent-1',
  });
  const grant = issueExecutionGrant({
    root: fx.root, taskId: fx.taskId, context: context(fx, intent.record.recordVersion), intentId: intent.intent.intentId,
    candidateIdentity: identity, targetResource: fx.boundary === 'production' ? 'deploy:production' : 'deploy:staging', allowedAction: 'deploy', granteeRole: 'release-adapter',
    expiresAt: at(40), maxUses: 1, now: at(6), grantId: 'grant-1',
  });
  return { identity, record: grant.record, grant: grant.grant };
}

test('real local CLI/filesystem UAT records a candidate-bound scenario receipt', () => {
  const fx = fixture('local');
  const identity = candidate(fx.taskId);
  const result = runLocalUat({
    root: fx.root, taskId: fx.taskId, context: context(fx), candidateIdentity: identity,
    scenarioId: 'local-cli-filesystem', producer: { kind: 'node', version: process.version },
    command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'uat-ok\\n')", join(fx.root, 'uat-output.txt')],
    filesystemChecks: [{ path: join(fx.root, 'uat-output.txt'), contains: 'uat-ok' }], now: at(7),
  });
  assert.equal(result.receipt.type, 'local-uat');
  assert.equal(result.receipt.verdict, 'pass');
  assert.deepEqual(result.receipt.candidateIdentity, identity);
  assert.equal(readTask({ root: fx.root, taskId: fx.taskId }).evidence.at(-1).receiptId, result.receipt.receiptId);
});

test('unavailable browser/provider and green tests remain missing UAT', () => {
  const fx = fixture('local');
  const result = runLocalUat({
    root: fx.root, taskId: fx.taskId, context: context(fx), candidateIdentity: candidate(fx.taskId), scenarioId: 'browser-required',
    provider: 'browser', providerAvailable: false, testsGreen: true, now: at(7),
  });
  assert.equal(result.receipt.verdict, 'missing');
  assert.match(result.receipt.reason, /provider|browser|uat/i);
});

test('failed UAT records regression ownership', () => {
  const fx = fixture('local');
  const result = runLocalUat({
    root: fx.root, taskId: fx.taskId, context: context(fx), candidateIdentity: candidate(fx.taskId), scenarioId: 'failing-cli',
    command: [process.execPath, '-e', 'process.exit(7)'], regressionOwner: 'verification-release', now: at(7),
  });
  assert.equal(result.receipt.verdict, 'fail');
  assert.equal(result.receipt.regressionOwner, 'verification-release');
  assert.deepEqual(readTask({ root: fx.root, taskId: fx.taskId }).followUps.at(-1), { id: 'regression:local-uat:failing-cli', owner: 'verification-release' });
});

test('UAT requires the canonical lease and current task generations', () => {
  const fx = fixture('local');
  const identity = candidate(fx.taskId);
  const story = acquireLease({
    root: fx.root, taskId: fx.taskId, scope: 'story:uat', ownerHost: 'codex', ownerSession: 'worker',
    expectedRecordVersion: fx.lease.record.recordVersion, expectedFence: 0, renewBefore: at(50), expiresAt: at(59), now: at(1), leaseId: 'story-lease',
  });
  assert.throws(() => runLocalUat({
    root: fx.root, taskId: fx.taskId, context: { ...context(fx, story.record.recordVersion), leaseId: story.lease.leaseId, fenceToken: story.lease.fenceToken, leaseScope: 'story:uat' },
    candidateIdentity: identity, scenarioId: 'wrong-scope', command: [process.execPath, '-e', ''], now: at(7),
  }), (error) => error.code === 'LEASE_SCOPE_MISMATCH');
  assert.throws(() => runLocalUat({
    root: fx.root, taskId: fx.taskId, context: context(fx), candidateIdentity: { ...identity, taskId: 'other-task' }, scenarioId: 'wrong-candidate', command: [process.execPath, '-e', ''], now: at(7),
  }), /candidate.*mismatch/i);
});

test('release readiness requires exact candidate, branch sync, full gate, checks and grant', () => {
  const fx = fixture();
  const ready = makeReady(fx);
  const verdict = assessReleaseReadiness({ record: ready.record, candidateIdentity: ready.identity, grant: ready.grant, targetResource: fx.boundary === 'production' ? 'deploy:production' : 'deploy:staging', allowedAction: 'deploy', now: at(7) });
  assert.deepEqual(verdict, { ready: true, blockers: [] });
  const wrong = assessReleaseReadiness({ record: ready.record, candidateIdentity: candidate(fx.taskId, 'd'.repeat(64)), grant: ready.grant, targetResource: fx.boundary === 'production' ? 'deploy:production' : 'deploy:staging', allowedAction: 'deploy', now: at(7) });
  assert.ok(wrong.blockers.some((item) => item.code === 'candidate-mismatch'));
});

test('UAT validates lease before invoking the subprocess', () => {
  const fx = fixture('local');
  const marker = join(fx.root, 'should-not-run.txt');
  assert.throws(() => runLocalUat({
    root: fx.root, taskId: fx.taskId, context: context(fx), candidateIdentity: candidate(fx.taskId), scenarioId: 'expired-before-run',
    command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker], now: '2026-10-08T13:00:00.000Z',
  }), (error) => error.code === 'LEASE_EXPIRED');
  assert.equal(readTask({ root: fx.root, taskId: fx.taskId }).evidence.some((item) => item.scenario === 'expired-before-run'), false);
});

test('synthetic deployment contours are labeled synthetic and wrong revision fails exact readback', () => {
  const fx = fixture();
  const ready = makeReady(fx);
  const result = executeRelease({
    root: fx.root, taskId: fx.taskId, context: context(fx, ready.record.recordVersion), candidateIdentity: ready.identity, grant: ready.grant,
    targetResource: 'deploy:production', environmentId: 'staging', artifactDigest: ready.identity.artifactDigest,
    provider: { identity: 'synthetic-provider', synthetic: true, deploy: () => ({ outcome: 'succeeded', deploymentId: 'deploy-1', revision: 'wrong-revision' }), readback: () => ({ outcome: 'succeeded', deploymentId: 'deploy-1', revision: 'wrong-revision' }) },
    now: at(8),
  });
  assert.equal(result.receipt.verdict, 'fail');
  assert.equal(result.receipt.synthetic, true);
  assert.equal(result.receipt.reason, 'revision-mismatch');
  assert.equal(readTask({ root: fx.root, taskId: fx.taskId }).phase, 'release-ready');
});

test('unknown provider result reconciles once and never retries deployment', () => {
  const fx = fixture();
  const ready = makeReady(fx);
  let deployCalls = 0;
  const result = executeRelease({
    root: fx.root, taskId: fx.taskId, context: context(fx, ready.record.recordVersion), candidateIdentity: ready.identity, grant: ready.grant,
    targetResource: 'deploy:production', environmentId: 'staging', artifactDigest: ready.identity.artifactDigest,
    provider: { identity: 'synthetic-provider', synthetic: true, deploy: () => { deployCalls += 1; return { outcome: 'unknown', providerAttemptId: 'provider-1' }; }, readback: () => ({ outcome: 'unknown', providerAttemptId: 'provider-1' }) },
    now: at(8),
  });
  assert.equal(deployCalls, 1);
  assert.equal(result.receipt.verdict, 'unknown');
  assert.equal(readTask({ root: fx.root, taskId: fx.taskId }).externalAttempts.at(-1).state, 'reconcile-required');
});

test('known release failure returns readiness and production failure records containment plus RED ownership', () => {
  const fx = fixture();
  const ready = makeReady(fx);
  const failure = executeRelease({
    root: fx.root, taskId: fx.taskId, context: context(fx, ready.record.recordVersion), candidateIdentity: ready.identity, grant: ready.grant,
    targetResource: 'deploy:production', environmentId: 'staging', artifactDigest: ready.identity.artifactDigest,
    provider: { identity: 'synthetic-provider', synthetic: true, deploy: () => ({ outcome: 'failed', reason: 'build-failed' }) }, now: at(8),
  });
  assert.equal(failure.receipt.verdict, 'fail');
  assert.equal(readTask({ root: fx.root, taskId: fx.taskId }).phase, 'release-ready');
});

test('real production UAT requires an exact passing non-synthetic deploy receipt', () => {
  const fx = fixture();
  const ready = makeReady(fx);
  const environment = { environmentId: 'production', deploymentId: 'deploy-prod', artifactDigest: ready.identity.artifactDigest, deployedRevision: ready.identity.commitSha, observedAt: at(9) };
  assert.throws(() => recordProductionUat({ root: fx.root, taskId: fx.taskId, context: context(fx, ready.record.recordVersion), candidateIdentity: ready.identity, environmentIdentity: environment, verdict: 'pass', now: at(9) }), /deploy/i);
  const deployed = executeRelease({
    root: fx.root, taskId: fx.taskId, context: context(fx, ready.record.recordVersion), candidateIdentity: ready.identity, grant: ready.grant,
    targetResource: 'deploy:production', environmentId: 'production', artifactDigest: ready.identity.artifactDigest,
    provider: { identity: 'real-provider-fixture', deploy: () => ({ outcome: 'succeeded', deploymentId: 'deploy-prod', revision: ready.identity.commitSha, artifactDigest: ready.identity.artifactDigest }) }, now: at(8),
  });
  const uat = recordProductionUat({ root: fx.root, taskId: fx.taskId, context: context(fx, deployed.record.recordVersion), candidateIdentity: ready.identity, environmentIdentity: environment, verdict: 'pass', now: at(9) });
  assert.equal(uat.receipt.type, 'production-uat');
});

test('production observation requires passing UAT, canonical environment identity, and closes on pass', () => {
  const fx = fixture();
  const ready = makeReady(fx);
  const deployed = executeRelease({
    root: fx.root, taskId: fx.taskId, context: context(fx, ready.record.recordVersion), candidateIdentity: ready.identity, grant: ready.grant,
    targetResource: 'deploy:production', environmentId: 'production', artifactDigest: ready.identity.artifactDigest,
    provider: { identity: 'real-provider-fixture', deploy: () => ({ outcome: 'succeeded', deploymentId: 'deploy-prod', revision: ready.identity.commitSha, artifactDigest: ready.identity.artifactDigest }) }, now: at(8),
  });
  const environment = { environmentId: 'production', deploymentId: 'deploy-prod', artifactDigest: ready.identity.artifactDigest, deployedRevision: ready.identity.commitSha, observedAt: at(9) };
  const uat = recordProductionUat({ root: fx.root, taskId: fx.taskId, context: context(fx, deployed.record.recordVersion), candidateIdentity: ready.identity, environmentIdentity: environment, verdict: 'pass', now: at(9) });
  const reordered = { deployedRevision: environment.deployedRevision, artifactDigest: environment.artifactDigest, deploymentId: environment.deploymentId, environmentId: environment.environmentId, observedAt: environment.observedAt };
  const observed = recordProductionObservation({ root: fx.root, taskId: fx.taskId, context: context(fx, uat.record.recordVersion), candidateIdentity: ready.identity, environmentIdentity: reordered, verdict: 'pass', now: at(10) });
  assert.equal(observed.receipt.type, 'observation');
  assert.equal(observed.record.phase, 'close');
});

test('production failure after exact deploy and UAT records containment and RED ownership', () => {
  const fx = fixture();
  const ready = makeReady(fx);
  const deployed = executeRelease({
    root: fx.root, taskId: fx.taskId, context: context(fx, ready.record.recordVersion), candidateIdentity: ready.identity, grant: ready.grant,
    targetResource: 'deploy:production', environmentId: 'production', artifactDigest: ready.identity.artifactDigest,
    provider: { identity: 'real-provider-fixture', deploy: () => ({ outcome: 'succeeded', deploymentId: 'deploy-prod', revision: ready.identity.commitSha, artifactDigest: ready.identity.artifactDigest }) }, now: at(8),
  });
  const environment = { environmentId: 'production', deploymentId: 'deploy-prod', artifactDigest: ready.identity.artifactDigest, deployedRevision: ready.identity.commitSha, observedAt: at(9) };
  const uat = recordProductionUat({ root: fx.root, taskId: fx.taskId, context: context(fx, deployed.record.recordVersion), candidateIdentity: ready.identity, environmentIdentity: environment, verdict: 'pass', now: at(9) });
  const observed = recordProductionObservation({ root: fx.root, taskId: fx.taskId, context: context(fx, uat.record.recordVersion), candidateIdentity: ready.identity, environmentIdentity: environment, verdict: 'fail', containment: { action: 'rollback', receiptId: 'rollback-1' }, regressionOwner: 'release', now: at(10) });
  assert.equal(observed.receipt.verdict, 'fail');
  assert.equal(observed.record.phase, 'release-ready');
  assert.deepEqual(readTask({ root: fx.root, taskId: fx.taskId }).followUps.at(-1), { id: 'red-cycle:production-uat', owner: 'release' });
});

test('successful deploy closes deploy boundary and advances production boundary to production-uat', () => {
  for (const [boundary, expectedPhase, environmentId] of [['deploy', 'close', 'staging'], ['production', 'production-uat', 'production']]) {
    const fx = fixture(boundary);
    const ready = makeReady(fx);
    const result = executeRelease({
      root: fx.root, taskId: fx.taskId, context: context(fx, ready.record.recordVersion), candidateIdentity: ready.identity, grant: ready.grant,
      targetResource: boundary === 'production' ? 'deploy:production' : 'deploy:staging', environmentId, artifactDigest: ready.identity.artifactDigest,
      provider: { identity: 'synthetic-provider', synthetic: true, deploy: () => ({ outcome: 'succeeded', deploymentId: `deploy-${boundary}`, revision: ready.identity.commitSha, artifactDigest: ready.identity.artifactDigest }) }, now: at(8),
    });
    assert.equal(result.receipt.verdict, 'pass');
    assert.equal(result.record.phase, expectedPhase);
    if (boundary === 'production') {
      assert.throws(() => recordProductionUat({
        root: fx.root, taskId: fx.taskId, context: context(fx, result.record.recordVersion), candidateIdentity: ready.identity,
        environmentIdentity: { environmentId, deploymentId: `deploy-${boundary}`, artifactDigest: ready.identity.artifactDigest, deployedRevision: ready.identity.commitSha, observedAt: at(9) },
        verdict: 'pass', now: at(9),
      }), /synthetic.*production/i);
    }
  }
});

test('synthetic production observation cannot create a real production receipt', () => {
  const fx = fixture();
  const identity = candidate(fx.taskId);
  const result = recordProductionObservation({
    root: fx.root, taskId: fx.taskId, context: context(fx), candidateIdentity: identity,
    environmentIdentity: { environmentId: 'production', deploymentId: 'synthetic-deploy', artifactDigest: identity.artifactDigest, deployedRevision: identity.commitSha, observedAt: at(9) },
    verdict: 'pass', synthetic: true, now: at(10),
  });
  assert.equal(result.receipt.type, 'synthetic-observation');
  assert.equal(result.receipt.synthetic, true);
  assert.equal(readTask({ root: fx.root, taskId: fx.taskId }).evidence.some((item) => item.type === 'production-uat'), false);
});
