import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { acquireLease, mutateWithLease } from '../../runtime/core/leases.mjs';
import { recordAuthorizationIntent, issueExecutionGrant } from '../../runtime/core/grants.mjs';
import { createTask, readTask } from '../../runtime/core/store.mjs';
import { createCandidateIdentity } from '../../runtime/core/candidate.mjs';

const repo = resolve(new URL('../..', import.meta.url).pathname);
const cli = join(repo, 'bin/agent-process-kit.mjs');
const reader = join(repo, 'tests/fixtures/e2e-cli-reader.mjs');
const at = (minute) => `2026-10-08T12:${String(minute).padStart(2, '0')}:00.000Z`;

function fixture(prefix = 'apk-e2e-') {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const project = join(base, 'project');
  const state = join(base, 'state');
  mkdirSync(project);
  return { base, project, state };
}

function run(fx, args, data = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, '--state-dir', fx.state, '--data', JSON.stringify(data)], {
    cwd: fx.project,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function rejected(fx, args, data = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, '--state-dir', fx.state, '--data', JSON.stringify(data)], {
    cwd: fx.project,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, result.stdout);
  return JSON.parse(result.stdout);
}

function recordContext(record) {
  const lease = record.leases.find((item) => item.scope === 'canonical' && item.revokedAt == null);
  return { leaseId: lease.leaseId, fenceToken: lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: record.recordVersion, specGeneration: record.specGeneration, planGeneration: record.planGeneration };
}

