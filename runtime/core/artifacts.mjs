import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  StoreError,
  artifactRootPath,
  assertSafePath,
  atomicWriteJson,
  compareAndSwapTask,
  ensurePrivateDirectory,
  readTask,
} from './store.mjs';

const ARTIFACT_TYPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StoreError('INVALID_ARTIFACT', 'Artifact data cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new StoreError('INVALID_ARTIFACT', `Artifact data cannot contain ${typeof value}`);
  if (seen.has(value)) throw new StoreError('INVALID_ARTIFACT', 'Artifact data cannot contain cycles');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonical(item, seen)).join(',')}]`;
  } else {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`);
    result = `{${entries.join(',')}}`;
  }
  seen.delete(value);
  return result;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('INVALID_ARTIFACT', `${label} must be an object`);
  }
  return value;
}

function validateType(type) {
  if (typeof type !== 'string' || !ARTIFACT_TYPE.test(type)) {
    throw new StoreError('INVALID_ARTIFACT_TYPE', `Invalid artifact type ${type}`);
  }
  return type;
}

function identityMaterial({ taskId, type, generation, payload, producer, createdAt, sourceInputs, candidateIdentity, environmentIdentity }) {
  return {
    taskId,
    type,
    generation,
    payload,
    producer,
    createdAt,
    sourceInputs,
    candidateIdentity: candidateIdentity ?? null,
    environmentIdentity: environmentIdentity ?? null,
  };
}

function digestFor(input) {
  return sha256(canonical(identityMaterial(input)));
}

export function artifactPath(root, taskId, artifact) {
  const type = validateType(artifact?.type);
  if (typeof artifact?.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.contentHash)) {
    throw new StoreError('INVALID_ARTIFACT', 'Artifact contentHash must be a SHA-256 digest');
  }
  return join(artifactRootPath(root, taskId), type, `${artifact.contentHash}.json`);
}

export function stageArtifact({
  root,
  taskId,
  type,
  generation,
  payload,
  producer,
  sourceInputs,
  candidateIdentity,
  environmentIdentity,
  now = new Date().toISOString(),
}) {
  readTask({ root, taskId });
  validateType(type);
  if (!Number.isInteger(generation) || generation < 0) throw new StoreError('INVALID_ARTIFACT', 'generation must be a non-negative integer');
  plainObject(producer, 'producer');
  if (!Array.isArray(sourceInputs)) throw new StoreError('INVALID_ARTIFACT', 'sourceInputs must be an array');
  if (candidateIdentity !== undefined) plainObject(candidateIdentity, 'candidateIdentity');
  if (environmentIdentity !== undefined) plainObject(environmentIdentity, 'environmentIdentity');
  const material = { taskId, type, generation, payload, producer, createdAt: now, sourceInputs, candidateIdentity, environmentIdentity };
  const contentHash = digestFor(material);
  const artifact = {
    artifactId: `${type}:${contentHash}`,
    taskId,
    type,
    generation,
    contentHash,
    producer,
    createdAt: now,
    sourceInputs,
    ...(candidateIdentity === undefined ? {} : { candidateIdentity }),
    ...(environmentIdentity === undefined ? {} : { environmentIdentity }),
  };
  const path = artifactPath(root, taskId, artifact);
  ensurePrivateDirectory(join(artifactRootPath(root, taskId), type), 'artifact type directory');
  if (existsSync(path)) {
    const existing = readArtifact({ root, taskId, artifact });
    if (canonical(existing.artifact) !== canonical(artifact) || canonical(existing.payload) !== canonical(payload)) {
      throw new StoreError('ARTIFACT_COLLISION', `Artifact ${artifact.artifactId} already exists with different bytes`);
    }
    return existing.artifact;
  }
  atomicWriteJson(path, { schemaVersion: 1, artifact, payload });
  return artifact;
}

export function readArtifact({ root, taskId, artifact }) {
  const path = artifactPath(root, taskId, artifact);
  if (!existsSync(path)) throw new StoreError('ARTIFACT_NOT_FOUND', `Artifact ${artifact.artifactId} does not exist`, { path });
  assertSafePath(path, { allowMissing: false, directory: false, label: 'artifact file' });
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StoreError('ARTIFACT_CORRUPT', `Artifact ${artifact.artifactId} is not valid JSON`, { path }, error);
  }
  const stored = plainObject(envelope?.artifact, 'stored artifact');
  const actualHash = digestFor({
    taskId: stored.taskId,
    type: stored.type,
    generation: stored.generation,
    payload: envelope.payload,
    producer: stored.producer,
    createdAt: stored.createdAt,
    sourceInputs: stored.sourceInputs,
    candidateIdentity: stored.candidateIdentity,
    environmentIdentity: stored.environmentIdentity,
  });
  if (stored.taskId !== taskId || stored.artifactId !== artifact.artifactId
      || stored.contentHash !== artifact.contentHash || actualHash !== stored.contentHash) {
    throw new StoreError('ARTIFACT_DIGEST_MISMATCH', `Artifact ${artifact.artifactId} failed digest readback`, {
      expected: artifact.contentHash,
      stored: stored.contentHash,
      actual: actualHash,
    });
  }
  return envelope;
}

export function attachArtifact({ root, taskId, expectedRecordVersion, artifact, now }) {
  readArtifact({ root, taskId, artifact });
  return compareAndSwapTask({
    root,
    taskId,
    expectedRecordVersion,
    now,
    mutate: (record) => {
      if (record.artifacts.some((item) => item.artifactId === artifact.artifactId)) {
        throw new StoreError('ARTIFACT_ALREADY_ATTACHED', `Artifact ${artifact.artifactId} is already attached`);
      }
      return { ...record, artifacts: [...record.artifacts, artifact] };
    },
  });
}

export function recordArtifact(input) {
  const artifact = stageArtifact(input);
  const record = attachArtifact({
    root: input.root,
    taskId: input.taskId,
    expectedRecordVersion: input.expectedRecordVersion,
    artifact,
    now: input.now,
  });
  return { artifact, record };
}
