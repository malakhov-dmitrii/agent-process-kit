import { createCandidateIdentity } from '../core/candidate.mjs';
import { readArtifact, stageArtifact } from '../core/artifacts.mjs';
import { mutateWithLease } from '../core/leases.mjs';
import { getStatus } from '../core/status.mjs';
import { StoreError, readTask } from '../core/store.mjs';
import { resolveCurrentTask } from './sessions.mjs';

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token)/i;
const SECRET_TEXT = /(sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,})/g;

export class CheckpointError extends StoreError {
  constructor(code, message, details = {}, cause) {
    super(code, message, details, cause);
    this.name = 'CheckpointError';
  }
}

export function redactSecrets(value, key = '', seen = new Set()) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(SECRET_TEXT, '[REDACTED]');
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[REDACTED:CYCLE]';
  seen.add(value);
  let redacted;
  if (Array.isArray(value)) redacted = value.slice(0, 256).map((item) => redactSecrets(item, key, seen));
  else redacted = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSecrets(item, name, seen)]));
  seen.delete(value);
  return redacted;
}

function sameCandidate(left, right) {
  return left?.taskId === right?.taskId
    && left?.specGeneration === right?.specGeneration
    && left?.planGeneration === right?.planGeneration
    && left?.contentFingerprint === right?.contentFingerprint;
}

function exactBinding({ root, taskId, sessionId, workspace }) {
  const resolution = resolveCurrentTask({ root, sessionId, workspace });
  if (resolution.status !== 'exact' || resolution.taskId !== taskId) {
    throw new CheckpointError('CHECKPOINT_BINDING_NOT_EXACT', `Checkpoint requires exact binding for ${taskId}`, { resolution });
  }
  return resolution;
}

function eventEntry(record, eventId) {
  return (record.checkpointEvents ?? []).find((event) => event.eventId === eventId);
}

export function checkpointTask({
  root,
  taskId,
  context,
  host,
  sessionId,
  workspace,
  worktree = workspace,
  eventId,
  reason = 'checkpoint',
  now = new Date().toISOString(),
}) {
  if (!EVENT_ID.test(eventId ?? '')) throw new CheckpointError('INVALID_CHECKPOINT_EVENT', 'eventId is invalid');
  exactBinding({ root, taskId, sessionId, workspace });
  const current = readTask({ root, taskId });
  const duplicate = eventEntry(current, eventId);
  if (duplicate) {
    const artifact = current.artifacts.find((item) => item.artifactId === duplicate.artifactId);
    if (!artifact) throw new CheckpointError('CHECKPOINT_CORRUPT', `Checkpoint event ${eventId} has no artifact`);
    const envelope = readArtifact({ root, taskId, artifact });
    return { artifact, payload: envelope.payload, record: current, idempotent: true };
  }
  const candidateIdentity = createCandidateIdentity({
    repoPath: worktree,
    taskId,
    specGeneration: current.specGeneration,
    planGeneration: current.planGeneration,
  });
  const status = getStatus({ record: current, candidateIdentity, now });
  const checkpointGeneration = current.checkpointGeneration + 1;
  const payload = redactSecrets({
    schemaVersion: 1,
    eventId,
    reason,
    taskId,
    host,
    sessionId,
    status: current.status,
    phase: current.phase,
    specGeneration: current.specGeneration,
    planGeneration: current.planGeneration,
    checkpointGeneration,
    sourceRecordVersion: current.recordVersion,
    committedRecordVersion: current.recordVersion + 1,
    candidateIdentity,
    artifactManifest: current.artifacts,
    storyClaims: (current.storyGraph?.stories ?? []).filter((story) => story.claim).map((story) => ({ storyId: story.id, claim: story.claim })),
    activeLeases: current.leases.filter((lease) => lease.revokedAt == null),
    evidenceReceipts: current.evidence.map((receipt) => receipt.receiptId),
    pendingDecisions: current.pendingDecisions,
    blockers: status.completion.blockers,
    lastCompletedStep: current.lastTrace?.actual ?? null,
    lastTrace: current.lastTrace,
    nextSafeAction: current.lastTrace?.nextAction ?? 'inspect current phase',
    createdAt: now,
  });
  const artifact = stageArtifact({
    root,
    taskId,
    type: 'checkpoint',
    generation: checkpointGeneration,
    payload,
    producer: { kind: 'host-adapter', host, sessionId },
    sourceInputs: current.artifacts.map((item) => item.artifactId),
    candidateIdentity,
    now,
  });
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (recordBeforeCommit) => {
      if (eventEntry(recordBeforeCommit, eventId)) throw new CheckpointError('DUPLICATE_CHECKPOINT_RACE', `Event ${eventId} was committed concurrently`);
      return {
        ...recordBeforeCommit,
        checkpointGeneration,
        artifacts: [...recordBeforeCommit.artifacts, artifact],
        checkpointEvents: [...recordBeforeCommit.checkpointEvents, {
          eventId,
          artifactId: artifact.artifactId,
          checkpointGeneration,
          committedRecordVersion: recordBeforeCommit.recordVersion + 1,
        }].slice(-256),
      };
    },
  });
  return { artifact, payload, record, idempotent: false };
}

export function resumeFromCheckpoint({ root, taskId, checkpointArtifact, sessionId, workspace, worktree = workspace }) {
  exactBinding({ root, taskId, sessionId, workspace });
  const record = readTask({ root, taskId });
  const latest = record.checkpointEvents.at(-1);
  if (!latest || latest.artifactId !== checkpointArtifact?.artifactId) {
    throw new CheckpointError('CHECKPOINT_STALE', 'Checkpoint is not the canonical latest checkpoint');
  }
  const envelope = readArtifact({ root, taskId, artifact: checkpointArtifact });
  const payload = envelope.payload;
  if (payload.taskId !== taskId || payload.checkpointGeneration !== record.checkpointGeneration
      || payload.committedRecordVersion !== record.recordVersion) {
    throw new CheckpointError('CHECKPOINT_STATE_MISMATCH', 'Checkpoint generation or record version changed');
  }
  const currentCandidate = createCandidateIdentity({
    repoPath: worktree,
    taskId,
    specGeneration: record.specGeneration,
    planGeneration: record.planGeneration,
  });
  if (!sameCandidate(payload.candidateIdentity, currentCandidate)) {
    throw new CheckpointError('CHECKPOINT_CANDIDATE_MISMATCH', 'Working content changed after checkpoint');
  }
  for (const artifact of payload.artifactManifest) readArtifact({ root, taskId, artifact });
  return {
    taskId,
    checkpointGeneration: payload.checkpointGeneration,
    phase: payload.phase,
    status: payload.status,
    storyClaims: payload.storyClaims,
    pendingDecisions: payload.pendingDecisions,
    blockers: payload.blockers,
    nextSafeAction: payload.nextSafeAction,
    candidateIdentity: currentCandidate,
    artifact: checkpointArtifact,
  };
}
