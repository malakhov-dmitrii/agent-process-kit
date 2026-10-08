import { randomUUID } from 'node:crypto';

import { validateMutationContext } from './schema.mjs';
import { StoreError, compareAndSwapTask } from './store.mjs';

const LEASE_SCOPE = /^(canonical|story:[A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;
const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export class LeaseError extends StoreError {
  constructor(code, message, details = {}, cause) {
    super(code, message, details, cause);
    this.name = 'LeaseError';
  }
}

function nonEmpty(value, field, pattern) {
  if (typeof value !== 'string' || value.trim() === '' || (pattern && !pattern.test(value))) {
    throw new LeaseError('INVALID_LEASE', `${field} is invalid`, { field, value });
  }
  return value;
}

function scope(value) {
  return nonEmpty(value, 'scope', LEASE_SCOPE);
}

function instant(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new LeaseError('INVALID_LEASE_TIME', `${field} must be an ISO timestamp`, { field, value });
  }
  return Date.parse(value);
}

function validateWindow({ now, renewBefore, expiresAt }) {
  const current = instant(now, 'now');
  const renew = instant(renewBefore, 'renewBefore');
  const expires = instant(expiresAt, 'expiresAt');
  if (!(current < renew && renew < expires)) {
    throw new LeaseError('INVALID_LEASE_TIME', 'Lease time must satisfy now < renewBefore < expiresAt', {
      now, renewBefore, expiresAt,
    });
  }
}

function isActive(lease, now) {
  return lease.revokedAt == null && instant(lease.expiresAt, 'lease.expiresAt') > instant(now, 'now');
}

export function currentFence(record, leaseScope) {
  const target = scope(leaseScope);
  return record.leases
    .filter((lease) => lease.scope === target)
    .reduce((maximum, lease) => Math.max(maximum, lease.fenceToken), 0);
}

function leaseById(record, leaseId) {
  return record.leases.find((lease) => lease.leaseId === leaseId);
}

export function assertMutationLease(record, context, { now = new Date().toISOString(), requiredScope } = {}) {
  try {
    validateMutationContext(context);
  } catch (error) {
    throw new LeaseError('INVALID_MUTATION_CONTEXT', error.message, {}, error);
  }
  scope(context.leaseScope);
  if (requiredScope !== undefined && context.leaseScope !== requiredScope) {
    throw new LeaseError('LEASE_SCOPE_MISMATCH', `Mutation requires ${requiredScope}, received ${context.leaseScope}`);
  }
  const lease = leaseById(record, context.leaseId);
  if (!lease) throw new LeaseError('LEASE_NOT_FOUND', `Lease ${context.leaseId} is not recorded`);
  if (lease.scope !== context.leaseScope) {
    throw new LeaseError('LEASE_SCOPE_MISMATCH', `Lease ${context.leaseId} owns ${lease.scope}, not ${context.leaseScope}`);
  }
  const latestFence = currentFence(record, context.leaseScope);
  if (context.fenceToken !== latestFence || lease.fenceToken !== context.fenceToken) {
    throw new LeaseError('STALE_FENCE', `Fence ${context.fenceToken} is stale; current fence is ${latestFence}`, {
      supplied: context.fenceToken,
      current: latestFence,
    });
  }
  if (lease.revokedAt != null) {
    throw new LeaseError('LEASE_REVOKED', `Lease ${lease.leaseId} was revoked at ${lease.revokedAt}`, { lease });
  }
  if (!isActive(lease, now)) {
    throw new LeaseError('LEASE_EXPIRED', `Lease ${lease.leaseId} expired at ${lease.expiresAt}`, { lease, now });
  }
  if (lease.generation?.specGeneration !== context.specGeneration
      || lease.generation?.planGeneration !== context.planGeneration) {
    throw new LeaseError('STALE_LEASE_GENERATION', 'Lease generation does not match the mutation context', {
      leaseGeneration: lease.generation,
      contextGeneration: { specGeneration: context.specGeneration, planGeneration: context.planGeneration },
    });
  }
  if (record.specGeneration !== context.specGeneration || record.planGeneration !== context.planGeneration) {
    throw new LeaseError('STALE_GENERATION', 'Mutation context does not match current spec/plan generation', {
      supplied: { specGeneration: context.specGeneration, planGeneration: context.planGeneration },
      current: { specGeneration: record.specGeneration, planGeneration: record.planGeneration },
    });
  }
  return lease;
}

export function acquireLease({
  root,
  taskId,
  scope: leaseScope,
  ownerHost,
  ownerSession,
  expectedRecordVersion,
  expectedFence,
  renewBefore,
  expiresAt,
  now = new Date().toISOString(),
  leaseId = randomUUID(),
}) {
  const targetScope = scope(leaseScope);
  nonEmpty(ownerHost, 'ownerHost');
  nonEmpty(ownerSession, 'ownerSession');
  nonEmpty(leaseId, 'leaseId', LEASE_ID);
  if (!Number.isInteger(expectedFence) || expectedFence < 0) {
    throw new LeaseError('INVALID_LEASE', 'expectedFence must be a non-negative integer');
  }
  validateWindow({ now, renewBefore, expiresAt });
  let created;
  const record = compareAndSwapTask({
    root,
    taskId,
    expectedRecordVersion,
    now,
    mutate: (current) => {
      const appended = appendLeaseToRecord(current, {
        taskId,
        scope: targetScope,
        ownerHost,
        ownerSession,
        expectedFence,
        renewBefore,
        expiresAt,
        now,
        leaseId,
      });
      created = appended.lease;
      return appended.record;
    },
  });
  return { lease: created, record };
}

export function appendLeaseToRecord(record, {
  taskId,
  scope: leaseScope,
  ownerHost,
  ownerSession,
  expectedFence,
  renewBefore,
  expiresAt,
  now,
  leaseId = randomUUID(),
}) {
  const targetScope = scope(leaseScope);
  nonEmpty(ownerHost, 'ownerHost');
  nonEmpty(ownerSession, 'ownerSession');
  nonEmpty(leaseId, 'leaseId', LEASE_ID);
  if (record.taskId !== taskId) throw new LeaseError('LEASE_TASK_MISMATCH', `Lease task ${taskId} does not match ${record.taskId}`);
  if (!Number.isInteger(expectedFence) || expectedFence < 0) {
    throw new LeaseError('INVALID_LEASE', 'expectedFence must be a non-negative integer');
  }
  validateWindow({ now, renewBefore, expiresAt });
  if (record.leases.some((lease) => lease.leaseId === leaseId)) {
    throw new LeaseError('DUPLICATE_LEASE_ID', `Lease ${leaseId} already exists`);
  }
  const fence = currentFence(record, targetScope);
  if (fence !== expectedFence) {
    throw new LeaseError('STALE_FENCE', `Expected fence ${expectedFence}, current fence is ${fence}`, {
      expectedFence,
      currentFence: fence,
    });
  }
  const active = record.leases.find((lease) => lease.scope === targetScope && isActive(lease, now));
  if (active) {
    throw new LeaseError('LEASE_CONFLICT', `Scope ${targetScope} is owned by ${active.ownerSession}`, { active });
  }
  const lease = {
    leaseId,
    taskId,
    scope: targetScope,
    ownerHost,
    ownerSession,
    generation: {
      specGeneration: record.specGeneration,
      planGeneration: record.planGeneration,
    },
    fenceToken: fence + 1,
    acquiredAt: now,
    renewBefore,
    expiresAt,
    revokedAt: null,
  };
  return { lease, record: { ...record, leases: [...record.leases, lease] } };
}

export function mutateWithLease({ root, taskId, context, mutate, now = new Date().toISOString(), requiredScope }) {
  return compareAndSwapTask({
    root,
    taskId,
    expectedRecordVersion: context?.expectedRecordVersion,
    now,
    mutate: (record) => {
      assertMutationLease(record, context, { now, requiredScope });
      const candidate = mutate(record);
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
      const generationChanged = candidate.specGeneration !== record.specGeneration
        || candidate.planGeneration !== record.planGeneration;
      if (generationChanged && context.leaseScope !== 'canonical') {
        throw new LeaseError('LEASE_GENERATION_MUTATION_FORBIDDEN', 'Only the canonical owner may change spec or plan generation');
      }
      if (!Array.isArray(candidate.leases) || !candidate.leases.some((lease) => lease.leaseId === context.leaseId)) {
        throw new LeaseError('LEASE_REMOVED', `Mutation removed its owning lease ${context.leaseId}`);
      }
      if (!generationChanged) return candidate;
      return {
        ...candidate,
        leases: candidate.leases.map((lease) => lease.leaseId === context.leaseId
          ? { ...lease, generation: { specGeneration: candidate.specGeneration, planGeneration: candidate.planGeneration } }
          : lease),
      };
    },
  });
}

export function renewLease({ root, taskId, context, renewBefore, expiresAt, now = new Date().toISOString() }) {
  validateWindow({ now, renewBefore, expiresAt });
  let renewed;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    now,
    mutate: (current) => {
      const leases = current.leases.map((lease) => {
        if (lease.leaseId !== context.leaseId) return lease;
        renewed = { ...lease, renewBefore, expiresAt };
        return renewed;
      });
      return { ...current, leases };
    },
  });
  return { lease: renewed, record };
}

export function releaseLease({ root, taskId, context, reason, now = new Date().toISOString() }) {
  nonEmpty(reason, 'reason');
  let released;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    now,
    mutate: (current) => {
      const leases = current.leases.map((lease) => {
        if (lease.leaseId !== context.leaseId) return lease;
        released = { ...lease, revokedAt: now, revokeReason: reason };
        return released;
      });
      return { ...current, leases };
    },
  });
  return { lease: released, record };
}
