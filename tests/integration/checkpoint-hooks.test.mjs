import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readArtifact, stageArtifact, artifactPath } from '../../runtime/core/artifacts.mjs';
import { acquireLease, mutateWithLease } from '../../runtime/core/leases.mjs';
import { createTask, readTask } from '../../runtime/core/store.mjs';
import { bindSession } from '../../runtime/adapters/sessions.mjs';
import {
  CheckpointError,
  checkpointTask,
  resumeFromCheckpoint,
} from '../../runtime/adapters/checkpoint.mjs';
import { handleHostEvent } from '../../runtime/adapters/hooks.mjs';

const time = (minute) => `2026-10-08T12:${String(minute).padStart(2, '0')}:00.000Z`;

function fixture({ bind = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'apk-checkpoint-'));
  const root = join(base, 'state');
  const repo = join(base, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Checkpoint Test']);
  writeFileSync(join(repo, 'tracked.txt'), 'tracked\n');
  execFileSync('git', ['-C', repo, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial']);
  writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
  const taskId = 'checkpoint-task';
  createTask({ root, input: { taskId, request: 'Resume exactly', mode: 'full-train', requestedBoundary: 'local', now: time(0) } });
  const integration = acquireLease({
    root, taskId, scope: 'canonical', ownerHost: 'codex', ownerSession: 'session-1',
    expectedRecordVersion: 0, expectedFence: 0, renewBefore: time(50), expiresAt: time(59), now: time(1), leaseId: 'integration-lease',
  });
  const journal = join(base, 'journal.md');
  writeFileSync(journal, 'Task-ID: checkpoint-task\n');
  if (bind) bindSession({ root, sessionId: 'session-1', taskId, journalPath: journal, repo, worktree: repo, ownerHost: 'codex' });
  return { base, root, repo, taskId, integration, journal };
}

function context(fx, recordVersion = fx.integration.record.recordVersion) {
  return {
    leaseId: fx.integration.lease.leaseId,
    fenceToken: fx.integration.lease.fenceToken,
    leaseScope: 'canonical',
    expectedRecordVersion: recordVersion,
    specGeneration: 0,
    planGeneration: 0,
  };
}

test('candidate-only binding never creates a checkpoint', () => {
  const fx = fixture({ bind: false });
  mkdirSync(join(fx.repo, '.agent'), { recursive: true });
  writeFileSync(join(fx.repo, '.agent', 'CURRENT'), `${fx.taskId}\n`);
  assert.throws(
    () => checkpointTask({
      root: fx.root,
      taskId: fx.taskId,
      context: context(fx),
      host: 'codex',
      sessionId: 'fresh',
      workspace: fx.repo,
      worktree: fx.repo,
      eventId: 'compact-1',
      now: time(2),
    }),
    (error) => error instanceof CheckpointError && error.code === 'CHECKPOINT_BINDING_NOT_EXACT',
  );
  assert.equal(readTask({ root: fx.root, taskId: fx.taskId }).checkpointGeneration, 0);
});

test('checkpoint captures exact durable state with secrets redacted and duplicate event is idempotent', () => {
  const fx = fixture();
  const prepared = mutateWithLease({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx),
    now: time(2),
    mutate: (record) => ({
      ...record,
      pendingDecisions: [{ id: 'decision-1', apiToken: 'should-not-leak', summary: 'choose target' }],
      lastTrace: { expected: 'checkpoint', actual: 'ready', nextOwner: 'worker', nextAction: 'resume story A' },
    }),
  });
  const checkpoint = checkpointTask({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx, prepared.recordVersion),
    host: 'codex',
    sessionId: 'session-1',
    workspace: fx.repo,
    worktree: fx.repo,
    eventId: 'compact-1',
    reason: 'pre-compact',
    now: time(3),
  });
  assert.equal(checkpoint.record.checkpointGeneration, 1);
  assert.equal(checkpoint.payload.nextSafeAction, 'resume story A');
  assert.equal(checkpoint.payload.pendingDecisions[0].apiToken, '[REDACTED]');
  assert.equal(JSON.stringify(checkpoint.payload).includes('should-not-leak'), false);
  assert.equal(checkpoint.payload.candidateIdentity.contentManifest.some((item) => item.path === 'untracked.txt'), true);
  assert.equal(checkpoint.payload.committedRecordVersion, checkpoint.record.recordVersion);

  const duplicate = checkpointTask({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx, checkpoint.record.recordVersion),
    host: 'codex',
    sessionId: 'session-1',
    workspace: fx.repo,
    worktree: fx.repo,
    eventId: 'compact-1',
    reason: 'pre-compact',
    now: time(4),
  });
  assert.equal(duplicate.artifact.artifactId, checkpoint.artifact.artifactId);
  assert.equal(duplicate.record.recordVersion, checkpoint.record.recordVersion);
  assert.equal(duplicate.idempotent, true);
});

