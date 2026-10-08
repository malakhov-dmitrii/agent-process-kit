import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireLease } from '../../runtime/core/leases.mjs';
import {
  StoryError,
  claimStory,
  freezeStoryGraph,
  getReadyStories,
  recordStoryReceipt,
  refreshStoryReceipts,
  recoverExpiredStoryClaims,
  selectFixFindings,
  submitStoryResult,
  validateStoryGraph,
} from '../../runtime/core/stories.mjs';
import { createTask, readTask } from '../../runtime/core/store.mjs';

const time = (minute) => `2026-10-08T12:${String(minute).padStart(2, '0')}:00.000Z`;

function fixture(taskId = 'story-task') {
  const root = join(mkdtempSync(join(tmpdir(), 'apk-story-')), 'state');
  createTask({
    root,
    input: { taskId, request: 'Run story lanes', mode: 'full-train', requestedBoundary: 'local', now: time(0) },
  });
  const integration = acquireLease({
    root,
    taskId,
    scope: 'canonical',
    ownerHost: 'codex',
    ownerSession: 'integration',
    expectedRecordVersion: 0,
    expectedFence: 0,
    renewBefore: time(50),
    expiresAt: time(59),
    now: time(1),
    leaseId: 'integration-lease',
  });
  return { root, taskId, integration };
}

function canonicalContext(fx, recordVersion = fx.integration.record.recordVersion) {
  return {
    leaseId: fx.integration.lease.leaseId,
    fenceToken: fx.integration.lease.fenceToken,
    leaseScope: 'canonical',
    expectedRecordVersion: recordVersion,
    specGeneration: 0,
    planGeneration: 0,
  };
}

function storyContext(claimed, recordVersion = claimed.record.recordVersion) {
  return {
    leaseId: claimed.lease.leaseId,
    fenceToken: claimed.lease.fenceToken,
    leaseScope: claimed.lease.scope,
    expectedRecordVersion: recordVersion,
    specGeneration: 0,
    planGeneration: 0,
  };
}

function graph(taskId = 'story-task') {
  return {
    taskId,
    planGeneration: 0,
    reviewCaps: { spec: 1, plan: 1, code: 1 },
    stories: [
      { id: 'A', title: 'Lane A', dependsOn: [], ownedPaths: ['runtime/a/'], kind: 'work', required: true },
      { id: 'B', title: 'Lane B', dependsOn: [], ownedPaths: ['runtime/b/'], kind: 'work', required: true },
      { id: 'I', title: 'Integrate', dependsOn: ['A', 'B'], ownedPaths: ['runtime/integration.mjs'], kind: 'integration', required: true },
    ],
  };
}

test('validates an acyclic graph and rejects duplicate, cyclic, multi-integration and unsafe parallel ownership', () => {
  assert.equal(validateStoryGraph(graph()).stories.length, 3);
  const duplicate = graph();
  duplicate.stories[1].id = 'A';
  assert.throws(() => validateStoryGraph(duplicate), (error) => error instanceof StoryError && error.code === 'DUPLICATE_STORY');

  const cyclic = graph();
  cyclic.stories[0].dependsOn = ['I'];
  assert.throws(() => validateStoryGraph(cyclic), (error) => error instanceof StoryError && error.code === 'STORY_CYCLE');

  const integrations = graph();
  integrations.stories[1].kind = 'integration';
  assert.throws(() => validateStoryGraph(integrations), (error) => error instanceof StoryError && error.code === 'MULTIPLE_INTEGRATION_STORIES');

  const overlap = graph();
  overlap.stories[1].ownedPaths = ['runtime/a/file.mjs'];
  assert.throws(() => validateStoryGraph(overlap), (error) => error instanceof StoryError && error.code === 'PARALLEL_PATH_CONFLICT');

  const orderedOverlap = graph();
  orderedOverlap.stories[1].dependsOn = ['A'];
  orderedOverlap.stories[1].ownedPaths = ['runtime/a/file.mjs'];
  assert.equal(validateStoryGraph(orderedOverlap).stories.length, 3);
});

test('freezes the graph and exposes only dependency-ready stories', () => {
  const fx = fixture();
  const frozen = freezeStoryGraph({
    root: fx.root,
    taskId: fx.taskId,
    context: canonicalContext(fx),
    graph: graph(),
    now: time(2),
  });
  assert.equal(frozen.record.recordVersion, 2);
  assert.deepEqual(getReadyStories(frozen.record).map((story) => story.id), ['A', 'B']);
  assert.equal(frozen.record.storyGraph.stories.find((story) => story.id === 'I').status, 'pending');
  assert.throws(
    () => freezeStoryGraph({
      root: fx.root,
      taskId: fx.taskId,
      context: canonicalContext(fx, 2),
      graph: graph(),
      now: time(3),
    }),
    (error) => error instanceof StoryError && error.code === 'STORY_GRAPH_ALREADY_FROZEN',
  );
});

