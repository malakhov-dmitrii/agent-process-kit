import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  advancePhase,
  classifyNaturalCommand,
  classifyNaturalTask,
  freezePlan,
  freezeSpec,
  recordDecision,
  recordPlan,
  recordReview,
  recordSelfCheck,
  recordSpecification,
  startTask,
} from '../../runtime/core/control-plane.mjs';
import { createReviewReport } from '../../runtime/adapters/review.mjs';
import { compareAndSwapTask, readTask } from '../../runtime/core/store.mjs';
import { mutateWithLease } from '../../runtime/core/leases.mjs';
import { clearPrompts, naturalCommands } from '../fixtures/orchestration-prompts.mjs';

const time = (minute) => `2026-10-08T12:${String(minute).padStart(2, '0')}:00.000Z`;

function context(state, record = state.record) {
  return {
    ...state.context,
    expectedRecordVersion: record.recordVersion,
    specGeneration: record.specGeneration,
    planGeneration: record.planGeneration,
  };
}

function graph(taskId) {
  return {
    taskId,
    planGeneration: 0,
    reviewCaps: { spec: 1, plan: 1, code: 1 },
    stories: [{
      id: 'implement',
      title: 'Implement the requested behavior',
      dependsOn: [],
      ownedPaths: ['src/feature.mjs'],
      kind: 'work',
      required: true,
    }],
  };
}

test('natural clear tasks select deterministic mode and Russian verbs route without a skill name', () => {
  assert.deepEqual(classifyNaturalTask(clearPrompts[0]), {
    ambiguity: 'low',
    mode: 'quick',
  });
  assert.deepEqual(classifyNaturalTask(clearPrompts[1]), {
    ambiguity: 'low',
    mode: 'standard',
  });
  assert.equal(classifyNaturalCommand(naturalCommands.release[0]), 'release');
  assert.equal(classifyNaturalCommand(naturalCommands.continue[0]), 'continue');
  assert.equal(classifyNaturalCommand(naturalCommands.continue[1]), 'continue');
  assert.equal(classifyNaturalCommand(naturalCommands.status[0]), 'status');
  assert.equal(classifyNaturalCommand(naturalCommands.pause[0]), 'pause');
  assert.equal(classifyNaturalCommand(naturalCommands.pause[1]), 'pause');
});

test('ambiguous tasks remain in clarify until a material decision is recorded', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'apk-orchestration-')), 'state');
  const started = startTask({
    root,
    taskId: 'ambiguous-task',
    request: 'Improve onboarding and choose the best workflow for new users',
    ownerHost: 'codex',
    ownerSession: 'session-a',
    now: time(0),
  });
  assert.equal(started.record.phase, 'clarify');
  assert.ok(started.record.pendingDecisions.length > 0);
  assert.throws(() => advancePhase({
    root,
    taskId: 'ambiguous-task',
    context: context(started),
    targetPhase: 'spec-draft',
    now: time(1),
  }), /clarify/);

  const decided = recordDecision({
    root,
    taskId: 'ambiguous-task',
    context: context(started),
    decision: { id: 'clarification', question: 'Which workflow?', answer: 'guided', material: true },
    now: time(2),
  });
  assert.equal(decided.record.phase, 'spec-draft');
  assert.equal(decided.record.pendingDecisions.length, 0);
});

test('material decisions remove only their matching pending item and require an answer', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'apk-orchestration-')), 'state');
  const started = startTask({
    root,
    taskId: 'two-decisions',
    request: 'Improve onboarding and choose the best workflow for new users',
    ownerHost: 'codex',
    ownerSession: 'session-a',
    now: time(0),
  });
  const seeded = compareAndSwapTask({
    root,
    taskId: 'two-decisions',
    expectedRecordVersion: started.record.recordVersion,
    now: time(1),
    mutate: (record) => ({
      ...record,
      pendingDecisions: [...record.pendingDecisions, { id: 'audience', question: 'Who is the first user?', material: true }],
    }),
  });
  assert.throws(() => recordDecision({
    root,
    taskId: 'two-decisions',
    context: context({ ...started, record: seeded }),
    decision: { id: 'clarification', question: 'Which workflow?', answer: '   ', material: true },
    now: time(2),
  }), /answer/i);

  const first = recordDecision({
    root,
    taskId: 'two-decisions',
    context: context({ ...started, record: seeded }),
    decision: { id: 'clarification', question: 'Which workflow?', answer: 'guided', material: true },
    now: time(3),
  });
  assert.equal(first.record.phase, 'clarify');
  assert.deepEqual(first.record.pendingDecisions.map((item) => item.id), ['audience']);

  const second = recordDecision({
    root,
    taskId: 'two-decisions',
    context: { ...first.context, expectedRecordVersion: first.record.recordVersion },
    decision: { id: 'audience', question: 'Who is the first user?', answer: 'new users', material: true },
    now: time(4),
  });
  assert.equal(second.record.phase, 'spec-draft');
  assert.deepEqual(second.record.pendingDecisions, []);
});

