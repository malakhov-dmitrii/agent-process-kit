import { randomUUID } from 'node:crypto';

import {
  readArtifact,
  stageArtifact,
} from './artifacts.mjs';
import { mutateWithLease, acquireLease } from './leases.mjs';
import { resolvePhaseTransition } from './transitions.mjs';
import {
  DELIVERY_BOUNDARIES,
  TASK_MODES,
  validateStartTaskInput,
} from './schema.mjs';
import {
  createTask,
  readTask,
} from './store.mjs';
import { validateStoryGraph } from './stories.mjs';
import {
  getActionableFindings,
  validateReviewReport,
} from '../adapters/review.mjs';
import { canAdvance } from './eligibility.mjs';

const NATURAL_COMMANDS = [
  ['status', /^(?:дай\s+статус|status|статус)$/iu],
  ['continue', /^(?:\+|продолжай|continue|resume|дальше)$/iu],
  ['release', /^(?:кати|катим|выкати|ship|release)$/iu],
  ['pause', /^(?:pause|stop|пауза|стоп)$/iu],
];

const AMBIGUITY_MARKERS = [
  /\b(?:choose|decide|best|maybe|options?|trade[- ]?off|which)\b/iu,
  /\b(?:реши|решить|выбери|лучший|лучше|вариант|компромисс|как\s+лучше)\b/iu,
  /\?\s*$/u,
];
const FULL_TRAIN_MARKERS = [
  /\b(?:ralph|full[- ]?train|multi[- ]?story|auth(?:entication|orization)?|security|migration|production)\b/iu,
  /\b(?:многоэтап|несколько\s+историй|авторизац|безопасност|миграц|продакшен)\b/iu,
];
const QUICK_MARKERS = /\b(?:fix|rename|format|typo|spelling|docs?|metadata|update\s+(?:the\s+)?heading)\b/iu;

export class OrchestrationError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OrchestrationError';
    this.code = code;
    this.details = details;
  }
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new OrchestrationError('INVALID_ORCHESTRATION_INPUT', `${label} must be a non-empty string`);
  return value;
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OrchestrationError('INVALID_ORCHESTRATION_INPUT', `${label} must be an object`);
  return value;
}

function nowPlus(now, milliseconds) {
  return new Date(Date.parse(now) + milliseconds).toISOString();
}

function taskContext(lease, record) {
  return {
    leaseId: lease.leaseId,
    fenceToken: lease.fenceToken,
    leaseScope: lease.scope,
    expectedRecordVersion: record.recordVersion,
    specGeneration: record.specGeneration,
    planGeneration: record.planGeneration,
  };
}

function orchestration(record) {
  return {
    modeSelection: record.orchestration?.modeSelection ?? null,
    clarification: record.orchestration?.clarification ?? null,
    selfChecks: record.orchestration?.selfChecks ?? { spec: null, plan: null, code: null },
    drafts: record.orchestration?.drafts ?? { spec: null, plan: null },
    reviews: record.orchestration?.reviews ?? { spec: [], plan: [], code: [] },
    frozen: record.orchestration?.frozen ?? { spec: null, plan: null },
    fixFindings: record.orchestration?.fixFindings ?? [],
  };
}

function withOrchestration(record, changes = {}) {
  return { ...record, orchestration: { ...orchestration(record), ...changes } };
}

function appendArtifact(record, artifact) {
  if (record.artifacts.some((item) => item.artifactId === artifact.artifactId)) return record;
  return { ...record, artifacts: [...record.artifacts, artifact] };
}

function candidateFor(record, candidateIdentity) {
  object(candidateIdentity, 'candidateIdentity');
  if (candidateIdentity.taskId !== record.taskId
      || candidateIdentity.specGeneration !== record.specGeneration
      || candidateIdentity.planGeneration !== record.planGeneration) {
    throw new OrchestrationError('CANDIDATE_GENERATION_MISMATCH', 'Candidate is not bound to the current task generations', {
      expected: { taskId: record.taskId, specGeneration: record.specGeneration, planGeneration: record.planGeneration },
      received: candidateIdentity,
    });
  }
  nonEmpty(candidateIdentity.contentFingerprint, 'candidateIdentity.contentFingerprint');
  return structuredClone(candidateIdentity);
}

