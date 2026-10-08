import { randomUUID } from 'node:crypto';

import { assessGrantValidity, reconcileExternalAttempt, recordExternalAttempt } from '../core/grants.mjs';
import { assessReceiptFreshness } from '../core/evidence.mjs';
import { mutateWithLease } from '../core/leases.mjs';
import { readTask } from '../core/store.mjs';

function current(record, type, candidateIdentity) {
  return (record?.evidence ?? []).find((receipt) => receipt.type === type
    && receipt.verdict === 'pass'
    && assessReceiptFreshness({ receipt, candidateIdentity }).status === 'current');
}

function identityMatches(left, right) {
  return left?.taskId === right?.taskId
    && left?.specGeneration === right?.specGeneration
    && left?.planGeneration === right?.planGeneration
    && left?.contentFingerprint === right?.contentFingerprint
    && (left?.commitSha ?? null) === (right?.commitSha ?? null)
    && (left?.artifactDigest ?? null) === (right?.artifactDigest ?? null);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function environmentMatches(left, right) {
  if (!left || !right) return false;
  const fields = ['environmentId', 'deploymentId', 'artifactDigest', 'deployedRevision'];
  const select = (value) => Object.fromEntries(fields.map((field) => [field, value[field]]));
  return canonical(select(left)) === canonical(select(right));
}

function authorizedEnvironment(targetResource, readback, artifactDigest) {
  const target = typeof targetResource === 'string' && targetResource.startsWith('deploy:')
    ? targetResource.slice('deploy:'.length)
    : undefined;
  const reported = readback?.environmentId;
  if (reported !== undefined && target !== undefined && reported !== target) {
    const error = new Error('provider readback environment does not match authorized target');
    error.code = 'TARGET_ENVIRONMENT_MISMATCH';
    throw error;
  }
  return {
    environmentId: reported ?? target ?? 'unknown',
    deploymentId: readback?.deploymentId ?? null,
    artifactDigest: readback?.artifactDigest ?? artifactDigest ?? null,
    deployedRevision: readback?.revision ?? null,
    observedAt: readback?.observedAt ?? null,
  };
}

function assertCandidate(record, candidateIdentity) {
  if (candidateIdentity?.taskId !== record.taskId
      || candidateIdentity?.specGeneration !== record.specGeneration
      || candidateIdentity?.planGeneration !== record.planGeneration) {
    const error = new Error('candidate identity mismatch with current task');
    error.code = 'CANDIDATE_MISMATCH';
    throw error;
  }
}

export function assessReleaseReadiness({ record, candidateIdentity, grant, targetResource, allowedAction = 'deploy', now = new Date().toISOString() }) {
  const blockers = [];
  if (!record || record.phase !== 'release-ready') blockers.push({ code: 'task-not-release-ready' });
  const anchoredCandidate = (record?.evidence ?? []).find((receipt) => receipt.type === 'push' || receipt.type === 'full-gate')?.candidateIdentity;
  if (!candidateIdentity || !anchoredCandidate || !identityMatches(candidateIdentity, anchoredCandidate)) blockers.push({ code: 'candidate-mismatch' });
  const push = current(record, 'push', candidateIdentity);
  if (!push || push.targetBranch !== 'main' || push.branchSynchronized !== true || push.remoteRevision !== candidateIdentity?.commitSha) blockers.push({ code: 'missing-exact-branch-sync' });
  for (const type of ['full-gate', 'docs', 'migration', 'containment']) if (!current(record, type, candidateIdentity)) blockers.push({ code: `missing-${type}` });
  const validity = assessGrantValidity({ grant, record, candidateIdentity, targetResource, allowedAction, now });
  if (!validity.valid) blockers.push({ code: `grant-${validity.reason}` });
  return { ready: blockers.length === 0, blockers };
}

function releaseReceipt({ taskId, candidateIdentity, environmentIdentity, provider, verdict, startedAt, completedAt, ...extra }) {
  return {
    receiptId: `deploy:${randomUUID()}`,
    type: 'deploy',
    taskId,
    candidateIdentity: structuredClone(candidateIdentity),
    environmentIdentity: structuredClone(environmentIdentity),
    producer: { kind: 'release-adapter', id: provider.identity },
    scenario: 'deployment-readback',
    coverage: 'full-candidate',
    startedAt,
    completedAt,
    verdict,
    ...extra,
  };
}

function appendReceipt({ root, taskId, context, receipt, now, phase, followUp }) {
  return mutateWithLease({
    root, taskId, context, now, requiredScope: 'canonical',
    mutate: (current) => ({
      ...current,
      ...(phase ? { phase } : {}),
      evidence: [...current.evidence, receipt],
      ...(followUp ? { followUps: [...current.followUps, followUp] } : {}),
    }),
  });
}

/** Execute exactly one granted provider attempt, reconcile unknown results, and bind readback to the candidate. */
export function executeRelease({
  root, taskId, context, candidateIdentity, grant, targetResource, environmentId, artifactDigest, provider,
  now = new Date().toISOString(),
}) {
  const record = readTask({ root, taskId });
  assertCandidate(record, candidateIdentity);
  const readiness = assessReleaseReadiness({ record, candidateIdentity, grant, targetResource, now });
  if (!readiness.ready) return { readiness, receipt: null, record };
  // The caller supplied environment label is advisory. The grant target and provider
  // readback are the authority, so a caller cannot relabel staging as production.
  const prepared = recordExternalAttempt({
    root, taskId, context, grantId: grant.grantId, idempotencyKey: `deploy:${grant.grantId}`,
    intent: { allowedAction: 'deploy', targetResource, candidateIdentity }, now, attemptId: `attempt:${grant.grantId}`,
  });
  let outcome;
  try {
    outcome = provider.deploy();
  } catch (error) {
    outcome = { outcome: 'unknown', providerAttemptId: 'provider-throw', errorCode: error?.code ?? 'provider-error' };
  }
  if (!outcome || !['succeeded', 'failed', 'unknown'].includes(outcome.outcome)) outcome = { outcome: 'unknown', providerAttemptId: 'unreported' };
  let readback = outcome;
  if (outcome.outcome === 'unknown' && typeof provider.readback === 'function') readback = provider.readback(outcome);
  const reconciliation = reconcileExternalAttempt({
    root, taskId, context: { ...context, expectedRecordVersion: prepared.record.recordVersion }, attemptId: prepared.attempt.attemptId,
    receipt: { outcome: readback.outcome, providerIdentity: provider.identity, readback: structuredClone(readback) }, now,
  });
  const environmentIdentity = authorizedEnvironment(targetResource, readback, artifactDigest);
  const exact = readback.outcome === 'succeeded'
    && readback.revision === candidateIdentity.commitSha
    && (readback.artifactDigest ?? artifactDigest) === artifactDigest;
  const verdict = readback.outcome === 'unknown' ? 'unknown' : (readback.outcome === 'succeeded' && exact ? 'pass' : 'fail');
  const receipt = releaseReceipt({
    taskId, candidateIdentity, environmentIdentity,
    provider, verdict, startedAt: now, completedAt: now, synthetic: provider.synthetic === true,
    ...(verdict === 'fail' && readback.outcome === 'succeeded' && !exact ? { reason: 'revision-mismatch' } : {}),
    ...(verdict === 'fail' && readback.reason ? { reason: readback.reason } : {}),
  });
  const finalRecord = verdict === 'unknown'
    ? reconciliation.record
    : appendReceipt({ root, taskId, context: { ...context, expectedRecordVersion: reconciliation.record.recordVersion }, receipt, now, phase: verdict === 'pass' ? (record.requestedBoundary === 'production' ? 'production-uat' : 'close') : 'release-ready', followUp: verdict === 'fail' ? { id: 'release-failure', owner: 'release-adapter' } : undefined });
  return { readiness, attempt: reconciliation.attempt, receipt, record: finalRecord };
}

export function recordProductionUat({
  root, taskId, context, candidateIdentity, environmentIdentity, verdict, containment, regressionOwner = 'release-adapter', synthetic = false,
  now = new Date().toISOString(),
}) {
  const current = readTask({ root, taskId });
  assertCandidate(current, candidateIdentity);
  if (!synthetic && environmentIdentity?.environmentId === 'production'
      && (current.evidence ?? []).some((item) => item.type === 'deploy' && item.synthetic === true
        && item.environmentIdentity?.environmentId === 'production'
        && identityMatches(item.candidateIdentity, candidateIdentity))) {
    const error = new Error('synthetic deployment cannot create a real production UAT receipt');
    error.code = 'SYNTHETIC_PRODUCTION_FORBIDDEN';
    throw error;
  }
  if (!synthetic) {
    const deploy = (current.evidence ?? []).find((item) => item.type === 'deploy'
      && item.verdict === 'pass'
      && item.synthetic !== true
      && identityMatches(item.candidateIdentity, candidateIdentity)
      && environmentMatches(item.environmentIdentity, environmentIdentity));
    if (!deploy) {
      const error = new Error('current exact passing deploy is required before production UAT');
      error.code = 'DEPLOY_REQUIRED';
      throw error;
    }
  }
  const receipt = {
    receiptId: `production-uat:${randomUUID()}`,
    type: synthetic ? 'synthetic-production-uat' : 'production-uat',
    taskId,
    candidateIdentity: structuredClone(candidateIdentity),
    environmentIdentity: structuredClone(environmentIdentity),
    producer: { kind: 'production-uat', id: synthetic ? 'synthetic-fixture' : 'authenticated-readback' },
    scenario: 'authenticated-production-uat', coverage: 'full-candidate', startedAt: now, completedAt: now,
    verdict: verdict === 'pass' || verdict === 'fail' ? verdict : 'missing', synthetic,
    ...(containment ? { containment: structuredClone(containment) } : {}),
  };
  return {
    receipt,
    record: appendReceipt({
      root, taskId, context, receipt, now,
      phase: synthetic || verdict === 'fail' ? 'release-ready' : 'observe',
      followUp: verdict === 'fail' ? { id: 'red-cycle:production-uat', owner: regressionOwner } : undefined,
    }),
  };
}

export function recordProductionObservation({
  root, taskId, context, candidateIdentity, environmentIdentity, verdict, containment, regressionOwner = 'release-adapter', synthetic = false,
  now = new Date().toISOString(),
}) {
  const current = readTask({ root, taskId });
  assertCandidate(current, candidateIdentity);
  const matchingUat = (current.evidence ?? []).find((item) => item.type === 'production-uat'
    && item.synthetic !== true
    && item.verdict === 'pass'
    && identityMatches(item.candidateIdentity, candidateIdentity)
    && environmentMatches(item.environmentIdentity, environmentIdentity));
  if (!synthetic && !matchingUat) {
    const error = new Error('current exact production UAT is required before observation');
    error.code = 'PRODUCTION_UAT_REQUIRED';
    throw error;
  }
  const real = !synthetic && (verdict === 'pass' || verdict === 'fail');
  const receipt = {
    receiptId: `observation:${randomUUID()}`,
    type: synthetic ? 'synthetic-observation' : 'observation',
    taskId,
    candidateIdentity: structuredClone(candidateIdentity),
    environmentIdentity: structuredClone(environmentIdentity),
    producer: { kind: 'production-observer', id: synthetic ? 'synthetic-fixture' : 'authenticated-readback' },
    scenario: 'production-observation', coverage: 'full-candidate', startedAt: now, completedAt: now,
    verdict: real ? verdict : 'missing', synthetic,
    ...(containment ? { containment: structuredClone(containment) } : {}),
  };
  const record = appendReceipt({
    root, taskId, context, receipt, now,
    phase: synthetic || verdict === 'fail' ? 'release-ready' : 'close',
    followUp: verdict === 'fail' ? { id: 'red-cycle:production-uat', owner: regressionOwner } : undefined,
  });
  return { receipt, record };
}
