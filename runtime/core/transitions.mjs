import { DELIVERY_BOUNDARIES, TASK_MODES, TASK_PHASES, TASK_STATUSES } from './schema.mjs';

const QUICK_SKIPPABLE_PHASES = new Set(['spec-draft', 'spec-review', 'plan-draft', 'plan-review']);
const PURE_NON_RUNTIME_CHANGES = new Set(['pure-docs', 'internal-metadata']);
const DIVERGENCE_OWNERS = new Set(['spec-draft', 'plan-draft']);
const RELEASE_READINESS_OWNERS = new Set([
  'spec-draft', 'spec-review', 'plan-draft', 'plan-review', 'implement', 'code-review', 'local-uat',
]);
const RECOVERY_OWNERS = new Set([
  'spec-draft', 'spec-review', 'plan-draft', 'plan-review', 'implement', 'code-review', 'local-uat',
  'release-ready', 'release', 'production-uat',
]);

export class TransitionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
    this.details = details;
  }
}

function statusError(from, event, facts) {
  throw new TransitionError(
    'INVALID_STATUS_TRANSITION',
    `Task status transition ${from}:${event} is not allowed or its recovery gate is incomplete`,
    { from, event, facts },
  );
}

function phaseError(from, event, facts) {
  throw new TransitionError(
    'INVALID_PHASE_TRANSITION',
    `Task phase transition ${from}:${event} is not allowed or its gate is incomplete`,
    { from, event, facts },
  );
}

function result(from, event, to, effects = []) {
  return { from, event, to, effects };
}

function required(value) {
  return value === true;
}

export function resolveTaskStatusTransition({ from, event, facts = {} }) {
  if (!TASK_STATUSES.includes(from) || typeof event !== 'string' || facts === null || typeof facts !== 'object') {
    return statusError(from, event, facts);
  }

  if (from === 'active' && event === 'pause') {
    return result(from, event, 'paused', ['revoke-execution-grants', 'revoke-active-leases']);
  }
  if (from === 'paused' && event === 'resume' && required(facts.recoverySatisfied)) {
    return result(from, event, 'active', ['revalidate-candidate-evidence-intent', 'acquire-new-lease']);
  }
  if (from === 'active' && event === 'park' && required(facts.noIndependentReadyLane)) {
    return result(from, event, 'parked', ['preserve-independent-work']);
  }
  if (from === 'parked' && event === 'decision-recorded' && required(facts.recoverySatisfied)) {
    return result(from, event, 'active', ['regenerate-if-decision-changed']);
  }
  if (from === 'active' && event === 'block' && required(facts.externalCondition)) {
    return result(from, event, 'blocked', ['record-blocking-receipt']);
  }
  if (from === 'blocked' && event === 'blocking-condition-changed' && required(facts.recoverySatisfied)) {
    return result(from, event, 'active', ['rerun-owning-gate']);
  }
  if (from === 'active' && event === 'cancel' && required(facts.containmentComplete)) {
    return result(from, event, 'cancelled', ['revoke-execution-grants', 'revoke-active-leases']);
  }
  if (from === 'active' && event === 'complete' && required(facts.completionEligible)) {
    return result(from, event, 'complete', ['retire-integration-lease']);
  }
  if (from === 'active' && event === 'accept-rollback' && required(facts.operatorAccepted) && required(facts.rollbackReceipt)) {
    return result(from, event, 'rolled-back', ['record-rollback-impact']);
  }
  return statusError(from, event, facts);
}

function validBoundary(value) {
  return DELIVERY_BOUNDARIES.includes(value);
}

function recoveryOwner(facts, allowed) {
  return typeof facts.ownerPhase === 'string' && allowed.has(facts.ownerPhase) ? facts.ownerPhase : null;
}

