import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createCandidateIdentity } from '../core/candidate.mjs';
import { readArtifact } from '../core/artifacts.mjs';
import { appendLeaseToRecord, assertMutationLease, currentFence } from '../core/leases.mjs';
import { atomicWriteJson, compareAndSwapTask, ensurePrivateDirectory, getStateRoot, readTask, taskDirectory, withTaskLock } from '../core/store.mjs';
import { bindSession, sessionBindingPath } from './sessions.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

function handoffPath(root, taskId, handoffId) {
  if (!ID.test(handoffId)) throw new TypeError('handoffId is invalid');
  const directory = join(taskDirectory(root, taskId), 'handoffs');
  ensurePrivateDirectory(directory, 'handoff directory');
  return join(directory, `${handoffId}.json`);
}

function readHandoff(root, taskId, handoffId) {
  const path = handoffPath(root, taskId, handoffId);
  if (!existsSync(path)) throw Object.assign(new Error(`handoff ${handoffId} does not exist`), { code: 'HANDOFF_NOT_FOUND' });
  return { path, record: JSON.parse(readFileSync(path, 'utf8')) };
}

function locateHandoff(root, taskId, handoffId) {
  if (taskId) return { taskId, ...readHandoff(root, taskId, handoffId) };
  const tasksRoot = join(getStateRoot({ AGENT_PROCESS_KIT_STATE_DIR: root }), 'tasks');
  const matches = [];
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { matches.push({ taskId: entry.name, ...readHandoff(root, entry.name, handoffId) }); } catch { /* next task */ }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw Object.assign(new Error(`handoff ${handoffId} is ambiguous across tasks`), { code: 'HANDOFF_AMBIGUOUS' });
  throw Object.assign(new Error(`handoff ${handoffId} does not exist`), { code: 'HANDOFF_NOT_FOUND' });
}

function receiverParts(receiver, to) {
  const value = receiver || to;
  if (typeof value === 'string') return { host: value, sessionId: null };
  if (!value || typeof value.host !== 'string' || typeof value.sessionId !== 'string') throw new TypeError('receiver host and sessionId are required');
  return { host: value.host, sessionId: value.sessionId };
}

function sameIdentity(left, right) {
  return left?.taskId === right?.taskId && left?.specGeneration === right?.specGeneration
    && left?.planGeneration === right?.planGeneration && left?.contentFingerprint === right?.contentFingerprint;
}

function verifyCandidate(handoff, worktree) {
  const candidate = createCandidateIdentity({ repoPath: worktree, taskId: handoff.taskId, specGeneration: handoff.specGeneration, planGeneration: handoff.planGeneration });
  if (!sameIdentity(candidate, handoff.candidateIdentity)) {
    throw Object.assign(new Error('handoff candidate fingerprint or generation changed'), { code: 'CANDIDATE_MISMATCH' });
  }
  return candidate;
}

function verifyArtifacts(root, handoff) {
  for (const artifact of handoff.artifacts || []) readArtifact({ root, taskId: handoff.taskId, artifact });
}

export function prepareHandoff({ root, taskId, context, to, repo, worktree = repo, nextAction, candidateIdentity, now = new Date().toISOString(), handoffId = randomUUID() } = {}) {
  const record = readTask({ root, taskId });
  assertMutationLease(record, context, { now, requiredScope: 'canonical' });
  const candidate = createCandidateIdentity({ repoPath: worktree, taskId, specGeneration: record.specGeneration, planGeneration: record.planGeneration });
  if (candidateIdentity && !sameIdentity(candidate, candidateIdentity)) throw new Error('supplied candidate identity does not match worktree');
  const recipient = receiverParts(null, to);
  const handoff = {
    version: 1, handoffId, taskId, status: 'prepared', generation: 1,
    specGeneration: record.specGeneration, planGeneration: record.planGeneration,
    sourceLeaseId: context.leaseId, sourceFence: context.fenceToken,
    sourceSession: record.leases.find((lease) => lease.leaseId === context.leaseId)?.ownerSession,
    recipientHost: recipient.host, recipientSession: recipient.sessionId || null,
    repo, worktree, nextAction: nextAction || null, candidateIdentity: candidate,
    artifacts: record.artifacts, preparedAt: now,
  };
  const path = handoffPath(root, taskId, handoffId);
  if (existsSync(path)) throw Object.assign(new Error(`handoff ${handoffId} already exists`), { code: 'HANDOFF_EXISTS' });
  atomicWriteJson(path, handoff);
  return handoff;
}

