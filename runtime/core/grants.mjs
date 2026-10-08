import { randomUUID } from 'node:crypto';

import { mutateWithLease } from './leases.mjs';
import { DELIVERY_BOUNDARIES } from './schema.mjs';
import { StoreError } from './store.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const EXTERNAL_BOUNDARIES = DELIVERY_BOUNDARIES.filter((boundary) => boundary !== 'local');

export class GrantError extends StoreError {
  constructor(code, message, details = {}, cause) {
    super(code, message, details, cause);
    this.name = 'GrantError';
  }
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GrantError('INVALID_GRANT_INPUT', `${label} must be an object`);
  }
  return value;
}

function nonEmpty(value, label, pattern) {
  if (typeof value !== 'string' || value.trim() === '' || (pattern && !pattern.test(value))) {
    throw new GrantError('INVALID_GRANT_INPUT', `${label} is invalid`, { label, value });
  }
  return value;
}

function instant(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new GrantError('INVALID_GRANT_INPUT', `${label} must be an ISO timestamp`);
  }
  return Date.parse(value);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function same(left, right) {
  return stableJson(left) === stableJson(right);
}

export function recordAuthorizationIntent({
  root,
  taskId,
  context,
  operatorIdentity,
  deliveryBoundary,
  allowedAction,
  targetResource,
  constraints,
  now = new Date().toISOString(),
  intentId = randomUUID(),
}) {
  nonEmpty(intentId, 'intentId', SAFE_ID);
  nonEmpty(operatorIdentity, 'operatorIdentity');
  if (!EXTERNAL_BOUNDARIES.includes(deliveryBoundary)) {
    throw new GrantError('INVALID_GRANT_INPUT', `deliveryBoundary must be one of ${EXTERNAL_BOUNDARIES.join(', ')}`);
  }
  const expectedAction = deliveryBoundary === 'commit' || deliveryBoundary === 'push' ? deliveryBoundary : 'deploy';
  if (allowedAction !== undefined && allowedAction !== expectedAction) {
    throw new GrantError('BOUNDARY_ACTION_MISMATCH', `delivery boundary ${deliveryBoundary} requires ${expectedAction}`);
  }
  if (targetResource !== undefined) nonEmpty(targetResource, 'targetResource');
  object(constraints, 'constraints');
  instant(now, 'now');
  let intent;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      if (current.authorizationIntents.some((item) => item.intentId === intentId)) {
        throw new GrantError('DUPLICATE_INTENT_ID', `Intent ${intentId} already exists`);
      }
      if (current.requestedBoundary !== deliveryBoundary) {
        throw new GrantError('BOUNDARY_MISMATCH', `Task boundary is ${current.requestedBoundary}, not ${deliveryBoundary}`);
      }
      intent = {
        intentId,
        taskId,
        operatorIdentity,
        deliveryBoundary,
        ...(allowedAction === undefined ? {} : { allowedAction }),
        ...(targetResource === undefined ? {} : { targetResource }),
        constraints: structuredClone(constraints),
        recordedAt: now,
        revokedAt: null,
      };
      return { ...current, authorizationIntents: [...current.authorizationIntents, intent] };
    },
  });
  return { intent, record };
}

function validateCandidateForRecord(candidateIdentity, record) {
  object(candidateIdentity, 'candidateIdentity');
  if (candidateIdentity.taskId !== record.taskId
      || candidateIdentity.specGeneration !== record.specGeneration
      || candidateIdentity.planGeneration !== record.planGeneration
      || typeof candidateIdentity.contentFingerprint !== 'string') {
    throw new GrantError('CANDIDATE_MISMATCH', 'Candidate does not match the current task and generations');
  }
}

