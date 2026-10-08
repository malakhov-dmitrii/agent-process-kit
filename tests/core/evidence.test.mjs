import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectGitWorktree } from '../../runtime/adapters/git.mjs';
import { createCandidateIdentity, recomputeCandidateIdentity } from '../../runtime/core/candidate.mjs';
import { assessReceiptFreshness } from '../../runtime/core/evidence.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'apk-candidate-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Evidence Test');
  writeFileSync(join(root, '.gitignore'), '.env\nignored-secret.txt\n');
  writeFileSync(join(root, 'src.txt'), 'one\n');
  git('add', '.gitignore', 'src.txt');
  git('commit', '-qm', 'initial');
  return { root, git };
}

function identity(fx, extra = {}) {
  return createCandidateIdentity({
    repoPath: fx.root,
    taskId: 'task-1',
    specGeneration: 1,
    planGeneration: 2,
    ...extra,
  });
}

test('fingerprint includes tracked and relevant untracked bytes, ignores secrets, and is path-order independent', () => {
  const fx = repo();
  writeFileSync(join(fx.root, 'draft.txt'), 'draft\n');
  writeFileSync(join(fx.root, '.env'), 'TOKEN=do-not-read\n');
  writeFileSync(join(fx.root, 'ignored-secret.txt'), 'do-not-read\n');
  const first = identity(fx);
  assert.deepEqual(first.contentManifest.map((item) => item.path), ['.gitignore', 'draft.txt', 'src.txt']);
  assert.equal(JSON.stringify(first).includes('do-not-read'), false);

  writeFileSync(join(fx.root, 'another.txt'), 'another\n');
  const second = identity(fx);
  assert.notEqual(second.contentFingerprint, first.contentFingerprint);
  assert.deepEqual(second.contentManifest.map((item) => item.path), ['.gitignore', 'another.txt', 'draft.txt', 'src.txt']);

  const inspected = inspectGitWorktree(fx.root, { pathOrder: 'reverse' });
  assert.equal(inspected.contentFingerprint, second.contentFingerprint);
});

test('identical bytes remain equal across amend/rebase metadata changes', () => {
  const fx = repo();
  const before = identity(fx);
  fx.git('commit', '--amend', '-qm', 'amended message');
  const after = identity(fx);
  assert.equal(after.contentFingerprint, before.contentFingerprint);
  assert.equal(after.commitSha === before.commitSha, false);
  assert.equal(after.taskId, before.taskId);
});

test('tracked deletion produces a new available content fingerprint', () => {
  const fx = repo();
  const before = identity(fx);
  fx.git('rm', '-q', 'src.txt');
  const after = identity(fx);
  assert.notEqual(after.contentFingerprint, before.contentFingerprint);
  assert.deepEqual(after.contentManifest.find((item) => item.path === 'src.txt'), {
    path: 'src.txt',
    sha256: null,
    size: 0,
    state: 'deleted',
  });
});

