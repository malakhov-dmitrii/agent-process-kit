import { canComplete, getDeliveryState, getEvidence, requiredEvidenceTypes } from './eligibility.mjs';

const DEFAULT_NEXT = {
  intake: ['orchestrator', 'resolve and bind the task'],
  clarify: ['operator', 'answer the pending material decision'],
  'spec-draft': ['orchestrator', 'draft observable owned requirements'],
  'spec-review': ['reviewer', 'review the frozen specification'],
  'plan-draft': ['orchestrator', 'build the executable story graph'],
  'plan-review': ['reviewer', 'challenge the implementation plan'],
  implement: ['worker', 'claim the next ready story'],
  'code-review': ['reviewer', 'review the integrated candidate'],
  'local-uat': ['orchestrator', 'run the real local path'],
  'release-ready': ['release-adapter', 'verify and grant the exact candidate'],
  release: ['release-adapter', 'execute or reconcile the external action'],
  'production-uat': ['orchestrator', 'run authenticated production acceptance'],
  observe: ['orchestrator', 'inspect the observation window'],
  close: ['orchestrator', 'reconcile completion eligibility'],
};

function lanes(record) {
  const stories = record.storyGraph?.stories ?? [];
  return {
    ready: stories.filter((story) => story.status === 'ready').map((story) => story.id),
    active: stories.filter((story) => story.status === 'claimed').map((story) => ({ id: story.id, claim: story.claim })),
    submitted: stories.filter((story) => story.status === 'submitted').map((story) => story.id),
    blocked: stories.filter((story) => story.status === 'blocked').map((story) => story.id),
  };
}

export function getStatus({ record, candidateIdentity, environmentIdentity, now = new Date().toISOString() }) {
  const stories = (record.storyGraph?.stories ?? []).filter((story) => story.required !== false);
  const evidence = getEvidence({ record, candidateIdentity, environmentIdentity });
  const required = requiredEvidenceTypes(record);
  const currentTypes = new Set(evidence.filter((item) => item.freshness.status === 'current').map((item) => item.type));
  const fallback = DEFAULT_NEXT[record.phase] ?? ['orchestrator', 'inspect the task state'];
  const completion = canComplete({ record, candidateIdentity, environmentIdentity, now });
  return {
    taskId: record.taskId,
    goal: record.request,
    mode: record.mode,
    requestedBoundary: record.requestedBoundary,
    status: record.status,
    phase: record.phase,
    lanes: lanes(record),
    progress: {
      completed: stories.filter((story) => story.status === 'integrated').length,
      total: stories.length,
    },
    lastTrace: record.lastTrace,
    evidence: {
      current: evidence.filter((item) => item.freshness.status === 'current').map((item) => item.receiptId),
      stale: evidence.filter((item) => item.freshness.status !== 'current').map((item) => ({ receiptId: item.receiptId, reason: item.freshness.reason })),
      missing: required.filter((type) => !currentTypes.has(type)),
    },
    delivery: getDeliveryState({ record, candidateIdentity, environmentIdentity, now }),
    pendingDecisions: structuredClone(record.pendingDecisions ?? []),
    loopWarning: (record.lastTrace?.attemptsSameCause ?? 0) >= 3,
    completion,
    next: {
      owner: record.lastTrace?.nextOwner ?? fallback[0],
      action: record.lastTrace?.nextAction ?? fallback[1],
    },
  };
}