export function issueExecutionGrant({
  root,
  taskId,
  context,
  intentId,
  candidateIdentity,
  targetResource,
  allowedAction,
  granteeRole,
  expiresAt,
  maxUses,
  now = new Date().toISOString(),
  grantId = randomUUID(),
}) {
  nonEmpty(intentId, 'intentId', SAFE_ID);
  nonEmpty(grantId, 'grantId', SAFE_ID);
  nonEmpty(targetResource, 'targetResource');
  nonEmpty(allowedAction, 'allowedAction');
  nonEmpty(granteeRole, 'granteeRole');
  const issuedAt = instant(now, 'now');
  if (instant(expiresAt, 'expiresAt') <= issuedAt) throw new GrantError('INVALID_GRANT_INPUT', 'expiresAt must be after issuedAt');
  if (!Number.isInteger(maxUses) || maxUses < 1) throw new GrantError('INVALID_GRANT_INPUT', 'maxUses must be a positive integer');
  let grant;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      if (current.status !== 'active' || current.phase !== 'release-ready') {
        throw new GrantError('TASK_NOT_RELEASE_READY', `Task is ${current.status}/${current.phase}`);
      }
      if (current.grants.some((item) => item.grantId === grantId)) throw new GrantError('DUPLICATE_GRANT_ID', `Grant ${grantId} already exists`);
      const intent = current.authorizationIntents.find((item) => item.intentId === intentId);
      if (!intent || intent.revokedAt != null) throw new GrantError('INTENT_UNAVAILABLE', `Intent ${intentId} is not active`);
      if (intent.deliveryBoundary !== current.requestedBoundary) throw new GrantError('BOUNDARY_MISMATCH', 'Intent boundary is stale');
      const expectedAction = intent.deliveryBoundary === 'commit' || intent.deliveryBoundary === 'push' ? intent.deliveryBoundary : 'deploy';
      if (allowedAction !== expectedAction) throw new GrantError('BOUNDARY_ACTION_MISMATCH', `delivery boundary ${intent.deliveryBoundary} requires ${expectedAction}`);
      if (intent.allowedAction !== undefined && intent.allowedAction !== allowedAction) throw new GrantError('INTENT_ACTION_MISMATCH', 'Grant action does not match authorization intent');
      if (intent.targetResource !== undefined && intent.targetResource !== targetResource) throw new GrantError('INTENT_TARGET_MISMATCH', 'Grant target does not match authorization intent');
      validateCandidateForRecord(candidateIdentity, current);
      grant = {
        grantId,
        taskId,
        intentId,
        operatorIdentity: intent.operatorIdentity,
        granteeRole,
        allowedAction,
        targetResource,
        deliveryBoundary: intent.deliveryBoundary,
        specGeneration: current.specGeneration,
        planGeneration: current.planGeneration,
        candidateIdentity: structuredClone(candidateIdentity),
        constraints: structuredClone(intent.constraints),
        issuedAt: now,
        expiresAt,
        maxUses,
        uses: 0,
        revokedAt: null,
      };
      return { ...current, grants: [...current.grants, grant] };
    },
  });
  return { grant, record };
}

export function assessGrantValidity({ grant, record, candidateIdentity, targetResource, allowedAction, now = new Date().toISOString() }) {
  if (!grant || !record) return { valid: false, reason: 'grant-unavailable' };
  if (grant.taskId !== record.taskId) return { valid: false, reason: 'task-mismatch' };
  if (grant.revokedAt != null) return { valid: false, reason: 'revoked' };
  if (record.status !== 'active') return { valid: false, reason: `task-status-${record.status}` };
  if (grant.specGeneration !== record.specGeneration || grant.planGeneration !== record.planGeneration) {
    return { valid: false, reason: 'generation-mismatch' };
  }
  if (grant.allowedAction !== allowedAction) return { valid: false, reason: 'action-mismatch' };
  if (grant.targetResource !== targetResource) return { valid: false, reason: 'target-mismatch' };
  if (!same(grant.candidateIdentity, candidateIdentity)) return { valid: false, reason: 'candidate-mismatch' };
  if (instant(grant.expiresAt, 'grant.expiresAt') <= instant(now, 'now')) return { valid: false, reason: 'expired' };
  if (grant.uses >= grant.maxUses) return { valid: false, reason: 'exhausted' };
  return { valid: true, reason: 'valid' };
}

function revokeMatching(current, predicate, reason, now) {
  let changed = 0;
  const grants = current.grants.map((grant) => {
    if (grant.revokedAt != null || !predicate(grant)) return grant;
    changed += 1;
    return { ...grant, revokedAt: now, revokeReason: reason };
  });
  return { grants, changed };
}

export function invalidateExecutionGrants({ root, taskId, context, reason, now = new Date().toISOString() }) {
  nonEmpty(reason, 'reason');
  let changed = 0;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      const revoked = revokeMatching(current, () => true, reason, now);
      changed = revoked.changed;
      return { ...current, grants: revoked.grants };
    },
  });
  return { changed, record };
}

export function revokeGrant({ root, taskId, context, grantId, reason, now = new Date().toISOString() }) {
  nonEmpty(grantId, 'grantId', SAFE_ID);
  nonEmpty(reason, 'reason');
  let revokedGrant;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      const existing = current.grants.find((grant) => grant.grantId === grantId);
      if (!existing) throw new GrantError('GRANT_NOT_FOUND', `Grant ${grantId} does not exist`);
      if (existing.revokedAt != null) throw new GrantError('GRANT_ALREADY_REVOKED', `Grant ${grantId} is already revoked`);
      const revoked = revokeMatching(current, (grant) => grant.grantId === grantId, reason, now);
      revokedGrant = revoked.grants.find((grant) => grant.grantId === grantId);
      return { ...current, grants: revoked.grants };
    },
  });
  return { grant: revokedGrant, record };
}