function phaseForReview(kind) {
  return kind === 'spec' ? 'spec-review' : kind === 'plan' ? 'plan-review' : 'code-review';
}

function reviewKindForPhase(phase) {
  if (phase === 'spec' || phase === 'spec-review') return 'spec';
  if (phase === 'plan' || phase === 'plan-review') return 'plan';
  if (phase === 'code' || phase === 'code-review') return 'code';
  throw new OrchestrationError('INVALID_REVIEW_KIND', `Unknown review phase ${phase}`);
}

function reportReference(report) {
  return report.artifact ?? { artifactId: report.reportId, reportId: report.reportId };
}

function assertReviewRefs(record, kind, refs) {
  if (!Array.isArray(refs) || refs.length !== 1) throw new OrchestrationError('REVIEW_REQUIRED', `Exactly one bounded ${kind} review is required before freeze`);
  const known = orchestration(record).reviews[kind] ?? [];
  const ref = refs[0];
  const found = known.find((item) => item.reportId === ref.reportId || item.artifactId === ref.artifactId);
  if (!found) throw new OrchestrationError('REVIEW_NOT_RECORDED', `${kind} review reference is not recorded by the integration writer`);
  if (record.mode !== 'quick' && found.independent !== true) {
    throw new OrchestrationError('INDEPENDENT_REVIEW_REQUIRED', `${kind} freeze requires exactly one independent review`);
  }
  if (found.verdict !== 'pass' || found.blockingFindings > 0) throw new OrchestrationError('REVIEW_BLOCKED', `${kind} review has blocking findings`);
  return found;
}

export function classifyNaturalCommand(input) {
  const value = String(input ?? '').trim();
  for (const [command, pattern] of NATURAL_COMMANDS) if (pattern.test(value)) return command;
  return 'task';
}

export function classifyNaturalTask(request, { modeOverride } = {}) {
  nonEmpty(request, 'request');
  if (modeOverride !== undefined && !TASK_MODES.includes(modeOverride)) throw new OrchestrationError('INVALID_MODE', `Unknown mode ${modeOverride}`);
  const text = request.trim();
  const ambiguity = AMBIGUITY_MARKERS.some((pattern) => pattern.test(text)) ? 'material' : 'low';
  let mode = 'standard';
  if (FULL_TRAIN_MARKERS.some((pattern) => pattern.test(text))) mode = 'full-train';
  else if (ambiguity === 'low' && QUICK_MARKERS.test(text)) mode = 'quick';
  if (modeOverride) mode = modeOverride;
  return { ambiguity, mode };
}

export function startTask({
  root,
  taskId,
  request,
  requestedBoundary = 'local',
  mode: explicitMode,
  modeOverride,
  ownerHost = 'orchestrator',
  ownerSession = `orchestrator:${process.pid}`,
  now = new Date().toISOString(),
} = {}) {
  const classification = classifyNaturalTask(request, { modeOverride: modeOverride ?? explicitMode });
  const selectedMode = modeOverride ?? explicitMode ?? classification.mode;
  if (!DELIVERY_BOUNDARIES.includes(requestedBoundary)) throw new OrchestrationError('INVALID_BOUNDARY', `Unknown delivery boundary ${requestedBoundary}`);
  const input = { taskId, request, requestedBoundary, mode: selectedMode, now };
  validateStartTaskInput(input);
  const initial = createTask({ root, input });
  const leaseResult = acquireLease({
    root,
    taskId,
    scope: 'canonical',
    ownerHost,
    ownerSession,
    expectedRecordVersion: initial.recordVersion,
    expectedFence: 0,
    renewBefore: nowPlus(now, 30 * 60 * 1000),
    expiresAt: nowPlus(now, 60 * 60 * 1000),
    now,
    leaseId: `integration-${randomUUID()}`,
  });
  const selectedReason = modeOverride || explicitMode
    ? 'operator mode override recorded at intake'
    : `deterministic selection from ${classification.ambiguity} ambiguity and task risk`;
  const pending = classification.ambiguity === 'material'
    ? [{ id: 'clarification', question: 'Resolve the material product, scope or delivery choice before specification.', material: true }]
    : [];
  const phase = pending.length ? 'clarify' : 'spec-draft';
  const decision = {
    id: `mode:${randomUUID()}`,
    kind: 'mode-selection',
    selected: selectedMode,
    source: modeOverride || explicitMode ? 'operator-override' : 'deterministic-intake',
    reason: selectedReason,
    recordedAt: now,
  };
  const record = mutateWithLease({
    root,
    taskId,
    context: taskContext(leaseResult.lease, leaseResult.record),
    requiredScope: 'canonical',
    now,
    mutate: (current) => withOrchestration({
      ...current,
      phase,
      decisions: [...current.decisions, decision, ...(pending.length ? [] : [{ id: `clarify-skip:${randomUUID()}`, kind: 'clarification-skip', reason: 'request is clear enough to specify without an interview', recordedAt: now }])],
      pendingDecisions: pending,
      lastTrace: { event: 'task-started', nextOwner: pending.length ? 'operator' : 'orchestrator', nextAction: pending.length ? 'answer the material clarification' : 'draft the observable specification', at: now },
    }, {
      modeSelection: decision,
      clarification: pending.length ? { status: 'required', reason: 'material ambiguity remains' } : { status: 'skipped', reason: 'clear task; no material decision remains' },
    }),
  });
  return { record, lease: leaseResult.lease, context: taskContext(leaseResult.lease, record), classification };
}