test('two independent lanes claim, submit immutable results and unlock one integration story', () => {
  const fx = fixture();
  let record = freezeStoryGraph({ root: fx.root, taskId: fx.taskId, context: canonicalContext(fx), graph: graph(), now: time(2) }).record;
  const claimA = claimStory({
    root: fx.root,
    taskId: fx.taskId,
    context: canonicalContext(fx, record.recordVersion),
    storyId: 'A',
    worker: { host: 'codex', session: 'worker-a' },
    worktree: '/tmp/worktree-a',
    renewBefore: time(20),
    expiresAt: time(30),
    now: time(3),
    leaseId: 'story-a-lease',
  });
  record = claimA.record;
  const claimB = claimStory({
    root: fx.root,
    taskId: fx.taskId,
    context: canonicalContext(fx, record.recordVersion),
    storyId: 'B',
    worker: { host: 'claude', session: 'worker-b' },
    worktree: '/tmp/worktree-b',
    renewBefore: time(20),
    expiresAt: time(30),
    now: time(4),
    leaseId: 'story-b-lease',
  });
  record = claimB.record;
  assert.deepEqual(record.storyGraph.stories.filter((story) => story.status === 'claimed').map((story) => story.id), ['A', 'B']);

  const candidateIdentity = { taskId: fx.taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) };
  record = submitStoryResult({
    root: fx.root,
    taskId: fx.taskId,
    context: storyContext(claimA, record.recordVersion),
    storyId: 'A',
    candidateIdentity,
    resultArtifacts: [{ artifactId: 'test:A' }],
    now: time(5),
  }).record;
  record = submitStoryResult({
    root: fx.root,
    taskId: fx.taskId,
    context: storyContext(claimB, record.recordVersion),
    storyId: 'B',
    candidateIdentity,
    resultArtifacts: [{ artifactId: 'test:B' }],
    now: time(6),
  }).record;
  assert.deepEqual(getReadyStories(record), []);

  record = recordStoryReceipt({
    root: fx.root,
    taskId: fx.taskId,
    context: canonicalContext(fx, record.recordVersion),
    storyId: 'A',
    candidateIdentity,
    receipt: { receiptId: 'receipt:A', verdict: 'pass' },
    now: time(7),
  }).record;
  assert.deepEqual(getReadyStories(record), []);
  record = recordStoryReceipt({
    root: fx.root,
    taskId: fx.taskId,
    context: canonicalContext(fx, record.recordVersion),
    storyId: 'B',
    candidateIdentity,
    receipt: { receiptId: 'receipt:B', verdict: 'pass' },
    now: time(8),
  }).record;
  assert.deepEqual(getReadyStories(record).map((story) => story.id), ['I']);
  assert.equal(record.storyGraph.stories.find((story) => story.id === 'A').status, 'integrated');
  assert.equal(record.storyGraph.stories.find((story) => story.id === 'B').status, 'integrated');
  assert.equal(record.leases.find((lease) => lease.leaseId === 'story-a-lease').revokeReason, 'story-result-submitted');

  assert.throws(
    () => recordStoryReceipt({
      root: fx.root,
      taskId: fx.taskId,
      context: canonicalContext(fx, record.recordVersion),
      storyId: 'I',
      candidateIdentity,
      receipt: { receiptId: 'too-early', verdict: 'pass' },
      now: time(9),
    }),
    (error) => error instanceof StoryError && error.code === 'STORY_RESULT_MISSING',
  );
});

test('integration refuses a receipt for a different candidate than the immutable result', () => {
  const fx = fixture('candidate-story');
  const single = {
    taskId: fx.taskId,
    planGeneration: 0,
    reviewCaps: { spec: 1, plan: 1, code: 1 },
    stories: [{ id: 'A', title: 'Only', dependsOn: [], ownedPaths: ['runtime/a.mjs'], kind: 'work', required: true }],
  };
  let record = freezeStoryGraph({ root: fx.root, taskId: fx.taskId, context: canonicalContext(fx), graph: single, now: time(2) }).record;
  const claimed = claimStory({
    root: fx.root,
    taskId: fx.taskId,
    context: canonicalContext(fx, record.recordVersion),
    storyId: 'A',
    worker: { host: 'codex', session: 'worker' },
    worktree: '/tmp/worktree',
    renewBefore: time(20),
    expiresAt: time(30),
    now: time(3),
    leaseId: 'story-lease',
  });
  record = submitStoryResult({
    root: fx.root,
    taskId: fx.taskId,
    context: storyContext(claimed),
    storyId: 'A',
    candidateIdentity: { taskId: fx.taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) },
    resultArtifacts: [{ artifactId: 'result:A' }],
    now: time(4),
  }).record;
  assert.throws(
    () => recordStoryReceipt({
      root: fx.root,
      taskId: fx.taskId,
      context: canonicalContext(fx, record.recordVersion),
      storyId: 'A',
      candidateIdentity: { taskId: fx.taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'b'.repeat(64) },
      receipt: { receiptId: 'receipt:A', verdict: 'pass' },
      now: time(5),
    }),
    (error) => error instanceof StoryError && error.code === 'STORY_CANDIDATE_MISMATCH',
  );
});

