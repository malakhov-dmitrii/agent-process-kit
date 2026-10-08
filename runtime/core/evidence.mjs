function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function environmentSame(left, right) {
  if (!left || !right) return false;
  const fields = ['environmentId', 'deploymentId', 'artifactDigest', 'deployedRevision'];
  return sameJson(
    Object.fromEntries(fields.map((field) => [field, left[field] ?? null])),
    Object.fromEntries(fields.map((field) => [field, right[field] ?? null])),
  );
}

function changedPaths(previous, current) {
  const oldFiles = new Map((previous?.contentManifest ?? []).map((item) => [item.path, item.sha256]));
  const newFiles = new Map((current?.contentManifest ?? []).map((item) => [item.path, item.sha256]));
  return [...new Set([...oldFiles.keys(), ...newFiles.keys()])]
    .filter((path) => oldFiles.get(path) !== newFiles.get(path))
    .sort();
}

function pathCovered(path, coveredPath) {
  return path === coveredPath || path.startsWith(`${coveredPath.replace(/\/$/, '')}/`);
}

function parsedCoverage(coverage) {
  if (!Array.isArray(coverage) || coverage.length === 0) return null;
  const paths = [];
  const contracts = [];
  for (const item of coverage) {
    if (typeof item !== 'string' || item.trim() === '') return null;
    if (item.startsWith('path:')) paths.push(item.slice(5));
    else if (item.startsWith('contract:')) contracts.push(item.slice(9));
    else if (item.includes(':')) return null;
    else paths.push(item);
  }
  if ([...paths, ...contracts].some((item) => item === '' || item.startsWith('/') || item.split('/').includes('..'))) return null;
  return { paths: paths.sort(), contracts: contracts.sort() };
}

function scopedImpact(receipt, current) {
  const coverage = parsedCoverage(receipt.coverage);
  const proof = receipt.impactProof;
  if (!coverage || !proof || !Array.isArray(proof.coveredPaths)) return 'unknown-impact';
  if (!sameJson(coverage.paths, [...proof.coveredPaths].sort())) return 'unknown-impact';
  let changedContracts = [];
  if (coverage.contracts.length === 0) {
    if (proof.kind !== 'path-disjoint' && proof.kind !== 'scoped-disjoint') return 'unknown-impact';
  } else {
    if (proof.kind !== 'scoped-disjoint' || !Array.isArray(proof.coveredContracts) || !Array.isArray(proof.changedContracts)) {
      return 'unknown-impact';
    }
    if (!sameJson(coverage.contracts, [...proof.coveredContracts].sort())) return 'unknown-impact';
    if (proof.changedContracts.some((item) => typeof item !== 'string' || item.trim() === '')) return 'unknown-impact';
    changedContracts = proof.changedContracts;
  }
  const changed = changedPaths(receipt.candidateIdentity, current);
  if (changed.some((path) => coverage.paths.some((covered) => pathCovered(path, covered)))) return 'covered-path-changed';
  if (changedContracts.some((contract) => coverage.contracts.includes(contract))) return 'covered-contract-changed';
  return coverage.contracts.length ? 'proven-disjoint-impact' : 'proven-disjoint-path-impact';
}

export function assessReceiptFreshness({ receipt, candidateIdentity, environmentIdentity } = {}) {
  if (!receipt?.candidateIdentity || !candidateIdentity) return { status: 'stale', reason: 'identity-unavailable' };
  if (receipt.candidateIdentity.taskId !== candidateIdentity.taskId) return { status: 'stale', reason: 'task-mismatch' };
  if (receipt.candidateIdentity.specGeneration !== candidateIdentity.specGeneration) {
    return { status: 'stale', reason: 'spec-generation-mismatch' };
  }
  if (receipt.candidateIdentity.planGeneration !== candidateIdentity.planGeneration) {
    return { status: 'stale', reason: 'plan-generation-mismatch' };
  }
  if (receipt.environmentIdentity !== undefined && !environmentSame(receipt.environmentIdentity, environmentIdentity)) {
    return { status: 'stale', reason: 'environment-mismatch' };
  }
  if (['commit', 'push', 'deploy', 'production-uat', 'observation'].includes(receipt.type)
      && receipt.candidateIdentity.commitSha !== candidateIdentity.commitSha) {
    return { status: 'stale', reason: 'commit-sha-mismatch' };
  }
  if (receipt.candidateIdentity.contentFingerprint === candidateIdentity.contentFingerprint) {
    return { status: 'current', reason: 'candidate-content-equal' };
  }
  if (receipt.coverage === 'full-candidate') return { status: 'stale', reason: 'content-changed' };
  const reason = scopedImpact(receipt, candidateIdentity);
  return reason === 'proven-disjoint-path-impact' || reason === 'proven-disjoint-impact'
    ? { status: 'current', reason }
    : { status: 'stale', reason };
}

export function recordEvidenceReceipt({ root, taskId, context, receipt, now = new Date().toISOString() }) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new EvidenceError('INVALID_EVIDENCE_RECEIPT', 'receipt must be an object');
  }
  for (const field of ['receiptId', 'type', 'scenario', 'verdict']) {
    if (typeof receipt[field] !== 'string' || receipt[field].trim() === '') {
      throw new EvidenceError('INVALID_EVIDENCE_RECEIPT', `${field} must be a non-empty string`);
    }
  }
  if (receipt.taskId !== taskId) throw new EvidenceError('EVIDENCE_TASK_MISMATCH', 'receipt belongs to another task');
  if (!receipt.candidateIdentity || typeof receipt.candidateIdentity.contentFingerprint !== 'string') {
    throw new EvidenceError('INVALID_EVIDENCE_RECEIPT', 'candidateIdentity is required');
  }
  let stored;
  const record = mutateWithLease({
    root,
    taskId,
    context,
    requiredScope: 'canonical',
    now,
    mutate: (current) => {
      const candidate = receipt.candidateIdentity;
      if (candidate.taskId !== current.taskId
          || candidate.specGeneration !== current.specGeneration
          || candidate.planGeneration !== current.planGeneration) {
        throw new EvidenceError('EVIDENCE_CANDIDATE_MISMATCH', 'receipt candidate does not match current task generations');
      }
      if (current.evidence.some((item) => item.receiptId === receipt.receiptId)) {
        throw new EvidenceError('DUPLICATE_EVIDENCE_RECEIPT', `receipt ${receipt.receiptId} already exists`);
      }
      stored = structuredClone(receipt);
      return { ...current, evidence: [...current.evidence, stored] };
    },
  });
  return { receipt: stored, record };
}
import { mutateWithLease } from './leases.mjs';

export class EvidenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
    this.details = details;
  }
}