export function recordDecision({ root, taskId, context, decision, now = new Date().toISOString() } = {}) {
  object(decision, 'decision');
  nonEmpty(decision.id, 'decision.id');
  if (decision.material === true && (typeof decision.answer !== 'string' || decision.answer.trim() === '')) throw new OrchestrationError('MATERIAL_DECISION_REQUIRED', 'A material clarification decision needs a non-empty answer');
  let next;
  const record = mutateWithLease({
    root, taskId, context, requiredScope: 'canonical', now,
    mutate: (current) => {
      const pending = current.pendingDecisions ?? [];
      const remaining = pending.filter((item) => item.id !== decision.id);
      next = { ...structuredClone(decision), recordedAt: now };
      return { ...withOrchestration(current, { clarification: { status: 'resolved', decisionId: next.id } }), decisions: [...current.decisions, next], pendingDecisions: remaining, phase: current.phase === 'clarify' && remaining.length === 0 ? 'spec-draft' : current.phase };
    },
  });
  return { decision: next, record, context: { ...context, expectedRecordVersion: record.recordVersion } };
}

export function advancePhase({ root, taskId, context, targetPhase, facts = {}, now = new Date().toISOString() } = {}) {
  let transition;
  let gate;
  const record = mutateWithLease({
    root, taskId, context, requiredScope: 'canonical', now,
    mutate: (current) => {
      if (current.phase === 'clarify' && (current.pendingDecisions ?? []).length > 0) throw new OrchestrationError('CLARIFICATION_REQUIRED', 'Task remains in clarify until material decisions are recorded');
      const events = {
        'clarify->spec-draft': 'decisions-ready',
        'spec-draft->spec-review': 'spec-observable',
        'spec-review->plan-draft': 'review-approved',
        'plan-draft->plan-review': 'plan-complete',
        'plan-review->implement': 'review-approved',
        'implement->code-review': 'stories-integrated',
        'code-review->local-uat': 'review-approved',
        'local-uat->close': 'uat-passed',
        'local-uat->release-ready': 'uat-passed',
      };
      const event = facts.event ?? events[`${current.phase}->${targetPhase}`];
      if (!event) throw new OrchestrationError('UNKNOWN_PHASE_TRANSITION', `No orchestration event maps ${current.phase} to ${targetPhase}`);
      transition = resolvePhaseTransition({ from: current.phase, event, facts: { ...facts, recordedReason: facts.recordedReason ?? 'orchestration gate satisfied', requestedBoundary: current.requestedBoundary } });
      if (transition.to !== targetPhase) throw new OrchestrationError('PHASE_TARGET_MISMATCH', `Transition resolves to ${transition.to}, not ${targetPhase}`);
      gate = canAdvance({
        record: current,
        targetPhase,
        candidateIdentity: facts.candidateIdentity,
        environmentIdentity: facts.environmentIdentity,
        now,
      });
      if (!gate.allowed) {
        throw new OrchestrationError('PHASE_GATE_BLOCKED', `Cannot advance to ${targetPhase}`, { blockers: gate.blockers });
      }
      let next = { ...current, phase: transition.to };
      for (const effect of transition.effects ?? []) {
        if (effect === 'increment-spec-generation') next = { ...next, specGeneration: next.specGeneration + 1 };
        if (effect === 'increment-plan-generation') next = { ...next, planGeneration: next.planGeneration + 1 };
      }
      return {
        ...next,
        lastTrace: {
          event,
          effects: transition.effects ?? [],
          gate: gate ?? null,
          nextOwner: 'orchestrator',
          nextAction: `continue at ${transition.to}`,
          at: now,
        },
      };
    },
  });
  return { transition, gate, record, context: { ...context, expectedRecordVersion: record.recordVersion, specGeneration: record.specGeneration, planGeneration: record.planGeneration } };
}