export function resolvePhaseTransition({ from, event, facts = {} }) {
  if (!TASK_PHASES.includes(from) || typeof event !== 'string' || facts === null || typeof facts !== 'object') {
    return phaseError(from, event, facts);
  }

  if (from === 'intake' && event === 'needs-clarification') return result(from, event, 'clarify');
  if (from === 'intake' && event === 'ambiguity-low' && typeof facts.recordedReason === 'string' && facts.recordedReason.trim()) {
    return result(from, event, 'spec-draft');
  }
  if (from === 'clarify' && event === 'decisions-ready') return result(from, event, 'spec-draft');
  if (from === 'spec-draft' && event === 'spec-observable') return result(from, event, 'spec-review');
  if (from === 'spec-review' && event === 'review-approved') return result(from, event, 'plan-draft', ['freeze-spec']);
  if (from === 'spec-review' && event === 'review-blocked') return result(from, event, 'spec-draft', ['increment-spec-generation']);
  if (from === 'plan-draft' && event === 'plan-complete') return result(from, event, 'plan-review');
  if (from === 'plan-review' && event === 'review-approved') return result(from, event, 'implement', ['freeze-plan']);
  if (from === 'plan-review' && event === 'review-blocked') return result(from, event, 'plan-draft', ['increment-plan-generation']);
  if (from === 'implement' && event === 'stories-integrated') return result(from, event, 'code-review');
  if (from === 'implement' && event === 'story-failed') return result(from, event, 'implement', ['return-story-to-red']);
  if (from === 'implement' && event === 'architecture-diverged') {
    const owner = recoveryOwner(facts, DIVERGENCE_OWNERS);
    if (owner) return result(from, event, owner, [owner === 'spec-draft' ? 'invalidate-affected-spec-evidence' : 'invalidate-affected-plan-evidence']);
  }
  if (from === 'code-review' && event === 'review-approved') return result(from, event, 'local-uat');
  if (from === 'code-review' && event === 'review-blocked') return result(from, event, 'implement', ['create-bounded-fix-stories']);
  if (from === 'local-uat' && event === 'uat-passed' && validBoundary(facts.requestedBoundary)) {
    return result(from, event, facts.requestedBoundary === 'local' ? 'close' : 'release-ready');
  }
  if (from === 'local-uat' && event === 'uat-defect') return result(from, event, 'implement', ['create-regression-story']);
  if (from === 'release-ready' && event === 'grant-ready' && required(facts.exactCandidateGrant)) {
    return result(from, event, 'release');
  }
  if (from === 'release-ready' && event === 'candidate-changed') {
    const owner = recoveryOwner(facts, RELEASE_READINESS_OWNERS);
    if (owner) return result(from, event, owner, ['invalidate-release-readiness']);
  }
  if (from === 'release' && event === 'release-confirmed'
      && validBoundary(facts.requestedBoundary) && facts.requestedBoundary !== 'local') {
    return result(from, event, facts.requestedBoundary === 'production' ? 'production-uat' : 'close');
  }
  if (from === 'release' && event === 'known-failure') return result(from, event, 'release-ready', ['record-release-failure']);
  if (from === 'release' && event === 'unknown-outcome') return result(from, event, 'release', ['require-reconciliation']);
  if (from === 'release' && event === 'containment-rework') return result(from, event, 'implement', ['contain-or-rollback']);
  if (from === 'production-uat' && event === 'uat-passed') return result(from, event, 'observe');
  if (from === 'production-uat' && event === 'uat-failed') return result(from, event, 'implement', ['contain-or-rollback', 'open-red-cycle']);
  if (from === 'observe' && event === 'observation-passed') return result(from, event, 'close');
  if (from === 'observe' && event === 'blocking-signal') {
    const owner = recoveryOwner(facts, RECOVERY_OWNERS);
    if (owner) return result(from, event, owner, ['contain-or-rollback']);
  }
  if (from === 'close' && event === 'receipt-stale') {
    const owner = recoveryOwner(facts, RECOVERY_OWNERS);
    if (owner) return result(from, event, owner, ['mark-receipt-stale']);
  }
  return phaseError(from, event, facts);
}

export function validatePhaseSkip({ mode, phase, reason, changeKind, externallyObservable }) {
  if (!TASK_MODES.includes(mode)) throw new TransitionError('INVALID_PHASE_SKIP', `Unknown mode ${mode}`);
  if (!TASK_PHASES.includes(phase)) throw new TransitionError('INVALID_PHASE_SKIP', `Unknown phase ${phase}`);
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new TransitionError('INVALID_PHASE_SKIP', `A recorded reason is required to skip ${phase}`);
  }
  if (phase === 'clarify') return { allowed: true, reason };
  if (mode !== 'quick') {
    throw new TransitionError('INVALID_PHASE_SKIP', `${mode} mode cannot skip ${phase}`);
  }
  if (QUICK_SKIPPABLE_PHASES.has(phase)) return { allowed: true, reason };
  if (phase === 'local-uat') {
    if (PURE_NON_RUNTIME_CHANGES.has(changeKind) && externallyObservable === false) return { allowed: true, reason };
    throw new TransitionError('INVALID_PHASE_SKIP', 'quick mode cannot skip the real-path check for externally observable behavior');
  }
  throw new TransitionError('INVALID_PHASE_SKIP', `quick mode cannot skip ${phase}`);
}
