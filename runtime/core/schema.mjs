const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export const TASK_MODES = Object.freeze(['quick', 'standard', 'full-train']);
export const TASK_STATUSES = Object.freeze(['active', 'parked', 'blocked', 'paused', 'cancelled', 'complete', 'rolled-back']);
export const TASK_PHASES = Object.freeze([
  'intake',
  'clarify',
  'spec-draft',
  'spec-review',
  'plan-draft',
  'plan-review',
  'implement',
  'code-review',
  'local-uat',
  'release-ready',
  'release',
  'production-uat',
  'observe',
  'close',
]);
export const DELIVERY_BOUNDARIES = Object.freeze(['local', 'commit', 'push', 'deploy', 'production']);

export class ValidationError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
    this.field = field;
  }
}

function plainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(field, 'must be an object');
  }
  return value;
}

function string(value, field, { pattern, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new ValidationError(field, 'must be a non-empty string');
  }
  if (pattern && !pattern.test(value)) throw new ValidationError(field, 'has an invalid format');
  return value;
}

function enumeration(value, field, values) {
  if (!values.includes(value)) throw new ValidationError(field, `must be one of ${values.join(', ')}`);
  return value;
}

function nonNegativeInteger(value, field, { positive = false } = {}) {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0)) {
    throw new ValidationError(field, `must be ${positive ? 'a positive' : 'a non-negative'} integer`);
  }
  return value;
}

function timestamp(value, field) {
  string(value, field);
  if (Number.isNaN(Date.parse(value))) throw new ValidationError(field, 'must be an ISO timestamp');
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) throw new ValidationError(field, 'must be an array');
  return value;
}

export function assertTaskId(value, field = 'taskId') {
  return string(value, field, { pattern: TASK_ID });
}

export function validateStartTaskInput(input) {
  const value = plainObject(input, 'input');
  assertTaskId(value.taskId);
  string(value.request, 'request');
  enumeration(value.requestedBoundary ?? 'local', 'requestedBoundary', DELIVERY_BOUNDARIES);
  enumeration(value.mode ?? 'standard', 'mode', TASK_MODES);
  if (value.now !== undefined) timestamp(value.now, 'now');
  return input;
}

export function validateMutationContext(input) {
  const value = plainObject(input, 'mutationContext');
  string(value.leaseId, 'leaseId', { pattern: RECORD_ID });
  nonNegativeInteger(value.fenceToken, 'fenceToken', { positive: true });
  string(value.leaseScope, 'leaseScope');
  nonNegativeInteger(value.expectedRecordVersion, 'expectedRecordVersion');
  nonNegativeInteger(value.specGeneration, 'specGeneration');
  nonNegativeInteger(value.planGeneration, 'planGeneration');
  return input;
}

export function createInitialTaskRecord(input) {
  validateStartTaskInput(input);
  const now = input.now ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    recordVersion: 0,
    request: input.request,
    requestedBoundary: input.requestedBoundary ?? 'local',
    mode: input.mode ?? 'standard',
    status: 'active',
    phase: 'intake',
    specGeneration: 0,
    planGeneration: 0,
    checkpointGeneration: 0,
    checkpointEvents: [],
    artifacts: [],
    decisions: [],
    storyGraph: null,
    leases: [],
    evidence: [],
    authorizationIntents: [],
    grants: [],
    externalAttempts: [],
    pendingDecisions: [],
    followUps: [],
    lastTrace: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function validateTaskRecord(input) {
  const value = plainObject(input, 'taskRecord');
  if (value.schemaVersion !== 1) throw new ValidationError('schemaVersion', 'must equal 1');
  assertTaskId(value.taskId);
  nonNegativeInteger(value.recordVersion, 'recordVersion');
  string(value.request, 'request');
  enumeration(value.requestedBoundary, 'requestedBoundary', DELIVERY_BOUNDARIES);
  enumeration(value.mode, 'mode', TASK_MODES);
  enumeration(value.status, 'status', TASK_STATUSES);
  enumeration(value.phase, 'phase', TASK_PHASES);
  nonNegativeInteger(value.specGeneration, 'specGeneration');
  nonNegativeInteger(value.planGeneration, 'planGeneration');
  nonNegativeInteger(value.checkpointGeneration, 'checkpointGeneration');
  for (const field of ['artifacts', 'decisions', 'leases', 'evidence', 'authorizationIntents', 'grants', 'externalAttempts', 'pendingDecisions', 'followUps', 'checkpointEvents']) {
    array(value[field], field);
  }
  if (value.storyGraph !== null) plainObject(value.storyGraph, 'storyGraph');
  if (value.lastTrace !== null) plainObject(value.lastTrace, 'lastTrace');
  timestamp(value.createdAt, 'createdAt');
  timestamp(value.updatedAt, 'updatedAt');
  return input;
}
