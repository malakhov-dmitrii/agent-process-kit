import { assessReceiptFreshness } from './evidence.mjs';
import { createCandidateIdentity } from './candidate.mjs';
import { mutateWithLease } from './leases.mjs';
import { StoreError, readTask } from './store.mjs';

const COMMON_RECEIPTS = ['code-review', 'local-uat', 'completion-records', 'final-report'];
const REVIEWED_RECEIPTS = ['spec-review', 'plan-review'];

export class EligibilityError extends StoreError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'EligibilityError';
  }
}

function activeUntil(value, now) {
  const end = Date.parse(value);
  const current = Date.parse(now);
  return Number.isNaN(end) || Number.isNaN(current) || end > current;
}

function receiptFreshness(receipt, candidateIdentity, environmentIdentity) {
  if (receipt?.verdict !== 'pass') return { status: 'failed', reason: `verdict-${receipt?.verdict ?? 'missing'}` };
  return assessReceiptFreshness({ receipt, candidateIdentity, environmentIdentity });
}

export function getEvidence({ record, candidateIdentity, environmentIdentity } = {}) {
  return (record?.evidence ?? []).map((receipt) => ({
    ...structuredClone(receipt),
    freshness: receiptFreshness(receipt, candidateIdentity, environmentIdentity),
  }));
}

function currentReceipt(record, type, candidateIdentity, environmentIdentity) {
  const receipts = (record.evidence ?? []).filter((receipt) => receipt.type === type);
  const current = receipts.find((receipt) => receiptFreshness(receipt, candidateIdentity, environmentIdentity).status === 'current');
  return { current, receipts };
}

function evidenceBlocker(record, type, candidateIdentity, environmentIdentity, ownerPhase = type) {
  const state = currentReceipt(record, type, candidateIdentity, environmentIdentity);
  if (state.current) return null;
  const stale = state.receipts.length > 0;
  return { code: stale ? `stale-${type}` : `missing-current-${type}`, ownerPhase };
}

function hasArtifact(record, type, generation) {
  return (record.artifacts ?? []).some((artifact) => artifact.type === type && artifact.generation === generation
    && typeof artifact.contentHash === 'string');
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  return left.taskId === right.taskId
    && left.specGeneration === right.specGeneration
    && left.planGeneration === right.planGeneration
    && left.contentFingerprint === right.contentFingerprint
    && (left.commitSha ?? null) === (right.commitSha ?? null)
    && (left.artifactDigest ?? null) === (right.artifactDigest ?? null);
}

function assertCandidateMatches(actual, supplied) {
  if (!supplied) return actual;
  if (actual.taskId !== supplied.taskId
      || actual.specGeneration !== supplied.specGeneration
      || actual.planGeneration !== supplied.planGeneration
      || actual.contentFingerprint !== supplied.contentFingerprint
      || (supplied.commitSha !== undefined && actual.commitSha !== supplied.commitSha)) {
    throw new EligibilityError('STALE_CANDIDATE', 'Supplied candidate identity is stale for the current worktree', {
      supplied,
      actual,
    });
  }
  return actual;
}

function sameGeneration(left, right) {
  return left?.taskId === right?.taskId
    && left?.specGeneration === right?.specGeneration
    && left?.planGeneration === right?.planGeneration;
}

function storyBlockers(record, candidateIdentity) {
  const blockers = [];
  const stories = record.storyGraph?.stories ?? [];
  for (const story of stories.filter((item) => item.required !== false)) {
    if (story.status !== 'integrated') {
      blockers.push({ code: 'required-story-incomplete', storyId: story.id, ownerPhase: 'implement' });
      continue;
    }
    if (story.integrationReceipt?.verdict !== 'pass'
        || !sameIdentity(story.integrationReceipt?.candidateIdentity, candidateIdentity)
        || !sameGeneration(story.result?.candidateIdentity, candidateIdentity)) {
      blockers.push({ code: 'stale-story-receipt', storyId: story.id, ownerPhase: 'implement' });
    }
  }
  return blockers;
}

function deliveryReceiptCurrent(record, type, candidateIdentity, environmentIdentity) {
  return currentReceipt(record, type, candidateIdentity, environmentIdentity).current !== undefined;
}

export function getDeliveryState({ record, candidateIdentity, environmentIdentity, now: _now = new Date().toISOString() }) {
  const local = deliveryReceiptCurrent(record, 'local-uat', candidateIdentity);
  const commit = deliveryReceiptCurrent(record, 'commit', candidateIdentity);
  const push = commit && deliveryReceiptCurrent(record, 'push', candidateIdentity);
  const deploy = push && deliveryReceiptCurrent(record, 'deploy', candidateIdentity, environmentIdentity);
  const production = deploy
    && deliveryReceiptCurrent(record, 'production-uat', candidateIdentity, environmentIdentity)
    && deliveryReceiptCurrent(record, 'observation', candidateIdentity, environmentIdentity);
  return { local, commit, push, deploy, production };
}