function draftArtifact({ root, taskId, type, generation, payload, candidateIdentity, now }) {
  return stageArtifact({ root, taskId, type, generation, payload, candidateIdentity, producer: { kind: 'orchestrator', id: 'control-plane' }, sourceInputs: [], now });
}

export function recordSpecification({ root, taskId, context, specification, candidateIdentity, now = new Date().toISOString() } = {}) {
  object(specification, 'specification');
  const requirements = specification.requirements;
  if (!Array.isArray(requirements) || requirements.length === 0 || requirements.some((item) => !item?.id || !item?.behavior || !item?.proof)) throw new OrchestrationError('SPEC_NOT_EXECUTION_READY', 'Every specification requirement needs an id, observable behavior and proof');
  const current = readTask({ root, taskId });
  const candidate = candidateIdentity ? candidateFor(current, candidateIdentity) : undefined;
  const artifact = draftArtifact({ root, taskId, type: 'specification', generation: current.specGeneration, payload: specification, candidateIdentity: candidate, now });
  const record = mutateWithLease({ root, taskId, context, requiredScope: 'canonical', now, mutate: (recordValue) => {
    if (recordValue.phase !== 'spec-draft') throw new OrchestrationError('SPEC_DRAFT_REQUIRED', 'Specification can only be recorded in spec-draft');
    return withOrchestration({ ...appendArtifact({ ...recordValue, phase: 'spec-review' }, artifact), lastTrace: { event: 'spec-recorded', nextOwner: 'orchestrator', nextAction: 'run self-check and bounded spec review', at: now } }, { drafts: { ...orchestration(recordValue).drafts, spec: specification } });
  }});
  return { artifact, record, context: { ...context, expectedRecordVersion: record.recordVersion } };
}

export const recordSpec = recordSpecification;

export function recordPlan({ root, taskId, context, plan, candidateIdentity, now = new Date().toISOString() } = {}) {
  object(plan, 'plan');
  const requirements = plan.requirements;
  if (!Array.isArray(requirements) || requirements.length === 0 || requirements.some((item) => !item?.id || !Array.isArray(item.storyIds) || item.storyIds.length === 0 || !item.proof)) throw new OrchestrationError('PLAN_NOT_EXECUTION_READY', 'Every plan requirement must map to stories and proof');
  const current = readTask({ root, taskId });
  const candidate = candidateIdentity ? candidateFor(current, candidateIdentity) : undefined;
  const artifact = draftArtifact({ root, taskId, type: 'plan', generation: current.planGeneration, payload: plan, candidateIdentity: candidate, now });
  const record = mutateWithLease({ root, taskId, context, requiredScope: 'canonical', now, mutate: (recordValue) => {
    if (recordValue.phase !== 'plan-draft') throw new OrchestrationError('PLAN_DRAFT_REQUIRED', 'Plan can only be recorded in plan-draft');
    const specIds = new Set((orchestration(recordValue).drafts.spec?.requirements ?? []).map((item) => item.id));
    if ([...specIds].some((id) => !requirements.some((item) => item.id === id))) throw new OrchestrationError('PLAN_PROOF_GAP', 'Plan does not map every specification requirement');
    return withOrchestration({ ...appendArtifact({ ...recordValue, phase: 'plan-review' }, artifact), lastTrace: { event: 'plan-recorded', nextOwner: 'orchestrator', nextAction: 'run self-check and bounded plan review', at: now } }, { drafts: { ...orchestration(recordValue).drafts, plan } });
  }});
  return { artifact, record, context: { ...context, expectedRecordVersion: record.recordVersion } };
}

