import { randomUUID } from 'node:crypto';

import { appendLeaseToRecord, currentFence, mutateWithLease } from './leases.mjs';
import { assertTaskId } from './schema.mjs';
import { StoreError } from './store.mjs';

const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REVIEW_KINDS = ['spec', 'plan', 'code'];
const FINDING_CLASSES = ['blocking', 'deferred', 'approved-expansion'];

export class StoryError extends StoreError {
  constructor(code, message, details = {}, cause) {
    super(code, message, details, cause);
    this.name = 'StoryError';
  }
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoryError('INVALID_STORY_GRAPH', `${label} must be an object`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StoryError('INVALID_STORY_GRAPH', `${label} must be a non-empty string`);
  }
  return value;
}

function normalPath(value, storyId) {
  const path = nonEmpty(value, `story ${storyId} owned path`).replace(/^\.\//, '').replace(/\/+$/, '');
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new StoryError('INVALID_STORY_PATH', `Story ${storyId} has unsafe owned path ${value}`);
  }
  return path;
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function storyMap(stories) {
  return new Map(stories.map((story) => [story.id, story]));
}

function reaches(storiesById, from, target, visited = new Set()) {
  if (from === target) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  const story = storiesById.get(from);
  return story?.dependsOn.some((dependency) => reaches(storiesById, dependency, target, visited)) ?? false;
}

function assertAcyclic(storiesById) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new StoryError('STORY_CYCLE', `Story dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of storiesById.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of storiesById.keys()) visit(id);
}

export function validateStoryGraph(input) {
  const graph = object(input, 'story graph');
  try {
    assertTaskId(graph.taskId);
  } catch (error) {
    throw new StoryError('INVALID_STORY_GRAPH', error.message, {}, error);
  }
  if (!isNonNegativeInteger(graph.planGeneration)) {
    throw new StoryError('INVALID_STORY_GRAPH', 'planGeneration must be a non-negative integer');
  }
  const caps = object(graph.reviewCaps, 'reviewCaps');
  for (const kind of REVIEW_KINDS) {
    if (!isNonNegativeInteger(caps[kind])) throw new StoryError('INVALID_STORY_GRAPH', `reviewCaps.${kind} must be a non-negative integer`);
  }
  if (!Array.isArray(graph.stories) || graph.stories.length === 0) {
    throw new StoryError('INVALID_STORY_GRAPH', 'stories must be a non-empty array');
  }
  const seen = new Set();
  const stories = graph.stories.map((raw) => {
    const value = object(raw, 'story');
    const id = nonEmpty(value.id, 'story id');
    if (!STORY_ID.test(id)) throw new StoryError('INVALID_STORY_GRAPH', `Invalid story id ${id}`);
    if (seen.has(id)) throw new StoryError('DUPLICATE_STORY', `Duplicate story ${id}`);
    seen.add(id);
    if (!Array.isArray(value.dependsOn)) throw new StoryError('INVALID_STORY_GRAPH', `Story ${id} dependsOn must be an array`);
    if (!Array.isArray(value.ownedPaths)) throw new StoryError('INVALID_STORY_GRAPH', `Story ${id} ownedPaths must be an array`);
    const dependsOn = [...new Set(value.dependsOn.map((dependency) => nonEmpty(dependency, `story ${id} dependency`)))];
    const ownedPaths = [...new Set(value.ownedPaths.map((path) => normalPath(path, id)))].sort();
    const kind = value.kind ?? 'work';
    if (!['work', 'integration'].includes(kind)) throw new StoryError('INVALID_STORY_GRAPH', `Story ${id} has invalid kind ${kind}`);
    if (value.required !== undefined && typeof value.required !== 'boolean') {
      throw new StoryError('INVALID_STORY_GRAPH', `Story ${id} required must be boolean`);
    }
    return {
      id,
      title: nonEmpty(value.title, `story ${id} title`),
      dependsOn,
      ownedPaths,
      kind,
      required: value.required ?? true,
      status: dependsOn.length === 0 ? 'ready' : 'pending',
      claim: null,
      claimHistory: [],
      result: null,
      integrationReceipt: null,
    };
  });
  const byId = storyMap(stories);
  for (const story of stories) {
    for (const dependency of story.dependsOn) {
      if (!byId.has(dependency)) throw new StoryError('UNKNOWN_STORY_DEPENDENCY', `Story ${story.id} depends on unknown ${dependency}`);
      if (dependency === story.id) throw new StoryError('STORY_CYCLE', `Story ${story.id} depends on itself`);
    }
  }
  assertAcyclic(byId);
  if (stories.filter((story) => story.kind === 'integration').length > 1) {
    throw new StoryError('MULTIPLE_INTEGRATION_STORIES', 'A graph may contain at most one integration story');
  }
  for (let leftIndex = 0; leftIndex < stories.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < stories.length; rightIndex += 1) {
      const left = stories[leftIndex];
      const right = stories[rightIndex];
      const ordered = reaches(byId, left.id, right.id) || reaches(byId, right.id, left.id);
      if (!ordered && left.ownedPaths.some((path) => right.ownedPaths.some((other) => pathsOverlap(path, other)))) {
        throw new StoryError('PARALLEL_PATH_CONFLICT', `Independent stories ${left.id} and ${right.id} own overlapping paths`);
      }
    }
  }
  return {
    taskId: graph.taskId,
    planGeneration: graph.planGeneration,
    reviewCaps: { spec: caps.spec, plan: caps.plan, code: caps.code },
    stories,
  };
}

function graphOf(record) {
  if (!record.storyGraph) throw new StoryError('STORY_GRAPH_MISSING', `Task ${record.taskId} has no frozen story graph`);
  return record.storyGraph;
}

function findStory(record, storyId) {
  const story = graphOf(record).stories.find((item) => item.id === storyId);
  if (!story) throw new StoryError('STORY_NOT_FOUND', `Story ${storyId} does not exist`);
  return story;
}

function replaceStory(record, replacement) {
  return {
    ...record,
    storyGraph: {
      ...record.storyGraph,
      stories: record.storyGraph.stories.map((story) => story.id === replacement.id ? replacement : story),
    },
  };
}

export function freezeStoryGraph({ root, taskId, context, graph, now = new Date().toISOString() }) {
  const validated = validateStoryGraph(graph);
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      if (current.storyGraph !== null) throw new StoryError('STORY_GRAPH_ALREADY_FROZEN', 'Story graph is already frozen');
      if (validated.taskId !== current.taskId) throw new StoryError('STORY_TASK_MISMATCH', 'Story graph task does not match the record');
      if (validated.planGeneration !== current.planGeneration) {
        throw new StoryError('STORY_PLAN_GENERATION_MISMATCH', 'Story graph plan generation is stale');
      }
      return { ...current, storyGraph: { ...validated, frozenAt: now } };
    },
  });
  return { graph: record.storyGraph, record };
}

export function getReadyStories(record) {
  if (!record.storyGraph) return [];
  return record.storyGraph.stories.filter((story) => story.status === 'ready').map((story) => structuredClone(story));
}

export function claimStory({
  root,
  taskId,
  context,
  storyId,
  worker,
  worktree,
  renewBefore,
  expiresAt,
  now = new Date().toISOString(),
  leaseId = randomUUID(),
}) {
  object(worker, 'worker');
  nonEmpty(worker.host, 'worker.host');
  nonEmpty(worker.session, 'worker.session');
  nonEmpty(worktree, 'worktree');
  let claimed;
  let lease;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      const story = findStory(current, storyId);
      if (story.status !== 'ready' || story.claim !== null) {
        throw new StoryError('STORY_NOT_READY', `Story ${storyId} is ${story.status}`);
      }
      const leaseScope = `story:${storyId}`;
      const appended = appendLeaseToRecord(current, {
        taskId,
        scope: leaseScope,
        ownerHost: worker.host,
        ownerSession: worker.session,
        expectedFence: currentFence(current, leaseScope),
        renewBefore,
        expiresAt,
        now,
        leaseId,
      });
      lease = appended.lease;
      claimed = {
        ...story,
        status: 'claimed',
        claim: { leaseId, fenceToken: lease.fenceToken, worker: structuredClone(worker), worktree, claimedAt: now },
      };
      return replaceStory(appended.record, claimed);
    },
  });
  return { story: claimed, lease, record };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sameGeneration(left, right) {
  return left?.taskId === right?.taskId
    && left?.specGeneration === right?.specGeneration
    && left?.planGeneration === right?.planGeneration;
}

export function submitStoryResult({
  root,
  taskId,
  context,
  storyId,
  candidateIdentity,
  resultArtifacts,
  now = new Date().toISOString(),
}) {
  object(candidateIdentity, 'candidateIdentity');
  if (!Array.isArray(resultArtifacts) || resultArtifacts.length === 0 || resultArtifacts.some((artifact) => artifact === null || typeof artifact !== 'object')) {
    throw new StoryError('INVALID_STORY_RESULT', 'resultArtifacts must contain at least one artifact reference');
  }
  let submitted;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: `story:${storyId}`,
    now,
    mutate: (current) => {
      const story = findStory(current, storyId);
      if (story.result !== null || ['submitted', 'integrated'].includes(story.status)) {
        throw new StoryError('STORY_RESULT_IMMUTABLE', `Story ${storyId} already has a result`);
      }
      if (story.status !== 'claimed' || story.claim?.leaseId !== context.leaseId) {
        throw new StoryError('STORY_NOT_CLAIMED', `Story ${storyId} is not claimed by lease ${context.leaseId}`);
      }
      submitted = {
        ...story,
        status: 'submitted',
        result: {
          candidateIdentity: structuredClone(candidateIdentity),
          artifacts: structuredClone(resultArtifacts),
          submittedAt: now,
        },
      };
      const withStory = replaceStory(current, submitted);
      return {
        ...withStory,
        leases: withStory.leases.map((lease) => lease.leaseId === context.leaseId
          ? { ...lease, revokedAt: now, revokeReason: 'story-result-submitted' }
          : lease),
      };
    },
  });
  return { story: submitted, record };
}

function unlockDependents(graph) {
  const integrated = new Set(graph.stories.filter((story) => story.status === 'integrated').map((story) => story.id));
  return {
    ...graph,
    stories: graph.stories.map((story) => story.status === 'pending' && story.dependsOn.every((dependency) => integrated.has(dependency))
      ? { ...story, status: 'ready' }
      : story),
  };
}

export function recordStoryReceipt({
  root,
  taskId,
  context,
  storyId,
  candidateIdentity,
  receipt,
  now = new Date().toISOString(),
}) {
  object(candidateIdentity, 'candidateIdentity');
  object(receipt, 'receipt');
  let integrated;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      const story = findStory(current, storyId);
      if (story.status !== 'submitted' || story.result === null) {
        throw new StoryError('STORY_RESULT_MISSING', `Story ${storyId} has no submitted result`);
      }
      if (stableJson(story.result.candidateIdentity) !== stableJson(candidateIdentity)) {
        throw new StoryError('STORY_CANDIDATE_MISMATCH', `Story ${storyId} receipt targets a different candidate`);
      }
      integrated = { ...story, status: 'integrated', integrationReceipt: structuredClone(receipt), integratedAt: now };
      const replaced = replaceStory(current, integrated);
      return { ...replaced, storyGraph: unlockDependents(replaced.storyGraph) };
    },
  });
  return { story: integrated, record };
}

/**
 * Revalidate integrated story receipts against the final candidate. Worker
 * results are immutable evidence of the worker candidate and are deliberately
 * left untouched; only the canonical integration receipt is refreshed.
 */
export function refreshStoryReceipts({
  root,
  taskId,
  context,
  candidateIdentity,
  revalidate,
  receipts,
  now = new Date().toISOString(),
}) {
  object(candidateIdentity, 'candidateIdentity');
  if (typeof revalidate !== 'function' && (receipts === null || typeof receipts !== 'object')) {
    throw new StoryError('STORY_REVALIDATION_REQUIRED', 'A trusted story revalidation callback or receipt map is required');
  }
  let refreshed = [];
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      const graph = graphOf(current);
      const stories = graph.stories.map((story) => {
        if (story.required === false) return story;
        if (story.status !== 'integrated' || !story.result) {
          throw new StoryError('STORY_RESULT_MISSING', `Story ${story.id} has no integrated immutable result`);
        }
        if (!sameGeneration(story.result.candidateIdentity, candidateIdentity)) {
          throw new StoryError('STORY_CANDIDATE_MISMATCH', `Story ${story.id} result belongs to another task generation`);
        }
        const nextReceipt = typeof revalidate === 'function'
          ? revalidate(structuredClone(story), structuredClone(candidateIdentity))
          : (Array.isArray(receipts) ? receipts.find((item) => item?.storyId === story.id)?.receipt : receipts[story.id]);
        object(nextReceipt, `story ${story.id} revalidation receipt`);
        if (nextReceipt.verdict !== 'pass') throw new StoryError('STORY_REVALIDATION_FAILED', `Story ${story.id} final-candidate revalidation failed`);
        if (!sameGeneration(nextReceipt.candidateIdentity, candidateIdentity)
            || nextReceipt.candidateIdentity?.contentFingerprint !== candidateIdentity.contentFingerprint) {
          throw new StoryError('STORY_CANDIDATE_MISMATCH', `Story ${story.id} revalidation targets a different candidate`);
        }
        refreshed = [...refreshed, story.id];
        return { ...story, integrationReceipt: { ...structuredClone(nextReceipt), refreshedAt: now } };
      });
      return { ...current, storyGraph: { ...graph, stories } };
    },
  });
  return { refreshed, record };
}

export const revalidateStoryReceipts = refreshStoryReceipts;
export const revalidateStoriesForCandidate = refreshStoryReceipts;

export function recoverExpiredStoryClaims({ root, taskId, context, now = new Date().toISOString() }) {
  const currentTime = Date.parse(now);
  if (Number.isNaN(currentTime)) throw new StoryError('INVALID_STORY_RECOVERY', 'now must be an ISO timestamp');
  let recoveredIds = [];
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      const graph = graphOf(current);
      const stories = graph.stories.map((story) => {
        if (story.status !== 'claimed' || !story.claim) return story;
        const lease = current.leases.find((item) => item.leaseId === story.claim.leaseId);
        const expired = !lease || lease.revokedAt != null || Date.parse(lease.expiresAt) <= currentTime;
        if (!expired) return story;
        recoveredIds = [...recoveredIds, story.id];
        return {
          ...story,
          status: 'ready',
          claim: null,
          claimHistory: [...story.claimHistory, { ...story.claim, recoveredAt: now, reason: lease?.revokedAt ? 'revoked' : 'expired' }],
        };
      });
      if (recoveredIds.length === 0) throw new StoryError('NO_EXPIRED_STORY_CLAIMS', 'No expired story claims are recoverable');
      return { ...current, storyGraph: { ...graph, stories } };
    },
  });
  return { recoveredIds, record };
}

export function selectFixFindings({ findings, round, cap }) {
  if (!Array.isArray(findings)) throw new StoryError('INVALID_FINDINGS', 'findings must be an array');
  if (!Number.isInteger(round) || round < 1 || !Number.isInteger(cap) || cap < 0) {
    throw new StoryError('INVALID_REVIEW_ROUND', 'round and cap must be valid integers');
  }
  if (round > cap) throw new StoryError('REVIEW_CAP_EXCEEDED', `Review round ${round} exceeds cap ${cap}`);
  for (const finding of findings) {
    if (!FINDING_CLASSES.includes(finding?.classification)) {
      throw new StoryError('INVALID_FINDING_CLASS', `Finding ${finding?.id ?? 'unknown'} has invalid classification`);
    }
  }
  return findings.filter((finding) => finding.classification === 'blocking' || finding.classification === 'approved-expansion');
}