test('advancePhase derives lifecycle events from the current and target phase pair', () => {
  const cases = [
    ['clarify', 'spec-draft', 'decisions-ready', 'local'],
    ['spec-review', 'plan-draft', 'review-approved', 'local'],
    ['plan-review', 'implement', 'review-approved', 'local'],
    ['implement', 'code-review', 'stories-integrated', 'local'],
    ['code-review', 'local-uat', 'review-approved', 'local'],
    ['local-uat', 'close', 'uat-passed', 'local'],
    ['local-uat', 'release-ready', 'uat-passed', 'deploy'],
  ];
  for (const [from, targetPhase, expectedEvent, requestedBoundary] of cases) {
    const root = join(mkdtempSync(join(tmpdir(), 'apk-orchestration-')), 'state');
    const started = startTask({
      root,
      taskId: `phase-${from.replaceAll('-', '')}-${targetPhase.replaceAll('-', '')}`,
      request: 'Add a durable feature',
      requestedBoundary,
      ownerHost: 'codex',
      ownerSession: 'session-a',
      now: time(0),
    });
    const candidateIdentity = { taskId: started.record.taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) };
    const proof = (type) => ({
      receiptId: `${type}-receipt`, type, verdict: 'pass', blockingFindings: 0,
      candidateIdentity, coverage: 'full-candidate', producer: { kind: 'test', id: type },
      scenario: type, startedAt: time(1), completedAt: time(1),
    });
    const seeded = compareAndSwapTask({
      root,
      taskId: started.record.taskId,
      expectedRecordVersion: started.record.recordVersion,
      now: time(1),
      mutate: (record) => ({
        ...record,
        phase: from,
        pendingDecisions: [],
        evidence: [proof('spec-review'), proof('plan-review'), proof('code-review'), proof('local-uat')],
        storyGraph: {
          taskId: record.taskId,
          planGeneration: 0,
          reviewCaps: { spec: 1, plan: 1, code: 1 },
          stories: [{
            id: 'done', required: true, status: 'integrated',
            result: { candidateIdentity },
            integrationReceipt: { verdict: 'pass', candidateIdentity },
          }],
        },
      }),
    });
    const advanced = advancePhase({
      root,
      taskId: started.record.taskId,
      context: context({ ...started, record: seeded }),
      targetPhase,
      facts: { candidateIdentity },
      now: time(2),
    });
    assert.equal(advanced.transition.event, expectedEvent, `${from} -> ${targetPhase}`);
    assert.equal(advanced.record.phase, targetPhase);
  }

  const root = join(mkdtempSync(join(tmpdir(), 'apk-orchestration-')), 'state');
  const started = startTask({ root, taskId: 'explicit-event', request: 'Add a durable feature', ownerHost: 'codex', ownerSession: 'session-a', now: time(0) });
  const seeded = compareAndSwapTask({ root, taskId: 'explicit-event', expectedRecordVersion: started.record.recordVersion, now: time(1), mutate: (record) => ({ ...record, phase: 'intake', pendingDecisions: [] }) });
  const advanced = advancePhase({ root, taskId: 'explicit-event', context: context({ ...started, record: seeded }), targetPhase: 'spec-draft', facts: { event: 'ambiguity-low', recordedReason: 'operator explicitly confirmed the scope' }, now: time(2) });
  assert.equal(advanced.transition.event, 'ambiguity-low');
});

