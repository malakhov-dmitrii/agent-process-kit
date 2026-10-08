import { inspectGitWorktree } from '../adapters/git.mjs';
import { assertTaskId } from './schema.mjs';

export function createCandidateIdentity({ repoPath, taskId, specGeneration, planGeneration }) {
  assertTaskId(taskId);
  if (!Number.isInteger(specGeneration) || specGeneration < 0) throw new TypeError('specGeneration must be a non-negative integer');
  if (!Number.isInteger(planGeneration) || planGeneration < 0) throw new TypeError('planGeneration must be a non-negative integer');
  const worktree = inspectGitWorktree(repoPath);
  return {
    taskId,
    specGeneration,
    planGeneration,
    contentFingerprint: worktree.contentFingerprint,
    ...(worktree.commitSha === undefined ? {} : { commitSha: worktree.commitSha }),
    contentManifest: worktree.contentManifest,
  };
}

export function resolveCandidateIdentity(input) {
  try {
    return { status: 'current', identity: createCandidateIdentity(input) };
  } catch (error) {
    if (error?.code !== 'IDENTITY_UNAVAILABLE') throw error;
    return { status: 'identity-unavailable', reason: 'identity-unavailable' };
  }
}

/** Recompute the worktree identity and optionally require an exact supplied identity. */
export function recomputeCandidateIdentity({ repoPath, taskId, specGeneration, planGeneration, candidateIdentity } = {}) {
  const identity = createCandidateIdentity({ repoPath, taskId, specGeneration, planGeneration });
  if (candidateIdentity !== undefined && !sameCandidateIdentity(identity, candidateIdentity)) {
    const error = new Error('supplied candidate identity does not match the current worktree');
    error.code = 'CANDIDATE_MISMATCH';
    error.current = identity;
    error.supplied = candidateIdentity;
    throw error;
  }
  return identity;
}

export function sameCandidateIdentity(left, right) {
  if (!left || !right) return false;
  return left.taskId === right.taskId
    && left.specGeneration === right.specGeneration
    && left.planGeneration === right.planGeneration
    && left.contentFingerprint === right.contentFingerprint
    && (left.commitSha ?? null) === (right.commitSha ?? null)
    && (left.artifactDigest ?? null) === (right.artifactDigest ?? null);
}
