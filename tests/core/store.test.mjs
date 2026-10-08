import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  StoreError,
  compareAndSwapTask,
  createTask,
  ensureStateRoot,
  inspectTaskState,
  readTask,
  taskLockPath,
  taskPath,
} from '../../runtime/core/store.mjs';
import {
  artifactPath,
  attachArtifact,
  readArtifact,
  recordArtifact,
  stageArtifact,
} from '../../runtime/core/artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const writer = join(here, '..', 'fixtures', 'cas-writer.mjs');

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'apk-store-'));
  return { base, root: join(base, 'state') };
}

function input(taskId = 'task-1') {
  return {
    taskId,
    request: 'Prove the task store',
    requestedBoundary: 'local',
    mode: 'full-train',
    now: '2026-10-08T12:00:00.000Z',
  };
}

function mode(path) {
  return lstatSync(path).mode & 0o777;
}

test('creates private durable state and refuses duplicate tasks', () => {
  const fx = fixture();
  const root = ensureStateRoot(fx.root);
  const record = createTask({ root, input: input() });

  assert.equal(record.recordVersion, 0);
  assert.deepEqual(readTask({ root, taskId: 'task-1' }), record);
  assert.equal(mode(root), 0o700);
  assert.equal(mode(taskPath(root, 'task-1')), 0o600);
  assert.throws(
    () => createTask({ root, input: input() }),
    (error) => error instanceof StoreError && error.code === 'TASK_EXISTS',
  );
});

test('compare-and-swap commits one version and rejects stale or identity-changing writers', () => {
  const fx = fixture();
  createTask({ root: fx.root, input: input() });
  const updated = compareAndSwapTask({
    root: fx.root,
    taskId: 'task-1',
    expectedRecordVersion: 0,
    now: '2026-10-08T12:01:00.000Z',
    mutate: (record) => ({ ...record, phase: 'clarify' }),
  });
  assert.equal(updated.recordVersion, 1);
  assert.equal(updated.phase, 'clarify');
  assert.equal(updated.updatedAt, '2026-10-08T12:01:00.000Z');
  assert.throws(
    () => compareAndSwapTask({ root: fx.root, taskId: 'task-1', expectedRecordVersion: 0, mutate: (record) => record }),
    (error) => error instanceof StoreError && error.code === 'STALE_RECORD_VERSION',
  );
  assert.throws(
    () => compareAndSwapTask({
      root: fx.root,
      taskId: 'task-1',
      expectedRecordVersion: 1,
      mutate: (record) => ({ ...record, taskId: 'other' }),
    }),
    (error) => error instanceof StoreError && error.code === 'TASK_ID_CHANGED',
  );
});