export function recordSelfCheck({ root, taskId, context, phase, report, candidateIdentity, now = new Date().toISOString() } = {}) {
  if (!['spec', 'plan', 'code'].includes(phase)) throw new OrchestrationError('INVALID_REVIEW_KIND', `Unknown self-check phase ${phase}`);
  object(report, 'self-check report');
  if (report.passed !== true) throw new OrchestrationError('SELF_CHECK_FAILED', `${phase} self-check must pass before independent review`);
  const current = readTask({ root, taskId });
  if (current.phase !== phaseForReview(phase)) {
    throw new OrchestrationError('SELF_CHECK_PHASE_MISMATCH', `${phase} self-check requires ${phaseForReview(phase)} phase`);
  }
  const candidate = candidateIdentity ? candidateFor(current, candidateIdentity) : undefined;
  const artifact = draftArtifact({ root, taskId, type: 'self-check', generation: phase === 'spec' ? current.specGeneration : current.planGeneration, payload: { phase, ...report }, candidateIdentity: candidate, now });
  const record = mutateWithLease({ root, taskId, context, requiredScope: 'canonical', now, mutate: (recordValue) => withOrchestration({ ...appendArtifact(recordValue, artifact), lastTrace: { event: `${phase}-self-check`, nextOwner: 'reviewer', nextAction: `run one bounded independent ${phase} review`, at: now } }, { selfChecks: { ...orchestration(recordValue).selfChecks, [phase]: { ...report, artifactId: artifact.artifactId, recordedAt: now } } }) });
  return { artifact, record, context: { ...context, expectedRecordVersion: record.recordVersion } };
}

export function recordReview({ root, taskId, context, phase, candidateIdentity, report, now = new Date().toISOString() } = {}) {
  const normalized = validateReviewReport(report);
  if (normalized.taskId !== taskId) throw new OrchestrationError('REVIEW_TASK_MISMATCH', 'Review report belongs to another task');
  const kind = reviewKindForPhase(phase ?? normalized.kind);
  if (normalized.kind !== kind) throw new OrchestrationError('REVIEW_PHASE_MISMATCH', `A ${normalized.kind} review belongs to ${phaseForReview(normalized.kind)}`);
  const current = readTask({ root, taskId });
  const existing = orchestration(current).reviews[kind] ?? [];
  if (normalized.independent && existing.filter((item) => item.independent).length >= 1) throw new OrchestrationError('REVIEW_CAP_EXCEEDED', `The ${kind} independent review cap is one`);
  if (current.phase !== phaseForReview(kind)) throw new OrchestrationError('REVIEW_PHASE_MISMATCH', `Task must be in ${phaseForReview(kind)} to record a review`);
  if (!orchestration(current).selfChecks[kind]) throw new OrchestrationError('SELF_CHECK_REQUIRED', `A passing ${kind} self-check is required before independent review`);
  const candidate = candidateFor(current, candidateIdentity ?? normalized.candidateIdentity);
  const artifact = report.artifact ?? draftArtifact({ root, taskId, type: 'review-report', generation: Math.max(current.specGeneration, current.planGeneration), payload: normalized, candidateIdentity: candidate, now });
  if (report.artifact) readArtifact({ root, taskId, artifact: report.artifact });
  const actionable = getActionableFindings(normalized);
  const receipt = { receiptId: `${kind}-review:${normalized.reportId}`, type: `${kind}-review`, verdict: normalized.verdict, candidateIdentity: candidate, reportId: normalized.reportId, artifactId: artifact.artifactId, blockingFindings: normalized.blockingFindings, approvedExpansions: normalized.approvedExpansions, coverage: 'full-candidate', producer: normalized.producer, createdAt: now };
  const reviewEntry = { ...normalized, artifactId: artifact.artifactId, candidateIdentity: candidate, actionableFindingIds: actionable.map((item) => item.id), recordedAt: now };
  const record = mutateWithLease({ root, taskId, context, requiredScope: 'canonical', now, mutate: (recordValue) => withOrchestration({ ...appendArtifact({ ...recordValue, evidence: [...recordValue.evidence, receipt] }, artifact), lastTrace: { event: `${kind}-review-recorded`, nextOwner: 'orchestrator', nextAction: normalized.verdict === 'pass' ? `freeze ${kind}` : `repair ${kind} blockers`, at: now } }, { reviews: { ...orchestration(recordValue).reviews, [kind]: [...orchestration(recordValue).reviews[kind], reviewEntry] }, fixFindings: [...orchestration(recordValue).fixFindings, ...actionable.map((item) => ({ ...item, kind, reportId: normalized.reportId }))] }) });
  return { report: reviewEntry, findingSet: { all: normalized.findings, fix: actionable, deferred: normalized.findings.filter((item) => item.classification === 'deferred') }, record, context: { ...context, expectedRecordVersion: record.recordVersion } };
}