test('an unborn Git worktree still has a candidate identity without a commit SHA', () => {
  const root = mkdtempSync(join(tmpdir(), 'apk-unborn-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  writeFileSync(join(root, 'first.txt'), 'first\n');
  const candidate = createCandidateIdentity({
    repoPath: root,
    taskId: 'unborn-task',
    specGeneration: 0,
    planGeneration: 0,
  });
  assert.equal(candidate.commitSha, undefined);
  assert.deepEqual(candidate.contentManifest.map((item) => item.path), ['first.txt']);
  assert.match(candidate.contentFingerprint, /^[a-f0-9]{64}$/);
});

test('candidate recomputation accepts exact current identity and rejects stale supplied identity', () => {
  const fx = repo();
  const current = identity(fx);
  assert.deepEqual(recomputeCandidateIdentity({ repoPath: fx.root, taskId: current.taskId, specGeneration: current.specGeneration, planGeneration: current.planGeneration, candidateIdentity: current }), current);
  assert.throws(() => recomputeCandidateIdentity({ repoPath: fx.root, taskId: current.taskId, specGeneration: current.specGeneration, planGeneration: current.planGeneration, candidateIdentity: { ...current, contentFingerprint: 'f'.repeat(64) } }), (error) => error.code === 'CANDIDATE_MISMATCH');
});

test('full receipts become stale for tracked and relevant untracked changes', () => {
  const fx = repo();
  const before = identity(fx);
  const receipt = { candidateIdentity: before, coverage: 'full-candidate' };
  writeFileSync(join(fx.root, 'src.txt'), 'changed\n');
  const tracked = assessReceiptFreshness({ receipt, candidateIdentity: identity(fx) });
  assert.deepEqual(tracked, { status: 'stale', reason: 'content-changed' });

  writeFileSync(join(fx.root, 'new-draft.txt'), 'new\n');
  const untracked = assessReceiptFreshness({ receipt, candidateIdentity: identity(fx) });
  assert.deepEqual(untracked, { status: 'stale', reason: 'content-changed' });
});

test('scoped receipts stay current only with a proven disjoint path impact', () => {
  const fx = repo();
  const before = identity(fx);
  const receipt = {
    candidateIdentity: before,
    coverage: ['src/tests.mjs'],
    impactProof: { kind: 'path-disjoint', coveredPaths: ['src/tests.mjs'] },
  };
  writeFileSync(join(fx.root, 'docs.txt'), 'docs\n');
  assert.deepEqual(
    assessReceiptFreshness({ receipt, candidateIdentity: identity(fx) }),
    { status: 'current', reason: 'proven-disjoint-path-impact' },
  );

  mkdirSync(join(fx.root, 'src'), { recursive: true });
  writeFileSync(join(fx.root, 'src', 'tests.mjs'), 'test\n');
  assert.deepEqual(
    assessReceiptFreshness({ receipt, candidateIdentity: identity(fx) }),
    { status: 'stale', reason: 'covered-path-changed' },
  );
});

test('unknown scoped impact and environment/deployed revision mismatch fail closed', () => {
  const fx = repo();
  const before = identity(fx);
  writeFileSync(join(fx.root, 'docs.txt'), 'docs\n');
  const unknown = assessReceiptFreshness({
    receipt: { candidateIdentity: before, coverage: ['contract:runtime-api'] },
    candidateIdentity: identity(fx),
  });
  assert.deepEqual(unknown, { status: 'stale', reason: 'unknown-impact' });

  const environment = { environmentId: 'staging', deployedRevision: before.commitSha };
  const mismatch = assessReceiptFreshness({
    receipt: { candidateIdentity: before, coverage: 'full-candidate', environmentIdentity: environment },
    candidateIdentity: before,
    environmentIdentity: { environmentId: 'staging', deployedRevision: 'different-revision' },
  });
  assert.deepEqual(mismatch, { status: 'stale', reason: 'environment-mismatch' });
});

test('environment freshness ignores observation time but requires deployment identity', () => {
  const fx = repo();
  const before = identity(fx);
  const environment = { environmentId: 'staging', deploymentId: 'deploy-1', artifactDigest: 'd'.repeat(64), deployedRevision: before.commitSha, observedAt: '2026-10-08T12:00:00.000Z' };
  const receipt = { type: 'deploy', candidateIdentity: before, coverage: 'full-candidate', environmentIdentity: environment };
  assert.deepEqual(assessReceiptFreshness({ receipt, candidateIdentity: before, environmentIdentity: { ...environment, observedAt: '2026-10-08T13:00:00.000Z' } }), { status: 'current', reason: 'candidate-content-equal' });
  assert.equal(assessReceiptFreshness({ receipt, candidateIdentity: before, environmentIdentity: { ...environment, deploymentId: 'deploy-2' } }).reason, 'environment-mismatch');
});

test('same bytes cannot reuse evidence across task or frozen generation identity', () => {
  const fx = repo();
  const current = identity(fx);
  const cases = [
    [{ ...current, taskId: 'other-task' }, 'task-mismatch'],
    [{ ...current, specGeneration: current.specGeneration + 1 }, 'spec-generation-mismatch'],
    [{ ...current, planGeneration: current.planGeneration + 1 }, 'plan-generation-mismatch'],
  ];
  for (const [candidateIdentity, reason] of cases) {
    assert.deepEqual(
      assessReceiptFreshness({ receipt: { candidateIdentity: current, coverage: 'full-candidate' }, candidateIdentity }),
      { status: 'stale', reason },
    );
  }
});

test('scoped evidence requires explicit disjoint proof for covered contracts', () => {
  const fx = repo();
  const before = identity(fx);
  writeFileSync(join(fx.root, 'docs.txt'), 'docs\n');
  const receipt = {
    candidateIdentity: before,
    coverage: ['path:src/tests.mjs', 'contract:public-api'],
    impactProof: {
      kind: 'scoped-disjoint',
      coveredPaths: ['src/tests.mjs'],
      coveredContracts: ['public-api'],
      changedContracts: [],
    },
  };
  assert.deepEqual(
    assessReceiptFreshness({ receipt, candidateIdentity: identity(fx) }),
    { status: 'current', reason: 'proven-disjoint-impact' },
  );
  assert.deepEqual(
    assessReceiptFreshness({
      receipt: { ...receipt, impactProof: { ...receipt.impactProof, changedContracts: ['public-api'] } },
      candidateIdentity: identity(fx),
    }),
    { status: 'stale', reason: 'covered-contract-changed' },
  );
  const { changedContracts: omitted, ...incompleteProof } = receipt.impactProof;
  assert.equal(omitted.length, 0);
  assert.deepEqual(
    assessReceiptFreshness({ receipt: { ...receipt, impactProof: incompleteProof }, candidateIdentity: identity(fx) }),
    { status: 'stale', reason: 'unknown-impact' },
  );
});
