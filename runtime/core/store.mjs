import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { assertTaskId, createInitialTaskRecord, validateTaskRecord } from './schema.mjs';

export class StoreError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
  }
}

function unsafe(message, details = {}) {
  throw new StoreError('UNSAFE_PATH', message, details);
}

function resolved(path, label) {
  if (typeof path !== 'string' || path.trim() === '') unsafe(`${label} must be a non-empty path`);
  return resolve(path);
}

export function getStateRoot(env = process.env) {
  return resolved(
    env.AGENT_PROCESS_KIT_STATE_DIR
      || env.AGENT_PROCESS_STATE_DIR
      || join(homedir(), '.agent-process-kit'),
    'state root',
  );
}

export function assertSafePath(path, { allowMissing = true, directory, label = 'path' } = {}) {
  const target = resolved(path, label);
  if (!existsSync(target)) {
    if (!allowMissing) unsafe(`${label} does not exist: ${target}`, { path: target });
    return target;
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) unsafe(`Refusing symlink ${label}: ${target}`, { path: target });
  if (directory === true && !stat.isDirectory()) unsafe(`${label} is not a directory: ${target}`, { path: target });
  if (directory === false && !stat.isFile()) unsafe(`${label} is not a regular file: ${target}`, { path: target });
  return target;
}

export function ensurePrivateDirectory(path, label = 'directory') {
  const target = assertSafePath(path, { label });
  mkdirSync(target, { recursive: true, mode: 0o700 });
  assertSafePath(target, { allowMissing: false, directory: true, label });
  chmodSync(target, 0o700);
  return target;
}

export function ensureStateRoot(root = getStateRoot()) {
  const target = ensurePrivateDirectory(root, 'state root');
  ensurePrivateDirectory(join(target, 'tasks'), 'tasks directory');
  return target;
}

function safeTaskId(taskId) {
  try {
    return assertTaskId(taskId);
  } catch (error) {
    throw new StoreError('INVALID_TASK_ID', error.message, { taskId }, error);
  }
}

export function taskDirectory(root, taskId) {
  return join(resolved(root, 'state root'), 'tasks', safeTaskId(taskId));
}

export function taskPath(root, taskId) {
  return join(taskDirectory(root, taskId), 'task.json');
}

export function taskLockPath(root, taskId) {
  return join(taskDirectory(root, taskId), 'task.lock');
}

export function artifactRootPath(root, taskId) {
  return join(taskDirectory(root, taskId), 'artifacts');
}

function ensureTaskDirectory(root, taskId) {
  const stateRoot = ensureStateRoot(root);
  const directory = ensurePrivateDirectory(taskDirectory(stateRoot, taskId), 'task directory');
  ensurePrivateDirectory(join(directory, 'artifacts'), 'artifact directory');
  return directory;
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function atomicWriteJson(path, value, { mode = 0o600 } = {}) {
  const target = assertSafePath(path, { label: 'state file' });
  const parent = ensurePrivateDirectory(dirname(target), 'state parent');
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    chmodSync(target, mode);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return target;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function readLock(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return {
      path,
      pid: Number.isInteger(value.pid) ? value.pid : null,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
      live: processIsAlive(value.pid),
      malformed: false,
    };
  } catch (error) {
    return { path, pid: null, createdAt: null, live: false, malformed: true, error: error.message };
  }
}

const waitArray = new Int32Array(new SharedArrayBuffer(4));

export function withTaskLock(root, taskId, operation, { timeoutMs = 500 } = {}) {
  if (typeof operation !== 'function') throw new StoreError('INVALID_OPERATION', 'lock operation must be a function');
  ensureTaskDirectory(root, taskId);
  const path = taskLockPath(root, taskId);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        const lock = readLock(path);
        throw new StoreError('LOCKED', `Task ${taskId} is locked`, { lock });
      }
      Atomics.wait(waitArray, 0, 0, 2);
    }
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    fsyncSync(descriptor);
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(path);
      fsyncDirectory(dirname(path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function parseTask(path, taskId) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
    validateTaskRecord(value);
  } catch (error) {
    throw new StoreError('TASK_CORRUPT', `Task record ${taskId} is invalid: ${error.message}`, { path, taskId }, error);
  }
  return value;
}

export function readTask({ root = getStateRoot(), taskId }) {
  const stateRoot = ensureStateRoot(root);
  const path = taskPath(stateRoot, taskId);
  if (!existsSync(path)) throw new StoreError('TASK_NOT_FOUND', `Task ${taskId} does not exist`, { taskId, path });
  assertSafePath(path, { allowMissing: false, directory: false, label: 'task record' });
  return parseTask(path, taskId);
}