export function requiredEvidenceTypes(record) {
  const types = record.mode === 'quick'
    ? ['self-review', 'local-uat', 'completion-records', 'final-report']
    : [...REVIEWED_RECEIPTS, ...COMMON_RECEIPTS];
  if (['commit', 'push', 'deploy', 'production'].includes(record.requestedBoundary)) types.push('commit');
  if (['push', 'deploy', 'production'].includes(record.requestedBoundary)) types.push('push');
  if (['deploy', 'production'].includes(record.requestedBoundary)) types.push('deploy');
  if (record.requestedBoundary === 'production') types.push('production-uat', 'observation');
  return types;
}

function realPathSatisfied(record, candidateIdentity) {
  if (currentReceipt(record, 'local-uat', candidateIdentity).current) return true;
  if (record.mode !== 'quick') return false;
  const skip = currentReceipt(record, 'real-path-skip', candidateIdentity).current;
  return skip?.externallyObservable === false
    && ['pure-docs', 'internal-metadata'].includes(skip.changeKind)
    && typeof skip.reason === 'string' && skip.reason.trim() !== '';
}

export function canComplete({ record, candidateIdentity, environmentIdentity, now = new Date().toISOString() }) {
  const blockers = [];
  if (!record || record.status !== 'active') blockers.push({ code: 'task-not-active', ownerPhase: record?.phase ?? 'intake' });
  if (record?.phase !== 'close') blockers.push({ code: 'task-not-at-close', ownerPhase: record?.phase ?? 'intake' });
  if (!candidateIdentity || candidateIdentity.taskId !== record?.taskId
      || candidateIdentity.specGeneration !== record?.specGeneration
      || candidateIdentity.planGeneration !== record?.planGeneration) {
    blockers.push({ code: 'final-candidate-mismatch', ownerPhase: 'implement' });
  }

  if (record?.mode === 'quick') {
    if (!hasArtifact(record, 'compact-acceptance', record.specGeneration)) blockers.push({ code: 'missing-compact-acceptance', ownerPhase: 'intake' });
    const selfReview = evidenceBlocker(record, 'self-review', candidateIdentity, undefined, 'code-review');
    if (selfReview) blockers.push(selfReview);
  } else if (record) {
    if (!hasArtifact(record, 'frozen-spec', record.specGeneration)) blockers.push({ code: 'missing-frozen-spec', ownerPhase: 'spec-review' });
    if (!hasArtifact(record, 'frozen-plan', record.planGeneration)) blockers.push({ code: 'missing-frozen-plan', ownerPhase: 'plan-review' });
    for (const [type, phase] of [['spec-review', 'spec-review'], ['plan-review', 'plan-review']]) {
      const blocker = evidenceBlocker(record, type, candidateIdentity, undefined, phase);
      if (blocker) blockers.push(blocker);
    }
  }

  if (record && record.mode !== 'quick' && !record.storyGraph) {
    blockers.push({ code: 'missing-story-graph', ownerPhase: 'plan-review' });
  } else if (record) {
    blockers.push(...storyBlockers(record, candidateIdentity));
  }
  const codeReview = record ? currentReceipt(record, 'code-review', candidateIdentity).current : undefined;
  if (!codeReview) {
    const blocker = record ? evidenceBlocker(record, 'code-review', candidateIdentity, undefined, 'code-review') : null;
    if (blocker) blockers.push(blocker);
  } else if ((codeReview.blockingFindings ?? 0) > 0) {
    blockers.push({ code: 'blocking-code-review-finding', ownerPhase: 'code-review' });
  }

  if (record && !realPathSatisfied(record, candidateIdentity)) {
    const localReceipts = currentReceipt(record, 'local-uat', candidateIdentity).receipts;
    blockers.push({ code: localReceipts.length ? 'stale-local-uat' : 'missing-local-uat', ownerPhase: 'local-uat' });
  }

  const delivery = record ? getDeliveryState({ record, candidateIdentity, environmentIdentity, now }) : {
    local: false, commit: false, push: false, deploy: false, production: false,
  };
  if (record?.requestedBoundary === 'commit' && !delivery.commit) blockers.push({ code: 'missing-current-commit', ownerPhase: 'release' });
  if (record?.requestedBoundary === 'push' && !delivery.push) blockers.push({ code: 'missing-current-push', ownerPhase: 'release' });
  if (['deploy', 'production'].includes(record?.requestedBoundary) && !delivery.deploy) blockers.push({ code: 'missing-current-deploy', ownerPhase: 'release' });
  if (record?.requestedBoundary === 'production' && !delivery.production) {
    if (!deliveryReceiptCurrent(record, 'production-uat', candidateIdentity, environmentIdentity)) {
      blockers.push({ code: 'missing-current-production-uat', ownerPhase: 'production-uat' });
    }
    if (!deliveryReceiptCurrent(record, 'observation', candidateIdentity, environmentIdentity)) {
      blockers.push({ code: 'missing-current-observation', ownerPhase: 'observe' });
    }
  }

  if (record) {
    const activeLeases = (record.leases ?? []).filter((lease) => lease.revokedAt == null && activeUntil(lease.expiresAt, now));
    const canonical = activeLeases.filter((lease) => lease.scope === 'canonical');
    if (canonical.length !== 1) blockers.push({ code: canonical.length === 0 ? 'missing-integration-lease' : 'multiple-integration-leases', ownerPhase: 'close' });
    for (const lease of activeLeases.filter((item) => item.scope !== 'canonical')) {
      blockers.push({ code: 'active-worker-lease', leaseId: lease.leaseId, ownerPhase: 'implement' });
    }
    for (const grant of (record.grants ?? []).filter((item) => item.revokedAt == null && activeUntil(item.expiresAt, now))) {
      blockers.push({ code: 'active-execution-grant', grantId: grant.grantId, ownerPhase: 'release-ready' });
    }
    for (const attempt of (record.externalAttempts ?? []).filter((item) => item.state !== 'reconciled')) {
      blockers.push({ code: 'unreconciled-external-attempt', attemptId: attempt.attemptId, ownerPhase: 'release' });
    }
    const completionRecords = evidenceBlocker(record, 'completion-records', candidateIdentity, undefined, 'close');
    if (completionRecords) blockers.push({
      ...completionRecords,
      code: completionRecords.code === 'missing-current-completion-records'
        ? 'missing-completion-records'
        : completionRecords.code,
    });
    const finalReport = evidenceBlocker(record, 'final-report', candidateIdentity, undefined, 'close');
    if (finalReport) blockers.push(finalReport);
    for (const followUp of record.followUps ?? []) {
      if (typeof followUp.owner !== 'string' || followUp.owner.trim() === '') {
        blockers.push({ code: 'ownerless-follow-up', followUpId: followUp.id ?? null, ownerPhase: 'close' });
      }
    }
    if ((record.pendingDecisions ?? []).length > 0) blockers.push({ code: 'pending-operator-decision', ownerPhase: 'clarify' });
  }

  return { eligible: blockers.length === 0, blockers };
}

