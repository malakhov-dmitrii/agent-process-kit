import { randomUUID } from 'node:crypto';

import { stageArtifact } from '../core/artifacts.mjs';

export const REVIEW_KINDS = Object.freeze(['spec', 'plan', 'code']);
export const FINDING_CLASSES = Object.freeze(['blocking', 'deferred', 'approved-expansion']);

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function kind(value) {
  if (!REVIEW_KINDS.includes(value)) throw new TypeError(`kind must be one of ${REVIEW_KINDS.join(', ')}`);
  return value;
}

function candidate(value) {
  object(value, 'candidateIdentity');
  nonEmpty(value.taskId, 'candidateIdentity.taskId');
  if (!Number.isInteger(value.specGeneration) || value.specGeneration < 0) throw new TypeError('candidateIdentity.specGeneration must be non-negative');
  if (!Number.isInteger(value.planGeneration) || value.planGeneration < 0) throw new TypeError('candidateIdentity.planGeneration must be non-negative');
  nonEmpty(value.contentFingerprint, 'candidateIdentity.contentFingerprint');
  return structuredClone(value);
}

function finding(value, index) {
  object(value, `findings[${index}]`);
  nonEmpty(value.id ?? `finding-${index + 1}`, `findings[${index}].id`);
  if (!FINDING_CLASSES.includes(value.classification)) {
    throw new TypeError(`findings[${index}].classification must be one of ${FINDING_CLASSES.join(', ')}`);
  }
  nonEmpty(value.message, `findings[${index}].message`);
  return { ...structuredClone(value), id: value.id ?? `finding-${index + 1}` };
}

export function validateReviewReport(input) {
  const value = object(input, 'review report');
  kind(value.kind);
  candidate(value.candidateIdentity);
  if (!Array.isArray(value.findings)) throw new TypeError('findings must be an array');
  const findings = value.findings.map(finding);
  const producer = object(value.producer, 'producer');
  nonEmpty(producer.kind, 'producer.kind');
  nonEmpty(producer.id, 'producer.id');
  const independent = value.independent ?? true;
  if (typeof independent !== 'boolean') throw new TypeError('independent must be boolean');
  return {
    reportId: value.reportId ?? randomUUID(),
    taskId: value.taskId ?? value.candidateIdentity.taskId,
    kind: value.kind,
    round: value.round ?? 1,
    independent,
    candidateIdentity: candidate(value.candidateIdentity),
    findings,
    producer: structuredClone(producer),
    verdict: findings.some((item) => item.classification === 'blocking') ? 'blocked' : 'pass',
    blockingFindings: findings.filter((item) => item.classification === 'blocking').length,
    approvedExpansions: findings.filter((item) => item.classification === 'approved-expansion').length,
  };
}

/**
 * Reviewers may stage an immutable report, but this adapter deliberately does
 * not attach it to the task record. The integration writer must call
 * control-plane.recordReview with its own fenced canonical context.
 */
export function createReviewReport({
  root,
  taskId,
  kind: reviewKind,
  candidateIdentity,
  findings = [],
  producer,
  independent = true,
  round = 1,
  sourceInputs = [],
  now = new Date().toISOString(),
} = {}) {
  const report = validateReviewReport({
    taskId,
    kind: reviewKind,
    candidateIdentity,
    findings,
    producer,
    independent,
    round,
  });
  if (!Array.isArray(sourceInputs)) throw new TypeError('sourceInputs must be an array');
  const artifact = stageArtifact({
    root,
    taskId,
    type: 'review-report',
    generation: Math.max(candidateIdentity.specGeneration, candidateIdentity.planGeneration),
    payload: report,
    producer: report.producer,
    sourceInputs,
    candidateIdentity: report.candidateIdentity,
    now,
  });
  return Object.freeze({ ...report, artifact });
}

export function getActionableFindings(report) {
  const normalized = validateReviewReport(report);
  return normalized.findings.filter((item) => item.classification === 'blocking' || item.classification === 'approved-expansion');
}

export function getDeferredFindings(report) {
  return validateReviewReport(report).findings.filter((item) => item.classification === 'deferred');
}

export const prepareReviewReport = createReviewReport;