export function createTask({ root = getStateRoot(), input }) {
  const stateRoot = ensureStateRoot(root);
  const taskId = safeTaskId(input?.taskId);
  ensureTaskDirectory(stateRoot, taskId);
  return withTaskLock(stateRoot, taskId, () => {
    const path = taskPath(stateRoot, taskId);
    if (existsSync(path)) throw new StoreError('TASK_EXISTS', `Task ${taskId} already exists`, { taskId, path });
    const record = createInitialTaskRecord(input);
    validateTaskRecord(record);
    atomicWriteJson(path, record);
    return record;
  });
}

export function compareAndSwapTask({
  root = getStateRoot(),
  taskId,
  expectedRecordVersion,
  mutate,
  now = new Date().toISOString(),
  lockTimeoutMs = 500,
}) {
  if (!Number.isInteger(expectedRecordVersion) || expectedRecordVersion < 0) {
    throw new StoreError('INVALID_RECORD_VERSION', 'expectedRecordVersion must be a non-negative integer');
  }
  if (typeof mutate !== 'function') throw new StoreError('INVALID_OPERATION', 'mutate must be a function');
  const stateRoot = ensureStateRoot(root);
  return withTaskLock(stateRoot, taskId, () => {
    const current = readTask({ root: stateRoot, taskId });
    if (current.recordVersion !== expectedRecordVersion) {
      throw new StoreError(
        'STALE_RECORD_VERSION',
        `Task ${taskId} is at recordVersion ${current.recordVersion}, expected ${expectedRecordVersion}`,
        { taskId, expectedRecordVersion, actualRecordVersion: current.recordVersion },
      );
    }
    const candidate = mutate(structuredClone(current));
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new StoreError('INVALID_MUTATION', 'mutate must return a task record object');
    }
    if (candidate.taskId !== current.taskId) {
      throw new StoreError('TASK_ID_CHANGED', 'A task mutation cannot change taskId', { from: current.taskId, to: candidate.taskId });
    }
    const next = {
      ...candidate,
      schemaVersion: current.schemaVersion,
      recordVersion: current.recordVersion + 1,
      updatedAt: now,
    };
    try {
      validateTaskRecord(next);
    } catch (error) {
      throw new StoreError('INVALID_TASK_RECORD', `Mutation produced an invalid task record: ${error.message}`, {}, error);
    }
    atomicWriteJson(taskPath(stateRoot, taskId), next);
    return next;
  }, { timeoutMs: lockTimeoutMs });
}

function walkFiles(directory, output = []) {
  if (!existsSync(directory)) return output;
  assertSafePath(directory, { allowMissing: false, directory: true, label: 'inspection directory' });
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) unsafe(`Refusing symlink during inspection: ${path}`, { path });
    if (entry.isDirectory()) walkFiles(path, output);
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

export function inspectTaskState({ root = getStateRoot(), taskId }) {
  const stateRoot = ensureStateRoot(root);
  const record = readTask({ root: stateRoot, taskId });
  const lockPath = taskLockPath(stateRoot, taskId);
  const locks = existsSync(lockPath) ? [readLock(lockPath)] : [];
  const files = walkFiles(taskDirectory(stateRoot, taskId));
  const attached = new Set(record.artifacts.map((artifact) => artifact.artifactId));
  const artifactIds = [];
  for (const path of files.filter((file) => file.endsWith('.json') && file.includes(`${join('artifacts', '')}`))) {
    try {
      const envelope = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof envelope?.artifact?.artifactId === 'string') artifactIds.push(envelope.artifact.artifactId);
    } catch {
      // Corrupt artifacts remain visible through temp/corruption-specific readback; do not guess an ID.
    }
  }
  const orphanArtifacts = [...new Set(artifactIds.filter((id) => !attached.has(id)))].sort();
  const tempFiles = files.filter((file) => basename(file).includes('.tmp')).sort();
  const actions = [];
  if (locks.some((lock) => !lock.live)) actions.push('inspect-dead-lock-before-removal');
  if (orphanArtifacts.length) actions.push('review-orphan-artifacts');
  if (tempFiles.length) actions.push('review-temporary-files');
  return { taskId, recordVersion: record.recordVersion, locks, orphanArtifacts, tempFiles, actions };
}