export function acceptHandoff({ root, taskId, handoffId, receiver, repo, worktree = repo, expectedFence, now = new Date().toISOString(), renewBefore, expiresAt } = {}) {
  const located = locateHandoff(root, taskId, handoffId);
  taskId = located.taskId;
  const loaded = located;
  let handoff = loaded.record;
  const recipient = receiverParts(receiver);
  if (handoff.recipientHost !== recipient.host || (handoff.recipientSession && handoff.recipientSession !== recipient.sessionId)) {
    throw Object.assign(new Error('handoff receiver does not match'), { code: 'RECEIVER_MISMATCH' });
  }
  if (!recipient.sessionId) throw Object.assign(new Error('receiver session is required to claim a host-only handoff'), { code: 'RECEIVER_SESSION_REQUIRED' });
  if (expectedFence !== undefined && expectedFence !== handoff.sourceFence) throw new Error('handoff source fence does not match expected fence');
  if (handoff.repo !== repo || handoff.worktree !== worktree) throw new Error('handoff workspace does not match');
  verifyCandidate(handoff, worktree);
  verifyArtifacts(root, handoff);

  if (handoff.status === 'accepted') {
    const bindingPath = sessionBindingPath(root, recipient.sessionId);
    if (!existsSync(bindingPath)) throw new Error('accepted handoff has no receiver binding');
    const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
    if (binding.taskId !== taskId || binding.handoffId !== handoffId) throw new Error('accepted handoff binding mismatch');
    const record = readTask({ root, taskId });
    const lease = record.leases.find((item) => item.leaseId === handoff.acceptedLeaseId);
    if (!lease) throw new Error('accepted handoff lease is missing');
    if (lease.revokedAt !== null) throw new Error('accepted handoff lease is revoked');
    if (Date.parse(lease.expiresAt) <= Date.parse(now)) throw new Error('accepted handoff lease is expired');
    return { handoff, lease, record };
  }
  if (handoff.status !== 'prepared') throw new Error('handoff is not prepared');

  // A host-only handoff is claimed before binding. The claim is durable under
  // the task lock, so a crash can retry with the same session but another
  // session can never steal the prepared handoff.
  if (!handoff.recipientSession) {
    handoff = withTaskLock(root, taskId, () => {
      const latest = JSON.parse(readFileSync(loaded.path, 'utf8'));
      if (latest.status !== 'prepared') throw new Error('handoff is not prepared');
      if (latest.recipientSession && latest.recipientSession !== recipient.sessionId) {
        throw Object.assign(new Error('handoff receiver claim does not match'), { code: 'RECEIVER_MISMATCH' });
      }
      const claimed = latest.recipientSession ? latest : { ...latest, recipientSession: recipient.sessionId, claimedSession: recipient.sessionId, claimedAt: now };
      if (!latest.recipientSession) atomicWriteJson(loaded.path, claimed);
      return claimed;
    });
  }

  // Binding is deliberately durable before the fenced transfer. A crash here is
  // safe: the next acceptance retries the same handoff ID and completes the CAS.
  bindSession({ root, sessionId: recipient.sessionId, taskId, repo, worktree, ownerHost: recipient.host, handoffId, handoffGeneration: handoff.generation });
  const current = readTask({ root, taskId });
  const existing = current.leases.find((lease) => lease.handoffId === handoffId);
  if (existing) {
    const accepted = { ...handoff, status: 'accepted', acceptedLeaseId: existing.leaseId, acceptedAt: now };
    atomicWriteJson(loaded.path, accepted);
    return { handoff: accepted, lease: existing, record: current };
  }
  const source = current.leases.find((lease) => lease.leaseId === handoff.sourceLeaseId);
  if (!source || source.fenceToken !== handoff.sourceFence || source.revokedAt !== null) throw new Error('sender lease is no longer transferable');
  const leaseId = `handoff:${handoffId}`;
  const start = Date.parse(now);
  renewBefore ||= new Date(start + 60_000).toISOString();
  expiresAt ||= new Date(start + 300_000).toISOString();
  const result = compareAndSwapTask({ root, taskId, expectedRecordVersion: current.recordVersion, now, mutate: (record) => {
    const senderContext = {
      leaseId: handoff.sourceLeaseId, fenceToken: handoff.sourceFence, leaseScope: 'canonical',
      expectedRecordVersion: record.recordVersion, specGeneration: record.specGeneration, planGeneration: record.planGeneration,
    };
    assertMutationLease(record, senderContext, { now, requiredScope: 'canonical' });
    const revoked = { ...record, leases: record.leases.map((lease) => lease.leaseId === handoff.sourceLeaseId ? { ...lease, revokedAt: now, revokeReason: 'handoff' } : lease) };
    const appended = appendLeaseToRecord(revoked, { taskId, scope: 'canonical', ownerHost: recipient.host, ownerSession: recipient.sessionId, expectedFence: currentFence(revoked, 'canonical'), renewBefore, expiresAt, now, leaseId });
    appended.lease.handoffId = handoffId;
    return appended.record;
  }});
  const accepted = { ...handoff, status: 'accepted', acceptedLeaseId: leaseId, acceptedAt: now };
  atomicWriteJson(loaded.path, accepted);
  return { handoff: accepted, lease: result.leases.find((lease) => lease.leaseId === leaseId), record: result };
}

export { handoffPath };