function spawnWriter(root, marker) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [writer, root, 'task-1', marker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('two real processes racing the same record version produce exactly one commit', async () => {
  const fx = fixture();
  createTask({ root: fx.root, input: input() });
  mkdirSync(join(fx.root, 'barrier'), { mode: 0o700 });
  const first = spawnWriter(fx.root, 'first');
  const second = spawnWriter(fx.root, 'second');
  writeFileSync(join(fx.root, 'barrier', 'start'), 'go', { mode: 0o600 });
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((item) => item.status === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((item) => item.status === 2).length, 1, JSON.stringify(results));
  assert.match(results.find((item) => item.status === 2).stderr, /STALE_RECORD_VERSION/);
  const record = readTask({ root: fx.root, taskId: 'task-1' });
  assert.equal(record.recordVersion, 1);
  assert.ok(['first', 'second'].includes(record.lastTrace.marker));
});

test('symlink, corrupt record and dead lock fail safely and remain inspectable', () => {
  const symlinkFixture = fixture();
  const actual = join(symlinkFixture.base, 'actual');
  mkdirSync(actual);
  symlinkSync(actual, symlinkFixture.root);
  assert.throws(
    () => ensureStateRoot(symlinkFixture.root),
    (error) => error instanceof StoreError && error.code === 'UNSAFE_PATH',
  );

  const corrupt = fixture();
  createTask({ root: corrupt.root, input: input() });
  writeFileSync(taskPath(corrupt.root, 'task-1'), '{', { mode: 0o600 });
  assert.throws(
    () => readTask({ root: corrupt.root, taskId: 'task-1' }),
    (error) => error instanceof StoreError && error.code === 'TASK_CORRUPT',
  );

  const locked = fixture();
  createTask({ root: locked.root, input: input() });
  writeFileSync(taskLockPath(locked.root, 'task-1'), JSON.stringify({ pid: 999999, createdAt: '2026-10-08T12:00:00.000Z' }), { mode: 0o600 });
  assert.throws(
    () => compareAndSwapTask({ root: locked.root, taskId: 'task-1', expectedRecordVersion: 0, mutate: (record) => record, lockTimeoutMs: 5 }),
    (error) => error instanceof StoreError && error.code === 'LOCKED',
  );
  const inspection = inspectTaskState({ root: locked.root, taskId: 'task-1' });
  assert.deepEqual(inspection.locks.map((lock) => ({ live: lock.live, pid: lock.pid })), [{ live: false, pid: 999999 }]);
  assert.deepEqual(inspection.actions, ['inspect-dead-lock-before-removal']);
});

test('artifacts are content-addressed, attach atomically and expose crash-window orphans', () => {
  const fx = fixture();
  createTask({ root: fx.root, input: input() });
  const orphan = stageArtifact({
    root: fx.root,
    taskId: 'task-1',
    type: 'specification',
    generation: 1,
    payload: { behavior: 'one canonical row' },
    producer: { kind: 'agent', id: 'test' },
    sourceInputs: ['request:1'],
    now: '2026-10-08T12:02:00.000Z',
  });
  let inspection = inspectTaskState({ root: fx.root, taskId: 'task-1' });
  assert.deepEqual(inspection.orphanArtifacts, [orphan.artifactId]);

  const attached = attachArtifact({
    root: fx.root,
    taskId: 'task-1',
    expectedRecordVersion: 0,
    artifact: orphan,
    now: '2026-10-08T12:03:00.000Z',
  });
  assert.equal(attached.recordVersion, 1);
  assert.deepEqual(attached.artifacts, [orphan]);
  assert.deepEqual(readArtifact({ root: fx.root, taskId: 'task-1', artifact: orphan }).payload, { behavior: 'one canonical row' });
  inspection = inspectTaskState({ root: fx.root, taskId: 'task-1' });
  assert.deepEqual(inspection.orphanArtifacts, []);

  const recorded = recordArtifact({
    root: fx.root,
    taskId: 'task-1',
    expectedRecordVersion: 1,
    type: 'review-report',
    generation: 1,
    payload: { verdict: 'approve' },
    producer: { kind: 'reviewer', id: 'r1' },
    sourceInputs: [orphan.artifactId],
    now: '2026-10-08T12:04:00.000Z',
  });
  assert.equal(recorded.record.recordVersion, 2);
  assert.equal(recorded.artifact.type, 'review-report');
});

test('artifact payload corruption is detected by digest readback', () => {
  const fx = fixture();
  createTask({ root: fx.root, input: input() });
  const artifact = stageArtifact({
    root: fx.root,
    taskId: 'task-1',
    type: 'test-receipt',
    generation: 0,
    payload: { passed: true },
    producer: { kind: 'runner', id: 'node-test' },
    sourceInputs: [],
  });
  const path = artifactPath(fx.root, 'task-1', artifact);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  envelope.payload.passed = false;
  chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
  assert.throws(
    () => readArtifact({ root: fx.root, taskId: 'task-1', artifact }),
    (error) => error instanceof StoreError && error.code === 'ARTIFACT_DIGEST_MISMATCH',
  );
});

test('artifact provenance corruption is part of the content digest', () => {
  const fx = fixture();
  createTask({ root: fx.root, input: input() });
  const artifact = stageArtifact({
    root: fx.root,
    taskId: 'task-1',
    type: 'review-report',
    generation: 1,
    payload: { verdict: 'approve' },
    producer: { kind: 'reviewer', id: 'original' },
    sourceInputs: ['candidate:1'],
    now: '2026-10-08T12:05:00.000Z',
  });
  const path = artifactPath(fx.root, 'task-1', artifact);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  envelope.artifact.producer.id = 'forged';
  writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
  assert.throws(
    () => readArtifact({ root: fx.root, taskId: 'task-1', artifact }),
    (error) => error instanceof StoreError && error.code === 'ARTIFACT_DIGEST_MISMATCH',
  );
});