export function freezeSpec({ root, taskId, context, specification, reviewRefs, candidateIdentity, now = new Date().toISOString() } = {}) {
  object(specification, 'specification');
  const current = readTask({ root, taskId });
  const candidate = candidateIdentity ? candidateFor(current, candidateIdentity) : undefined;
  const state = orchestration(current);
  if (current.phase !== 'spec-review' || !state.selfChecks.spec) throw new OrchestrationError('SPEC_REVIEW_REQUIRED', 'Specification freeze requires a passing self-check and spec-review phase');
  const review = assertReviewRefs(current, 'spec', reviewRefs);
  const artifact = draftArtifact({ root, taskId, type: 'frozen-spec', generation: current.specGeneration, payload: specification, candidateIdentity: candidate, now });
  const record = mutateWithLease({ root, taskId, context, requiredScope: 'canonical', now, mutate: (recordValue) => withOrchestration({ ...appendArtifact({ ...recordValue, phase: 'plan-draft' }, artifact), lastTrace: { event: 'spec-frozen', nextOwner: 'orchestrator', nextAction: 'draft an executable plan', at: now } }, { frozen: { ...orchestration(recordValue).frozen, spec: { artifactId: artifact.artifactId, reviewId: review.reportId, generation: recordValue.specGeneration, frozenAt: now } } }) });
  return { artifact, generation: record.specGeneration, record, context: { ...context, expectedRecordVersion: record.recordVersion } };
}

export function freezePlan({ root, taskId, context, plan, storyGraph, reviewRefs, candidateIdentity, now = new Date().toISOString() } = {}) {
  object(plan, 'plan');
  const current = readTask({ root, taskId });
  const candidate = candidateIdentity ? candidateFor(current, candidateIdentity) : undefined;
  const state = orchestration(current);
  if (current.phase !== 'plan-review' || !state.selfChecks.plan) throw new OrchestrationError('PLAN_REVIEW_REQUIRED', 'Plan freeze requires a passing self-check and plan-review phase');
  const review = assertReviewRefs(current, 'plan', reviewRefs);
  if (review.blockingFindings > 0) throw new OrchestrationError('REVIEW_BLOCKED', 'Plan review contains blocking findings');
  const validatedGraph = validateStoryGraph(storyGraph);
  if (validatedGraph.taskId !== taskId || validatedGraph.planGeneration !== current.planGeneration) throw new OrchestrationError('STORY_GRAPH_GENERATION_MISMATCH', 'Story graph does not match task plan generation');
  const specIds = new Set((state.drafts.spec?.requirements ?? []).map((item) => item.id));
  if ([...specIds].some((id) => !plan.requirements?.some((item) => item.id === id && item.proof))) throw new OrchestrationError('PLAN_PROOF_GAP', 'Plan must map every specification requirement to explicit proof');
  const artifact = draftArtifact({ root, taskId, type: 'frozen-plan', generation: current.planGeneration, payload: { plan, storyGraph: validatedGraph }, candidateIdentity: candidate, now });
  const record = mutateWithLease({ root, taskId, context, requiredScope: 'canonical', now, mutate: (recordValue) => withOrchestration({ ...appendArtifact({ ...recordValue, phase: 'implement', storyGraph: { ...validatedGraph, frozenAt: now } }, artifact), lastTrace: { event: 'plan-frozen', nextOwner: 'worker', nextAction: 'claim the next ready story', at: now } }, { frozen: { ...orchestration(recordValue).frozen, plan: { artifactId: artifact.artifactId, reviewId: review.reportId, generation: recordValue.planGeneration, frozenAt: now } } }) });
  return { artifact, generation: record.planGeneration, record, context: { ...context, expectedRecordVersion: record.recordVersion } };
}

export const freezeSpecGeneration = freezeSpec;
export const freezePlanGeneration = freezePlan;