test('phase gates fail closed when candidate identity is omitted', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'apk-orchestration-')), 'state');
  const started = startTask({
    root,
    taskId: 'missing-candidate-gate',
    request: 'Ship the reviewed change to production',
    requestedBoundary: 'production',
    ownerHost: 'codex',
    ownerSession: 'session-a',
    now: time(0),
  });
  const seeded = mutateWithLease({
    root,
    taskId: 'missing-candidate-gate',
    context: context(started),
    requiredScope: 'canonical',
    now: time(1),
    mutate: (record) => ({ ...record, phase: 'local-uat' }),
  });
  assert.throws(
    () => advancePhase({
      root,
      taskId: 'missing-candidate-gate',
      context: context(started, seeded),
      targetPhase: 'release-ready',
      facts: {},
      now: time(2),
    }),
    (error) => error.code === 'PHASE_GATE_BLOCKED'
      && error.details.blockers.some((blocker) => blocker.code === 'missing-current-local-uat'),
  );
});

test('spec and plan freeze only after self-check plus one immutable bounded independent review', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'apk-orchestration-')), 'state');
  let state = startTask({
    root,
    taskId: 'reviewed-task',
    request: 'Add a durable CSV export endpoint with validation',
    ownerHost: 'codex',
    ownerSession: 'session-a',
    now: time(0),
  });
  let record = recordSpecification({
    root,
    taskId: 'reviewed-task',
    context: context(state),
    specification: { requirements: [{ id: 'csv', behavior: 'exports one row per item', proof: 'real endpoint request' }] },
    now: time(1),
  }).record;
  state = { ...state, record };
  record = recordSelfCheck({ root, taskId: 'reviewed-task', context: context(state), phase: 'spec', report: { passed: true }, now: time(2) }).record;
  state = { ...state, record };
  const reviewDraft = createReviewReport({
    root,
    taskId: 'reviewed-task',
    kind: 'spec',
    candidateIdentity: { taskId: 'reviewed-task', specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) },
    findings: [{ id: 'd1', classification: 'deferred', message: 'Polish wording later' }],
    producer: { kind: 'reviewer', id: 'reviewer-1' },
    now: time(3),
  });
  assert.equal(readTask({ root, taskId: 'reviewed-task' }).recordVersion, record.recordVersion);
  record = recordReview({ root, taskId: 'reviewed-task', context: context(state), phase: 'spec', candidateIdentity: reviewDraft.candidateIdentity, report: reviewDraft, now: time(4) }).record;
  state = { ...state, record };
  record = freezeSpec({ root, taskId: 'reviewed-task', context: context(state), specification: { requirements: [{ id: 'csv', behavior: 'exports one row per item', proof: 'real endpoint request' }] }, reviewRefs: [reviewDraft], now: time(5) }).record;
  assert.equal(record.phase, 'plan-draft');
  state = { ...state, record };

  record = recordPlan({ root, taskId: 'reviewed-task', context: context(state), plan: { requirements: [{ id: 'csv', storyIds: ['implement'], proof: 'real endpoint request' }] }, now: time(6) }).record;
  state = { ...state, record };
  record = recordSelfCheck({ root, taskId: 'reviewed-task', context: context(state), phase: 'plan', report: { passed: true }, now: time(7) }).record;
  state = { ...state, record };
  const planReview = createReviewReport({
    root,
    taskId: 'reviewed-task',
    kind: 'plan',
    candidateIdentity: { taskId: 'reviewed-task', specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) },
    findings: [],
    producer: { kind: 'reviewer', id: 'reviewer-1' },
    now: time(8),
  });
  record = recordReview({ root, taskId: 'reviewed-task', context: context(state), phase: 'plan', candidateIdentity: planReview.candidateIdentity, report: planReview, now: time(9) }).record;
  state = { ...state, record };
  record = freezePlan({ root, taskId: 'reviewed-task', context: context(state), plan: { requirements: [{ id: 'csv', storyIds: ['implement'], proof: 'real endpoint request' }] }, storyGraph: graph('reviewed-task'), reviewRefs: [planReview], now: time(10) }).record;
  assert.equal(record.phase, 'implement');
  assert.equal(record.artifacts.filter((item) => item.type === 'frozen-spec').length, 1);
  assert.equal(record.artifacts.filter((item) => item.type === 'frozen-plan').length, 1);
  assert.throws(() => recordReview({ root, taskId: 'reviewed-task', context: context({ ...state, record }), phase: 'plan', candidateIdentity: planReview.candidateIdentity, report: planReview, now: time(11) }), /cap/i);
});