test('final-candidate story refresh updates only the integration receipt', () => {
  const fx = fixture('final-candidate-refresh');
  const single = {
    taskId: fx.taskId,
    planGeneration: 0,
    reviewCaps: { spec: 1, plan: 1, code: 1 },
    stories: [{ id: 'A', title: 'Only', dependsOn: [], ownedPaths: ['runtime/a.mjs'], kind: 'work', required: true }],
  };
  let record = freezeStoryGraph({ root: fx.root, taskId: fx.taskId, context: canonicalContext(fx), graph: single, now: time(2) }).record;
  const claimed = claimStory({ root: fx.root, taskId: fx.taskId, context: canonicalContext(fx, record.recordVersion), storyId: 'A', worker: { host: 'codex', session: 'worker' }, worktree: '/tmp/worktree', renewBefore: time(20), expiresAt: time(30), now: time(3), leaseId: 'story-refresh' });
  record = submitStoryResult({ root: fx.root, taskId: fx.taskId, context: storyContext(claimed), storyId: 'A', candidateIdentity: { taskId: fx.taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) }, resultArtifacts: [{ artifactId: 'immutable' }], now: time(4) }).record;
  record = recordStoryReceipt({ root: fx.root, taskId: fx.taskId, context: canonicalContext(fx, record.recordVersion), storyId: 'A', candidateIdentity: { taskId: fx.taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) }, receipt: { verdict: 'pass' }, now: time(5) }).record;
  const finalCandidate = { taskId: fx.taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'b'.repeat(64) };
  const before = structuredClone(record.storyGraph.stories[0].result);
  const refreshed = refreshStoryReceipts({ root: fx.root, taskId: fx.taskId, context: canonicalContext(fx, record.recordVersion), candidateIdentity: finalCandidate, revalidate: () => ({ verdict: 'pass', candidateIdentity: finalCandidate }), now: time(6) });
  const story = refreshed.record.storyGraph.stories[0];
  assert.deepEqual(story.result, before);
  assert.equal(story.integrationReceipt.candidateIdentity.contentFingerprint, finalCandidate.contentFingerprint);
});

test('expired abandoned claims return to ready without mutating submitted results', () => {
  const fx = fixture('recover-story');
  const single = {
    taskId: fx.taskId,
    planGeneration: 0,
    reviewCaps: { spec: 1, plan: 1, code: 1 },
    stories: [{ id: 'A', title: 'Only', dependsOn: [], ownedPaths: ['runtime/a.mjs'], kind: 'work', required: true }],
  };
  let record = freezeStoryGraph({ root: fx.root, taskId: fx.taskId, context: canonicalContext(fx), graph: single, now: time(2) }).record;
  record = claimStory({
    root: fx.root,
    taskId: fx.taskId,
    context: canonicalContext(fx, record.recordVersion),
    storyId: 'A',
    worker: { host: 'codex', session: 'abandoned' },
    worktree: '/tmp/abandoned',
    renewBefore: time(3),
    expiresAt: time(4),
    now: time(2),
    leaseId: 'abandoned-lease',
  }).record;
  const recovered = recoverExpiredStoryClaims({
    root: fx.root,
    taskId: fx.taskId,
    context: canonicalContext(fx, record.recordVersion),
    now: time(5),
  });
  const story = recovered.record.storyGraph.stories[0];
  assert.equal(story.status, 'ready');
  assert.equal(story.claim, null);
  assert.equal(story.claimHistory.length, 1);
  assert.equal(story.claimHistory[0].leaseId, 'abandoned-lease');
});

test('fix selection enforces the review cap and excludes deferred findings', () => {
  const findings = [
    { id: 'b', classification: 'blocking' },
    { id: 'd', classification: 'deferred' },
    { id: 'e', classification: 'approved-expansion' },
  ];
  assert.deepEqual(selectFixFindings({ findings, round: 1, cap: 1 }).map((finding) => finding.id), ['b', 'e']);
  assert.throws(
    () => selectFixFindings({ findings, round: 2, cap: 1 }),
    (error) => error instanceof StoryError && error.code === 'REVIEW_CAP_EXCEEDED',
  );
});