export function getUnreconciledAttempts(record) {
  return record.externalAttempts
    .filter((attempt) => attempt.state === 'prepared' || attempt.state === 'reconcile-required')
    .map((attempt) => structuredClone(attempt));
}

export function recordExternalAttempt({
  root,
  taskId,
  context,
  grantId,
  idempotencyKey,
  intent,
  now = new Date().toISOString(),
  attemptId = randomUUID(),
}) {
  nonEmpty(grantId, 'grantId', SAFE_ID);
  nonEmpty(attemptId, 'attemptId', SAFE_ID);
  nonEmpty(idempotencyKey, 'idempotencyKey');
  object(intent, 'intent');
  nonEmpty(intent.allowedAction, 'intent.allowedAction');
  nonEmpty(intent.targetResource, 'intent.targetResource');
  object(intent.candidateIdentity, 'intent.candidateIdentity');
  let attempt;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      if (current.externalAttempts.some((item) => item.idempotencyKey === idempotencyKey)) {
        throw new GrantError('DUPLICATE_IDEMPOTENCY_KEY', `Idempotency key ${idempotencyKey} was already used`);
      }
      if (current.externalAttempts.some((item) => item.attemptId === attemptId)) {
        throw new GrantError('DUPLICATE_ATTEMPT_ID', `Attempt ${attemptId} already exists`);
      }
      const grant = current.grants.find((item) => item.grantId === grantId);
      if (!grant) throw new GrantError('GRANT_NOT_FOUND', `Grant ${grantId} does not exist`);
      if (current.externalAttempts.some((item) => (item.state === 'prepared' || item.state === 'reconcile-required')
          && item.intent?.allowedAction === intent.allowedAction
          && item.intent?.targetResource === intent.targetResource
          && same(item.intent?.candidateIdentity, intent.candidateIdentity))) {
        throw new GrantError('UNRESOLVED_EXTERNAL_ATTEMPT', 'An equivalent external attempt requires reconciliation first');
      }
      const validity = assessGrantValidity({
        grant,
        record: current,
        candidateIdentity: intent.candidateIdentity,
        targetResource: intent.targetResource,
        allowedAction: intent.allowedAction,
        now,
      });
      if (!validity.valid) throw new GrantError('GRANT_INVALID', `Grant ${grantId} is ${validity.reason}`, { reason: validity.reason });
      attempt = {
        attemptId,
        taskId,
        grantId,
        idempotencyKey,
        intent: structuredClone(intent),
        state: 'prepared',
        preparedAt: now,
        reconciliationHistory: [],
        result: null,
      };
      return {
        ...current,
        grants: current.grants.map((item) => item.grantId === grantId ? { ...item, uses: item.uses + 1 } : item),
        externalAttempts: [...current.externalAttempts, attempt],
      };
    },
  });
  return { attempt, record };
}

export function reconcileExternalAttempt({ root, taskId, context, attemptId, receipt, now = new Date().toISOString() }) {
  nonEmpty(attemptId, 'attemptId', SAFE_ID);
  object(receipt, 'receipt');
  if (!['unknown', 'succeeded', 'failed'].includes(receipt.outcome)) {
    throw new GrantError('INVALID_EXTERNAL_RECEIPT', 'receipt.outcome must be unknown, succeeded or failed');
  }
  nonEmpty(receipt.providerIdentity, 'receipt.providerIdentity');
  let reconciled;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      const existing = current.externalAttempts.find((attempt) => attempt.attemptId === attemptId);
      if (!existing) throw new GrantError('ATTEMPT_NOT_FOUND', `Attempt ${attemptId} does not exist`);
      if (existing.state === 'reconciled') throw new GrantError('ATTEMPT_ALREADY_RECONCILED', `Attempt ${attemptId} is already reconciled`);
      if (!['prepared', 'reconcile-required'].includes(existing.state)) {
        throw new GrantError('INVALID_ATTEMPT_STATE', `Attempt ${attemptId} is ${existing.state}`);
      }
      const history = [...existing.reconciliationHistory, { checkedAt: now, receipt: structuredClone(receipt) }];
      reconciled = receipt.outcome === 'unknown'
        ? { ...existing, state: 'reconcile-required', reconciliationHistory: history }
        : { ...existing, state: 'reconciled', reconciliationHistory: history, result: structuredClone(receipt), reconciledAt: now };
      return {
        ...current,
        externalAttempts: current.externalAttempts.map((attempt) => attempt.attemptId === attemptId ? reconciled : attempt),
      };
    },
  });
  return { attempt: reconciled, record };
}