test('fresh process resumes the latest exact checkpoint and rejects dirty drift', () => {
  const fx = fixture();
  const checkpoint = checkpointTask({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx),
    host: 'codex',
    sessionId: 'session-1',
    workspace: fx.repo,
    worktree: fx.repo,
    eventId: 'compact-1',
    now: time(2),
  });
  const resumed = resumeFromCheckpoint({
    root: fx.root,
    taskId: fx.taskId,
    checkpointArtifact: checkpoint.artifact,
    sessionId: 'session-1',
    workspace: fx.repo,
    worktree: fx.repo,
  });
  assert.equal(resumed.taskId, fx.taskId);
  assert.equal(resumed.checkpointGeneration, 1);
  assert.equal(resumed.nextSafeAction, 'inspect current phase');

  writeFileSync(join(fx.repo, 'untracked.txt'), 'changed\n');
  assert.throws(
    () => resumeFromCheckpoint({
      root: fx.root,
      taskId: fx.taskId,
      checkpointArtifact: checkpoint.artifact,
      sessionId: 'session-1',
      workspace: fx.repo,
      worktree: fx.repo,
    }),
    (error) => error instanceof CheckpointError && error.code === 'CHECKPOINT_CANDIDATE_MISMATCH',
  );
});

test('resume verifies every artifact hash referenced by the checkpoint', () => {
  const fx = fixture();
  const proof = stageArtifact({
    root: fx.root,
    taskId: fx.taskId,
    type: 'test-receipt',
    generation: 0,
    payload: { passed: true },
    producer: { kind: 'runner', id: 'node' },
    sourceInputs: [],
    now: time(2),
  });
  const attached = mutateWithLease({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx),
    now: time(3),
    mutate: (record) => ({ ...record, artifacts: [...record.artifacts, proof] }),
  });
  const checkpoint = checkpointTask({
    root: fx.root,
    taskId: fx.taskId,
    context: context(fx, attached.recordVersion),
    host: 'codex',
    sessionId: 'session-1',
    workspace: fx.repo,
    worktree: fx.repo,
    eventId: 'compact-1',
    now: time(4),
  });
  const path = artifactPath(fx.root, fx.taskId, proof);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  envelope.payload.passed = false;
  writeFileSync(path, JSON.stringify(envelope));
  assert.throws(
    () => resumeFromCheckpoint({
      root: fx.root,
      taskId: fx.taskId,
      checkpointArtifact: checkpoint.artifact,
      sessionId: 'session-1',
      workspace: fx.repo,
      worktree: fx.repo,
    }),
    /digest readback/,
  );
});

test('PreCompact blocks an exact task without mutation context and checkpoints with it', () => {
  const fx = fixture();
  const missing = handleHostEvent({
    root: fx.root,
    host: 'codex',
    event: 'PreCompact',
    payload: { sessionId: 'session-1', workspace: fx.repo, worktree: fx.repo, eventId: 'compact-1' },
    now: time(2),
  });
  assert.equal(missing.decision, 'block');
  assert.equal(missing.reason, 'checkpoint-context-missing');

  const saved = handleHostEvent({
    root: fx.root,
    host: 'codex',
    event: 'PreCompact',
    payload: {
      sessionId: 'session-1', workspace: fx.repo, worktree: fx.repo, eventId: 'compact-1',
      mutationContext: context(fx),
    },
    now: time(2),
  });
  assert.equal(saved.decision, 'allow');
  assert.equal(saved.checkpoint.checkpointGeneration, 1);
});

test('PreCompact does not checkpoint candidates and Stop gates only explicit overall completion', () => {
  const candidateFixture = fixture({ bind: false });
  mkdirSync(join(candidateFixture.repo, '.agent'), { recursive: true });
  writeFileSync(join(candidateFixture.repo, '.agent', 'CURRENT'), `${candidateFixture.taskId}\n`);
  const candidateResult = handleHostEvent({
    root: candidateFixture.root,
    host: 'codex',
    event: 'PreCompact',
    payload: { sessionId: 'fresh', workspace: candidateFixture.repo, worktree: candidateFixture.repo, eventId: 'compact-1' },
    now: time(2),
  });
  assert.equal(candidateResult.decision, 'allow');
  assert.equal(candidateResult.resolution.status, 'candidate');
  assert.equal(readTask({ root: candidateFixture.root, taskId: candidateFixture.taskId }).checkpointGeneration, 0);

  const fx = fixture();
  assert.equal(handleHostEvent({
    root: fx.root,
    host: 'codex',
    event: 'Stop',
    payload: { sessionId: 'session-1', workspace: fx.repo, worktree: fx.repo, lastAssistantMessage: 'LOCAL-ONLY: partial result' },
    now: time(2),
  }).decision, 'allow');
  const blocked = handleHostEvent({
    root: fx.root,
    host: 'codex',
    event: 'Stop',
    payload: { sessionId: 'session-1', workspace: fx.repo, worktree: fx.repo, lastAssistantMessage: `Task complete: ${fx.taskId}` },
    now: time(2),
  });
  assert.equal(blocked.decision, 'block');
  assert.ok(blocked.blockers.length > 0);
  assert.equal(handleHostEvent({
    root: fx.root,
    host: 'codex',
    event: 'Stop',
    payload: { sessionId: 'session-1', workspace: fx.repo, worktree: fx.repo, lastAssistantMessage: `Task complete: ${fx.taskId}`, stopHookActive: true },
    now: time(2),
  }).decision, 'allow');
});