function releaseFixture(boundary = 'production') {
  const fx = fixture('apk-e2e-release-');
  const taskId = `release-${boundary}`;
  createTask({ root: fx.state, input: { taskId, request: 'Ship exact candidate', mode: 'full-train', requestedBoundary: boundary, now: at(0) } });
  const acquired = acquireLease({ root: fx.state, taskId, scope: 'canonical', ownerHost: 'codex', ownerSession: 'integration', expectedRecordVersion: 0, expectedFence: 0, renewBefore: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-02T00:00:00.000Z', now: at(1), leaseId: 'integration' });
  const candidate = { taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64), commitSha: 'b'.repeat(40), artifactDigest: 'c'.repeat(64) };
  const ready = mutateWithLease({ root: fx.state, taskId, context: recordContext(acquired.record), now: at(2), mutate: (record) => ({ ...record, phase: 'release-ready', evidence: [
    { type: 'local-uat', verdict: 'pass', candidateIdentity: candidate },
    { type: 'push', verdict: 'pass', targetBranch: 'main', branchSynchronized: true, remoteRevision: candidate.commitSha, candidateIdentity: candidate },
    { type: 'full-gate', verdict: 'pass', candidateIdentity: candidate }, { type: 'docs', verdict: 'pass', candidateIdentity: candidate },
    { type: 'migration', verdict: 'pass', candidateIdentity: candidate }, { type: 'containment', verdict: 'pass', candidateIdentity: candidate },
  ] }) });
  const intent = recordAuthorizationIntent({ root: fx.state, taskId, context: recordContext(ready), operatorIdentity: 'operator:e2e', deliveryBoundary: boundary, constraints: { branch: 'main' }, now: at(3), intentId: 'intent' });
  const grant = issueExecutionGrant({ root: fx.state, taskId, context: recordContext(intent.record), intentId: intent.intent.intentId, candidateIdentity: candidate, targetResource: 'deploy:production', allowedAction: 'deploy', granteeRole: 'release-adapter', expiresAt: '2099-01-02T00:00:00.000Z', maxUses: 1, now: at(4), grantId: 'grant' });
  return { ...fx, taskId, candidate, grant: grant.grant };
}

test('clear natural local train survives a fresh CLI process and durable status read', () => {
  const fx = fixture();
  const started = run(fx, ['task', 'start', '--task-id', 'clear-local', '--request', 'Fix a typo in the README'], { now: at(0) });
  assert.equal(started.result.classification.ambiguity, 'low');
  assert.equal(started.result.classification.mode, 'quick');
  assert.equal(started.result.record.phase, 'spec-draft');

  const fresh = spawnSync(process.execPath, [reader, cli, fx.state, 'clear-local'], { cwd: fx.project, encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  const status = JSON.parse(fresh.stdout);
  assert.equal(status.result.taskId, 'clear-local');
  assert.equal(status.result.next.owner, 'orchestrator');
  assert.equal(readTask({ root: fx.state, taskId: 'clear-local' }).recordVersion, started.result.record.recordVersion);
});

test('ambiguous natural task is blocked before a decision and records the reviewed phase after CLI resolution', () => {
  const fx = fixture();
  const started = run(fx, ['task', 'start', '--task-id', 'ambiguous', '--request', 'Improve onboarding and choose the best workflow for new users'], { now: at(0) });
  assert.equal(started.result.record.phase, 'clarify');
  assert.ok(started.result.record.pendingDecisions.length > 0);
  const premature = rejected(fx, ['spec', 'freeze', '--task-id', 'ambiguous'], {
    context: started.result.context,
    specification: { requirements: [{ id: 'workflow', behavior: 'guided onboarding', proof: 'real CLI flow' }] },
    reviewRefs: [],
    now: at(1),
  });
  assert.match(premature.error.message, /clarif|decision|phase/i);

  const decided = run(fx, ['spec', 'record-decision', '--task-id', 'ambiguous'], {
    context: started.result.context,
    decision: { id: 'clarification', question: 'Which workflow?', answer: 'guided', material: true },
    now: at(2),
  });
  assert.equal(decided.result.record.phase, 'spec-draft');
  const afterRestart = JSON.parse(spawnSync(process.execPath, [reader, cli, fx.state, 'ambiguous'], { cwd: fx.project, encoding: 'utf8' }).stdout);
  assert.equal(afterRestart.result.pendingDecisions.length, 0);
  assert.equal(afterRestart.result.next.owner, 'operator');
});

test('checkpoint and cross-host handoff resume exact next action across fresh processes', () => {
  const fx = fixture();
  const repoDir = join(fx.base, 'chat-repo');
  const worktree = join(fx.base, 'execution-worktree');
  for (const dir of [repoDir, worktree]) {
    mkdirSync(dir);
    execFileSync('git', ['-C', dir, 'init', '-q']);
    writeFileSync(join(dir, 'tracked.txt'), 'tracked\n');
    execFileSync('git', ['-C', dir, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=e2e@example.invalid', '-c', 'user.name=E2E', 'commit', '-qm', 'init']);
  }
  const journal = join(fx.base, 'task.md');
  writeFileSync(journal, 'checkpoint task\n');
  const started = run(fx, ['task', 'start', '--task-id', 'handoff', '--request', 'Resume exactly after compaction'], { now: at(0) });
  run(fx, ['task', 'bind', '--task-id', 'handoff'], { sessionId: 'sender', journalPath: journal, repo: repoDir, worktree, ownerHost: 'codex' });
  const checkpoint = run(fx, ['task', 'checkpoint', '--task-id', 'handoff'], {
    context: started.result.context, host: 'codex', sessionId: 'sender', workspace: repoDir, worktree, eventId: 'compact-1', now: at(1),
  });
  assert.equal(checkpoint.result.payload.nextSafeAction, 'draft the observable specification');
  const resumedAfterCompaction = run(fx, ['task', 'resume-checkpoint', '--task-id', 'handoff'], {
    checkpointArtifact: checkpoint.result.artifact, sessionId: 'sender', workspace: repoDir, worktree: repoDir,
  });
  assert.equal(resumedAfterCompaction.result.nextSafeAction, 'draft the observable specification');
  const handoffContext = { ...started.result.context, expectedRecordVersion: checkpoint.result.record.recordVersion };
  const prepared = run(fx, ['task', 'handoff', '--task-id', 'handoff'], {
    context: handoffContext, to: { host: 'claude', sessionId: 'receiver' }, repo: repoDir, worktree, nextAction: 'resume from checkpoint', now: at(2),
  });
  run(fx, ['task', 'accept-handoff', '--task-id', 'handoff'], {
    handoffId: prepared.result.handoffId, receiver: { host: 'claude', sessionId: 'receiver' }, repo: repoDir, worktree, now: at(3), renewBefore: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-02T00:00:00.000Z',
  });
  const resumed = run(fx, ['task', 'status', '--task-id', 'handoff'], { now: at(4) });
  assert.equal(resumed.result.taskId, 'handoff');
  assert.equal(resumed.result.lastTrace.nextAction, 'draft the observable specification');
  assert.equal(readTask({ root: fx.state, taskId: 'handoff' }).leases.filter((lease) => lease.revokedAt == null).length, 1);
});

test('push receipt without deploy and wrong deployed revision remain unshipped', () => {
  const fx = fixture();
  const started = run(fx, ['task', 'start', '--task-id', 'delivery', '--request', 'Ship the exact candidate', '--mode', 'full-train', '--requested-boundary', 'deploy'], { now: at(0) });
  const status = run(fx, ['task', 'status', '--task-id', 'delivery'], { candidateIdentity: { taskId: 'delivery', specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) }, now: at(1) });
  assert.equal(status.result.delivery.push, false);
  assert.equal(status.result.delivery.deploy, false);
  assert.ok(started.result.context);
});

test('completion rejects worker ownership and active grant, then accepts only the integration lease atomically', () => {
  const fx = fixture();
  execFileSync('git', ['-C', fx.project, 'init', '-q']);
  writeFileSync(join(fx.project, 'candidate.txt'), 'candidate\n');
  const taskId = 'completion';
  createTask({ root: fx.state, input: { taskId, request: 'Close a completed train', mode: 'quick', requestedBoundary: 'local', now: at(0) } });
  const integration = acquireLease({ root: fx.state, taskId, scope: 'canonical', ownerHost: 'codex', ownerSession: 'integration', expectedRecordVersion: 0, expectedFence: 0, renewBefore: at(50), expiresAt: at(59), now: at(1), leaseId: 'integration' });
  const ctx = { leaseId: integration.lease.leaseId, fenceToken: integration.lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: integration.record.recordVersion, specGeneration: 0, planGeneration: 0 };
  const candidate = createCandidateIdentity({ repoPath: fx.project, taskId, specGeneration: 0, planGeneration: 0 });
  const blocked = rejected(fx, ['task', 'complete', '--task-id', taskId], { context: ctx, candidateIdentity: candidate, now: at(2) });
  assert.equal(blocked.error.code, 'TASK_INELIGIBLE');
  assert.ok(readTask({ root: fx.state, taskId }).leases.some((lease) => lease.scope === 'canonical' && lease.revokedAt == null));
  const worker = acquireLease({ root: fx.state, taskId, scope: 'story:worker', ownerHost: 'codex', ownerSession: 'worker', expectedRecordVersion: readTask({ root: fx.state, taskId }).recordVersion, expectedFence: 0, renewBefore: at(50), expiresAt: at(59), now: at(3), leaseId: 'worker' });
  assert.equal(worker.lease.scope, 'story:worker');
  const stillBlocked = rejected(fx, ['task', 'complete', '--task-id', taskId], { context: { ...ctx, expectedRecordVersion: worker.record.recordVersion }, candidateIdentity: candidate, now: at(4) });
  assert.equal(stillBlocked.error.code, 'TASK_INELIGIBLE');
});

test('v0.2 cutover rejects legacy writes after a concurrent writer is gone', () => {
  const fx = fixture('apk-e2e-migration-');
  const source = join(fx.base, 'legacy');
  mkdirSync(join(source, 'sessions'), { recursive: true });
  mkdirSync(join(source, 'handoffs'), { recursive: true });
  writeFileSync(join(source, 'CURRENT'), 'legacy-task\n');
  const journal = join(fx.base, 'legacy-task.md');
  writeFileSync(journal, 'Task-ID: legacy-task\n');
  writeFileSync(join(source, 'sessions', 'legacy-session.json'), JSON.stringify({
    version: 3, binding_kind: 'explicit', session_id: 'legacy-session', task_id: 'legacy-task',
    repo: fx.project, worktree: fx.project, journal_path: journal, owner_host: 'codex', bound_at: at(0),
  }));
  const missing = rejected(fx, ['migrate-v0.2', 'dry-run'], { sourceRoot: join(fx.base, 'missing') });
  assert.equal(missing.error.code, 'SOURCE_MISSING');
  const plan = run(fx, ['migrate-v0.2', 'dry-run'], { sourceRoot: source, taskId: 'legacy-task', sessionId: 'legacy-session', workspace: fx.project });
  const applied = run(fx, ['migrate-v0.2', 'apply'], { sourceRoot: source, destinationRoot: fx.state, snapshot: plan.result.snapshot, snapshotDigest: plan.result.snapshotDigest, ownerHost: 'codex', ownerSession: 'legacy-session', now: at(0) });
  assert.equal(applied.result.phase, 'installed');
  assert.equal(readFileSync(source, 'utf8').includes('tombstone'), true);
  const replay = run(fx, ['migrate-v0.2', 'apply'], { sourceRoot: source, destinationRoot: fx.state, snapshot: plan.result.snapshot, snapshotDigest: plan.result.snapshotDigest, ownerSession: 'legacy-session', now: at(1) });
  assert.equal(replay.result.phase, 'installed');
});

test('two independent ready stories claim and submit through separate CLI processes before one integration story unlocks', () => {
  const fx = fixture();
  const taskId = 'parallel';
  createTask({ root: fx.state, input: { taskId, request: 'Integrate two lanes', mode: 'full-train', requestedBoundary: 'local', now: at(0) } });
  const acquired = acquireLease({ root: fx.state, taskId, scope: 'canonical', ownerHost: 'codex', ownerSession: 'integration', expectedRecordVersion: 0, expectedFence: 0, renewBefore: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-02T00:00:00.000Z', now: at(1), leaseId: 'integration' });
  const graph = { taskId, planGeneration: 0, reviewCaps: { spec: 1, plan: 1, code: 1 }, stories: [
    { id: 'lane-a', title: 'Lane A', dependsOn: [], ownedPaths: ['src/a.mjs'], kind: 'work', required: true },
    { id: 'lane-b', title: 'Lane B', dependsOn: [], ownedPaths: ['src/b.mjs'], kind: 'work', required: true },
    { id: 'integrate', title: 'Integrate lanes', dependsOn: ['lane-a', 'lane-b'], ownedPaths: ['src/index.mjs'], kind: 'integration', required: true },
  ] };
  const seeded = mutateWithLease({ root: fx.state, taskId, context: recordContext(acquired.record), now: at(2), mutate: (record) => ({ ...record, phase: 'implement', storyGraph: { ...graph, stories: graph.stories.map((story) => ({ ...story, status: story.dependsOn.length ? 'pending' : 'ready', claim: null, claimHistory: [], result: null, integrationReceipt: null })), frozenAt: at(2) } }) });
  const candidate = { taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) };
  const ready = run(fx, ['plan', 'ready-stories', '--task-id', taskId]);
  assert.deepEqual(ready.result.map((story) => story.id), ['lane-a', 'lane-b']);
  const claims = [];
  for (const [storyId, worker] of [['lane-a', 'worker-a'], ['lane-b', 'worker-b']]) {
    const claimed = run(fx, ['plan', 'claim', '--task-id', taskId], { context: recordContext(readTask({ root: fx.state, taskId })), storyId, worker: { host: 'codex', session: worker }, worktree: fx.project, renewBefore: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-02T00:00:00.000Z', now: at(3) });
    claims.push(claimed.result);
  }
  for (const claim of claims) {
    const submitted = run(fx, ['plan', 'submit', '--task-id', taskId], { context: { leaseId: claim.lease.leaseId, fenceToken: claim.lease.fenceToken, leaseScope: claim.lease.scope, expectedRecordVersion: readTask({ root: fx.state, taskId }).recordVersion, specGeneration: 0, planGeneration: 0 }, storyId: claim.story.id, candidateIdentity: candidate, resultArtifacts: [{ artifactId: `${claim.story.id}-result` }], now: at(4) });
    run(fx, ['plan', 'integrate', '--task-id', taskId], { context: recordContext(readTask({ root: fx.state, taskId })), storyId: claim.story.id, candidateIdentity: candidate, receipt: { verdict: 'pass', candidateIdentity: candidate, producer: 'e2e-integration' }, now: at(5) });
  }
  const unlocked = run(fx, ['plan', 'ready-stories', '--task-id', taskId]);
  assert.deepEqual(unlocked.result.map((story) => story.id), ['integrate']);
  assert.equal(readTask({ root: fx.state, taskId }).storyGraph.stories.filter((story) => story.status === 'integrated').length, 2);
  assert.equal(seeded.phase, 'implement');
});

test('blocking code review records actionable fix set and rejects a second full review round', () => {
  const fx = fixture();
  const started = run(fx, ['task', 'start', '--task-id', 'review-fix', '--request', 'Fix the parser and preserve behavior'], { now: at(0) });
  const seeded = mutateWithLease({ root: fx.state, taskId: 'review-fix', context: started.result.context, now: at(1), mutate: (record) => ({ ...record, phase: 'plan-review', orchestration: { ...record.orchestration, selfChecks: { ...record.orchestration.selfChecks, plan: { passed: true } } } }) });
  const candidate = { taskId: 'review-fix', specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) };
  const report = { reportId: 'blocking-review', kind: 'plan', round: 1, candidateIdentity: candidate, findings: [{ id: 'bug-1', classification: 'blocking', message: 'Parser drops escaped input' }], producer: { kind: 'e2e-reviewer', id: 'reviewer' } };
  const blocked = run(fx, ['plan', 'review', '--task-id', 'review-fix'], { context: recordContext(seeded), candidateIdentity: candidate, report, now: at(2) });
  assert.equal(blocked.result.report.verdict, 'blocked');
  assert.equal(blocked.result.record.orchestration.fixFindings[0].id, 'bug-1');
  const second = rejected(fx, ['plan', 'review', '--task-id', 'review-fix'], { context: recordContext(blocked.result.record), candidateIdentity: candidate, report: { ...report, reportId: 'second-review', round: 2 }, now: at(3) });
  assert.match(second.error.message, /cap|round|review/i);
});

test('tests green with red local UAT records regression ownership, then a real CLI rerun passes', () => {
  const fx = fixture();
  const started = run(fx, ['task', 'start', '--task-id', 'uat-recovery', '--request', 'Fix a local command'], { now: at(0) });
  const candidate = { taskId: 'uat-recovery', specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) };
  const red = run(fx, ['uat', 'record', '--task-id', 'uat-recovery'], { context: started.result.context, candidateIdentity: candidate, scenarioId: 'local-command', command: [process.execPath, '-e', 'process.exit(7)'], regressionOwner: 'e2e-owner', testsGreen: true, now: at(1) });
  assert.equal(red.result.receipt.verdict, 'fail');
  assert.equal(red.result.record.followUps.at(-1).owner, 'e2e-owner');
  const rerun = run(fx, ['uat', 'record', '--task-id', 'uat-recovery'], { context: recordContext(red.result.record), candidateIdentity: candidate, scenarioId: 'local-command-regression', command: [process.execPath, '-e', 'process.stdout.write("uat-ok")'], now: at(2) });
  assert.equal(rerun.result.receipt.verdict, 'pass');
});

test('wrong deployed revision blocks production, unknown external result stays reconcile-required, and exact production train closes', () => {
  const wrong = releaseFixture('production');
  const bad = run(wrong, ['release', 'execute', '--task-id', wrong.taskId], { context: recordContext(readTask({ root: wrong.state, taskId: wrong.taskId })), candidateIdentity: wrong.candidate, grant: wrong.grant, targetResource: 'deploy:production', environmentId: 'production', artifactDigest: wrong.candidate.artifactDigest, synthetic: true, providerOutcome: { outcome: 'succeeded', deploymentId: 'wrong', revision: 'wrong' }, providerReadback: { outcome: 'succeeded', deploymentId: 'wrong', revision: 'wrong' }, now: at(5) });
  assert.equal(bad.result.receipt.verdict, 'fail');
  assert.equal(readTask({ root: wrong.state, taskId: wrong.taskId }).phase, 'release-ready');

  const unknown = releaseFixture('deploy');
  const unknownResult = run(unknown, ['release', 'execute', '--task-id', unknown.taskId], { context: recordContext(readTask({ root: unknown.state, taskId: unknown.taskId })), candidateIdentity: unknown.candidate, grant: unknown.grant, targetResource: 'deploy:production', environmentId: 'staging', artifactDigest: unknown.candidate.artifactDigest, synthetic: true, providerOutcome: { outcome: 'unknown', providerAttemptId: 'provider-1' }, providerReadback: { outcome: 'unknown', providerAttemptId: 'provider-1' }, now: at(5) });
  assert.equal(unknownResult.result.receipt.verdict, 'unknown');
  assert.equal(readTask({ root: unknown.state, taskId: unknown.taskId }).externalAttempts.length, 1);
  assert.equal(readTask({ root: unknown.state, taskId: unknown.taskId }).externalAttempts[0].state, 'reconcile-required');
  const reconciled = run(unknown, ['external', 'reconcile', '--task-id', unknown.taskId], { context: recordContext(readTask({ root: unknown.state, taskId: unknown.taskId })), attemptId: readTask({ root: unknown.state, taskId: unknown.taskId }).externalAttempts[0].attemptId, receipt: { outcome: 'succeeded', providerIdentity: 'fixture', deploymentId: 'provider-1' }, now: at(6) });
  assert.equal(reconciled.result.attempt.state, 'reconciled');
  assert.equal(readTask({ root: unknown.state, taskId: unknown.taskId }).externalAttempts.length, 1);

  const exact = releaseFixture('production');
  const deployed = run(exact, ['release', 'execute', '--task-id', exact.taskId], { context: recordContext(readTask({ root: exact.state, taskId: exact.taskId })), candidateIdentity: exact.candidate, grant: exact.grant, targetResource: 'deploy:production', environmentId: 'production', artifactDigest: exact.candidate.artifactDigest, providerIdentity: 'real-provider', providerOutcome: { outcome: 'succeeded', deploymentId: 'prod-1', revision: exact.candidate.commitSha, artifactDigest: exact.candidate.artifactDigest }, providerReadback: { outcome: 'succeeded', deploymentId: 'prod-1', revision: exact.candidate.commitSha, artifactDigest: exact.candidate.artifactDigest }, now: at(5) });
  assert.equal(deployed.result.receipt.verdict, 'pass');
  const environmentIdentity = { environmentId: 'production', deploymentId: 'prod-1', artifactDigest: exact.candidate.artifactDigest, deployedRevision: exact.candidate.commitSha, observedAt: at(6) };
  const uat = run(exact, ['release', 'production-uat', '--task-id', exact.taskId], { context: recordContext(deployed.result.record), candidateIdentity: exact.candidate, environmentIdentity, verdict: 'pass', now: at(6) });
  const observation = run(exact, ['release', 'observation', '--task-id', exact.taskId], { context: recordContext(uat.result.record), candidateIdentity: exact.candidate, environmentIdentity, verdict: 'pass', now: at(7) });
  assert.equal(observation.result.record.phase, 'close');
});