export function canAdvance({ record, targetPhase, candidateIdentity, environmentIdentity, now = new Date().toISOString() }) {
  const requirements = {
    'plan-draft': [['spec-review', 'spec-review']],
    implement: [['plan-review', 'plan-review']],
    'local-uat': [['code-review', 'code-review']],
    'release-ready': [['local-uat', 'local-uat']],
    'production-uat': [['deploy', 'release']],
    observe: [['production-uat', 'production-uat']],
  };
  const blockers = [];
  for (const [type, ownerPhase] of requirements[targetPhase] ?? []) {
    const blocker = evidenceBlocker(record, type, candidateIdentity,
      ['deploy', 'production-uat', 'observation'].includes(type) ? environmentIdentity : undefined, ownerPhase);
    if (blocker) blockers.push(blocker);
    else if (type.endsWith('review')) {
      const review = currentReceipt(record, type, candidateIdentity).current;
      if ((review.blockingFindings ?? 0) > 0) blockers.push({ code: `blocking-${type}-finding`, ownerPhase });
    }
  }
  if (targetPhase === 'code-review') {
    if (record.mode !== 'quick' && !record.storyGraph) blockers.push({ code: 'missing-story-graph', ownerPhase: 'plan-review' });
    else blockers.push(...storyBlockers(record, candidateIdentity));
  }
  if (targetPhase === 'close') {
    const delivery = getDeliveryState({ record, candidateIdentity, environmentIdentity, now });
    if (!delivery[record.requestedBoundary]) blockers.push({ code: `missing-current-${record.requestedBoundary}`, ownerPhase: record.phase });
  }
  return { allowed: blockers.length === 0, blockers };
}

export function completeTask({ root, taskId, context, candidateIdentity, environmentIdentity, worktree, recomputeCandidate, now = new Date().toISOString() }) {
  let verdict;
  let actualCandidate = candidateIdentity;
  if (typeof recomputeCandidate === 'function') {
    actualCandidate = assertCandidateMatches(recomputeCandidate(), candidateIdentity);
  } else if (worktree !== undefined) {
    const current = readTask({ root, taskId });
    actualCandidate = assertCandidateMatches(createCandidateIdentity({
      repoPath: worktree,
      taskId,
      specGeneration: current.specGeneration,
      planGeneration: current.planGeneration,
    }), candidateIdentity);
  } else {
    throw new EligibilityError('CANDIDATE_RECOMPUTATION_REQUIRED', 'Completion requires a trusted candidate recomputation callback or worktree path');
  }
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      verdict = canComplete({ record: current, candidateIdentity: actualCandidate, environmentIdentity, now });
      if (!verdict.eligible) throw new EligibilityError('TASK_INELIGIBLE', 'Task completion requirements are not satisfied', { blockers: verdict.blockers });
      return {
        ...current,
        status: 'complete',
        completedAt: now,
        leases: current.leases.map((lease) => lease.leaseId === context.leaseId
          ? { ...lease, revokedAt: now, revokeReason: 'task-complete' }
          : lease),
      };
    },
  });
  return { verdict, record };
}
