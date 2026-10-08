import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { acquireLease, releaseLease } from '../core/leases.mjs';
import { atomicWriteJson, createTask, readTask } from '../core/store.mjs';
import { bindSession, sessionBindingPath } from './sessions.mjs';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const HOSTS = new Set(['claude', 'codex', 'grok', 'unknown']);

export class MigrationError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MigrationError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = {}) => { throw new MigrationError(code, message, details); };
const json = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new MigrationError('MALFORMED_SOURCE', `Invalid JSON at ${path}`, { path }, error); }
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function regular(path, label) {
  if (!existsSync(path)) fail('SOURCE_MISSING', `${label} does not exist`, { path });
  const stat = lstatSync(path);
  if (!stat.isFile()) fail('UNSAFE_SOURCE', `${label} must be a regular file`, { path });
  return path;
}

function safeId(value, field, pattern = RECORD_ID) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('MALFORMED_SOURCE', `${field} is invalid`, { field });
  return value;
}

function journalTaskId(path) {
  regular(path, 'journal');
  const ids = [];
  let fence = null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) { fence = fence ? null : marker[1]; continue; }
    if (!fence && /^Task-ID:\s*/.test(line)) ids.push(line.slice(8).trim());
  }
  if (ids.length !== 1 || !TASK_ID.test(ids[0])) fail('JOURNAL_INVALID', 'journal must contain exactly one valid Task-ID');
  return ids[0];
}

function filesUnder(root) {
  const output = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) fail('UNSAFE_SOURCE', `Symlink in migration source: ${path}`, { path });
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  walk(root);
  return output.sort();
}

function sourceFingerprint(root) {
  const hash = createHash('sha256');
  for (const path of filesUnder(root)) {
    hash.update(relative(root, path));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readLock(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile()) fail('LIVE_LEGACY_LOCK', `Legacy lock is not a regular file: ${path}`, { path });
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('LIVE_LEGACY_LOCK', `Legacy lock is malformed: ${path}`, { path }); }
  const pid = Number(value?.pid);
  let live = false;
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); live = true; } catch (error) { live = error.code !== 'ESRCH'; }
  }
  if (live || !Number.isInteger(pid) || pid <= 0) fail('LIVE_LEGACY_LOCK', `Legacy lock is live or unverifiable: ${path}`, { path, pid, live });
  fail('LIVE_LEGACY_LOCK', `Legacy lock must be removed before migration: ${path}`, { path, pid, live });
}

function findBindings(root) {
  const dir = join(root, 'sessions');
  if (!existsSync(dir)) fail('SOURCE_MISSING', 'v0.2 sessions directory is missing', { path: dir });
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => {
    const path = join(dir, entry.name);
    const binding = json(path);
    if (binding.version < 2 || (binding.binding_kind ?? binding.bindingKind) !== 'explicit') {
      fail('PROVISIONAL_BINDING', `Session binding is not explicit: ${path}`, { path });
    }
    const sessionId = binding.session_id ?? binding.sessionId ?? basename(entry.name, '.json');
    const taskId = binding.task_id ?? binding.taskId;
    safeId(sessionId, 'sessionId');
    safeId(taskId, 'taskId', TASK_ID);
    const repo = binding.repo;
    const worktree = binding.worktree ?? repo;
    const journalPath = binding.journal_path ?? binding.journalPath;
    if (!repo || !worktree || !journalPath) fail('MALFORMED_SOURCE', `Explicit binding is incomplete: ${path}`, { path });
    return { path, binding, sessionId, taskId, repo: resolve(repo), worktree: resolve(worktree), journalPath: resolve(journalPath) };
  });
}

function findHandoffs(root) {
  const output = [];
  const dir = join(root, 'handoffs');
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(dir, entry.name);
    const handoff = json(path);
    if (!['prepared', 'accepted'].includes(handoff.status)) fail('MALFORMED_SOURCE', `Unsupported handoff status: ${path}`, { path });
    output.push({ path, handoff, taskId: handoff.task_id ?? handoff.taskId });
  }
  return output;
}

function validateInventory({ sourceRoot, taskId, sessionId, workspace } = {}) {
  const root = resolve(sourceRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) fail('SOURCE_MISSING', 'v0.2 source root must be a directory', { sourceRoot: root });
  const bindings = findBindings(root);
  const tasks = [...new Set(bindings.map((item) => item.taskId))];
  if (tasks.length !== 1) fail('DUPLICATE_TASK', `Expected one v0.2 task, found ${tasks.join(', ') || 'none'}`, { tasks });
  const selectedTask = taskId ?? tasks[0];
  if (selectedTask !== tasks[0]) fail('TASK_MISMATCH', `Binding task ${tasks[0]} does not match requested task ${selectedTask}`);
  const selected = bindings.filter((item) => item.taskId === selectedTask);
  const identity = selected[0];
  if (selected.some((item) => item.repo !== identity.repo || item.worktree !== identity.worktree || item.journalPath !== identity.journalPath)) fail('BINDING_MISMATCH', 'Explicit bindings for one task disagree on identity');
  for (const item of selected) if (journalTaskId(item.journalPath) !== selectedTask) fail('JOURNAL_MISMATCH', `journal Task-ID does not match ${selectedTask}`);
  const handoffs = findHandoffs(root).filter((item) => item.taskId === selectedTask);
  const accepted = handoffs.find((item) => item.handoff.status === 'accepted');
  const selectedSession = sessionId ?? (accepted?.handoff.accepted_session ?? accepted?.handoff.acceptedSession ?? accepted?.handoff.recipient_session) ?? identity.sessionId;
  const binding = selected.find((item) => item.sessionId === selectedSession);
  if (!binding) fail('SESSION_MISMATCH', 'Requested session does not match binding');
  if (workspace && resolve(workspace) !== identity.repo && resolve(workspace) !== identity.worktree) fail('WORKSPACE_MISMATCH', 'Binding does not belong to requested workspace');
  for (const item of handoffs) {
    const h = item.handoff;
    if (h.recipient_host && !HOSTS.has(h.recipient_host)) fail('HANDOFF_MISMATCH', `Unknown handoff host in ${item.path}`);
    if (h.status === 'accepted') {
      const receiver = bindings.find((candidate) => candidate.sessionId === (h.accepted_session ?? h.acceptedSession ?? h.recipient_session));
      if (!receiver || receiver.taskId !== selectedTask || receiver.repo !== identity.repo || receiver.worktree !== identity.worktree) {
        fail('HANDOFF_MISMATCH', `Accepted handoff has no matching receiver binding: ${item.path}`, { path: item.path });
      }
    } else if (h.recipient_session && bindings.some((candidate) => candidate.sessionId === h.recipient_session && candidate.taskId !== selectedTask)) {
      fail('HANDOFF_MISMATCH', `Prepared handoff receiver belongs to another task: ${item.path}`);
    }
  }
  for (const path of filesUnder(root)) if (path.endsWith('.lock') || path.includes('.lock.')) readLock(path);
  const fingerprint = sourceFingerprint(root);
  const files = filesUnder(root).map((path) => ({ path: relative(root, path), sha256: sha256(readFileSync(path)) }));
  const snapshot = {
    version: 1,
    sourceRoot: root,
    taskId: selectedTask,
    sessionId: binding.sessionId,
    journalPath: binding.journalPath,
    repo: binding.repo,
    worktree: binding.worktree,
    binding: binding.binding,
    handoffs: handoffs.map((item) => item.handoff),
    sourceFingerprint: fingerprint,
    files,
  };
  const snapshotDigest = sha256(JSON.stringify(snapshot));
  return { ok: true, snapshot, snapshotDigest, sourceFingerprint: fingerprint };
}

export function dryRunMigration(input = {}) { return validateInventory(input); }

function quarantineReadOnly(root) {
  for (const path of filesUnder(root)) chmodSync(path, 0o444);
  const dirs = [];
  const walk = (dir) => { dirs.push(dir); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(join(dir, e.name)); };
  walk(root);
  for (const path of dirs.sort((a, b) => b.length - a.length)) chmodSync(path, 0o555);
}

function writableV02(root) {
  const files = filesUnder(root);
  for (const path of files) chmodSync(path, 0o600);
  const dirs = [];
  const walk = (dir) => { dirs.push(dir); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(join(dir, e.name)); };
  walk(root);
  for (const path of dirs.sort((a, b) => b.length - a.length)) chmodSync(path, 0o700);
}

function hashFile(path) { return sha256(readFileSync(path)); }

function tombstoneBytes(taskId, snapshotDigest) {
  return `${JSON.stringify({ version: 1, kind: 'agent-process-kit-v0.2-tombstone', taskId, snapshotDigest })}\n`;
}

function tombstoneHash(taskId, snapshotDigest) {
  return sha256(tombstoneBytes(taskId, snapshotDigest));
}

function assertOwnedTombstone(receipt, { allowMissingAfterVerified = false } = {}) {
  const expected = tombstoneBytes(receipt.taskId, receipt.snapshotDigest);
  const expectedHash = sha256(expected);
  if (!existsSync(receipt.tombstonePath)) {
    if (allowMissingAfterVerified && receipt.tombstoneVerifiedHash === expectedHash) return false;
    fail('TOMBSTONE_MISSING', 'Owned v0.2 tombstone is missing; activation or rollback is blocked', { path: receipt.tombstonePath });
  }
  const stat = lstatSync(receipt.tombstonePath);
  if (!stat.isFile()) fail('TOMBSTONE_FOREIGN', 'Legacy root was replaced with a non-file tombstone', { path: receipt.tombstonePath });
  const actual = readFileSync(receipt.tombstonePath);
  if (sha256(actual) !== expectedHash || actual.toString('utf8') !== expected) {
    fail('TOMBSTONE_FOREIGN', 'Legacy tombstone bytes do not match the migration receipt', { path: receipt.tombstonePath });
  }
  return true;
}

function blockReceipt(receiptPath, receipt, now, reason, errorCode) {
  const blocked = { ...receipt, phase: 'blocked', blockedAt: now, blockedReason: reason, blockedErrorCode: errorCode };
  atomicWriteJson(receiptPath, blocked);
  fail(errorCode, reason, { path: receipt.tombstonePath });
}

function assertSnapshot(snapshot, digest) {
  if (!snapshot || typeof snapshot !== 'object' || sha256(JSON.stringify(snapshot)) !== digest) fail('SNAPSHOT_MISMATCH', 'Caller-provided dry-run snapshot digest does not match');
}

export function applyMigration({ sourceRoot, destinationRoot, snapshot, snapshotDigest, ownerHost = 'codex', ownerSession, now = new Date().toISOString(), leaseDurationMs = 300_000 } = {}) {
  assertSnapshot(snapshot, snapshotDigest);
  if (resolve(sourceRoot) !== snapshot.sourceRoot) fail('SNAPSHOT_MISMATCH', 'Source root differs from dry-run snapshot');
  safeId(ownerSession ?? '', 'ownerSession');
  if (!HOSTS.has(ownerHost)) fail('INVALID_OWNER', 'ownerHost is invalid');
  const root = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  const receiptPath = join(destination, 'migrations', `${snapshot.taskId}.json`);
  if (existsSync(receiptPath)) {
    const receipt = json(receiptPath);
    if (receipt.snapshotDigest !== snapshotDigest) fail('RECEIPT_MISMATCH', 'Existing migration receipt does not match snapshot');
    if (receipt.phase === 'installed') return receipt;
  }
  const quarantine = `${root}.quarantine-${snapshot.taskId}`;
  const tombstone = root;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const preparedReceipt = existsSync(receiptPath) ? json(receiptPath) : {
    version: 1, kind: 'v0.2-migration', phase: 'prepared', taskId: snapshot.taskId,
    sessionId: snapshot.sessionId, sourceRoot: root, destinationRoot: destination,
    quarantineRoot: quarantine, tombstonePath: tombstone, sourceFingerprint: snapshot.sourceFingerprint,
    snapshotDigest, tombstoneHash: tombstoneHash(snapshot.taskId, snapshotDigest), preparedAt: now,
  };
  atomicWriteJson(receiptPath, preparedReceipt);
  const existingTaskPath = join(destination, 'tasks', snapshot.taskId, 'task.json');
  const existingSessionPath = sessionBindingPath(destination, snapshot.sessionId);
  if (!existsSync(quarantine) && (existsSync(existingTaskPath) || existsSync(existingSessionPath))) fail('DESTINATION_CONFLICT', 'Destination contains unrelated imported task or session');
  if (!existsSync(quarantine)) {
    if (!existsSync(root) || !lstatSync(root).isDirectory()) fail('SOURCE_CHANGED', 'v0.2 source is unavailable for cutover');
    if (sourceFingerprint(root) !== snapshot.sourceFingerprint) fail('SOURCE_CHANGED', 'v0.2 source changed since dry-run');
    renameSync(root, quarantine);
    quarantineReadOnly(quarantine);
    writeFileSync(tombstone, tombstoneBytes(snapshot.taskId, snapshotDigest), { mode: 0o444, flag: 'wx' });
  }
  if (existsSync(root) && lstatSync(root).isDirectory()) blockReceipt(receiptPath, preparedReceipt, now, 'legacy-root-recreated-as-directory', 'LEGACY_WRITE_DENIED');
  if (sourceFingerprint(quarantine) !== snapshot.sourceFingerprint) {
    blockReceipt(receiptPath, preparedReceipt, now, 'quarantine-fingerprint-mismatch', 'QUARANTINE_CHANGED');
  }
  try {
    assertOwnedTombstone({ ...preparedReceipt, tombstonePath: tombstone, taskId: snapshot.taskId, snapshotDigest });
  } catch (error) {
    if (error instanceof MigrationError && ['TOMBSTONE_MISSING', 'TOMBSTONE_FOREIGN'].includes(error.code)) {
      blockReceipt(receiptPath, preparedReceipt, now, error.message, error.code);
    }
    throw error;
  }
  const quarantinedReceipt = { ...preparedReceipt, phase: 'quarantined', tombstoneHash: tombstoneHash(snapshot.taskId, snapshotDigest), quarantinedAt: preparedReceipt.quarantinedAt ?? now };
  atomicWriteJson(receiptPath, quarantinedReceipt);
  let record;
  try { record = readTask({ root: destination, taskId: snapshot.taskId }); }
  catch (error) {
    if (error.code !== 'TASK_NOT_FOUND') throw error;
    record = createTask({ root: destination, input: { taskId: snapshot.taskId, request: `Migrated v0.2 task ${snapshot.taskId}`, mode: 'standard', requestedBoundary: 'local', now } });
  }
  const start = Date.parse(now);
  const existingLease = record.leases.find((item) => item.leaseId === `migration:${snapshot.taskId}`);
  const lease = existingLease ? { lease: existingLease, record } : acquireLease({ root: destination, taskId: snapshot.taskId, scope: 'canonical', ownerHost, ownerSession, expectedRecordVersion: record.recordVersion, expectedFence: 0, renewBefore: new Date(start + Math.floor(leaseDurationMs / 2)).toISOString(), expiresAt: new Date(start + leaseDurationMs).toISOString(), now, leaseId: `migration:${snapshot.taskId}` });
  const leaseReceipt = { ...quarantinedReceipt, phase: 'lease-acquired', importedRecordVersion: lease.record.recordVersion, importedRecordHash: sha256(JSON.stringify(lease.record)), importedLeaseId: lease.lease.leaseId, importedLeaseFingerprint: sha256(JSON.stringify(lease.lease)), leaseAcquiredAt: quarantinedReceipt.leaseAcquiredAt ?? now };
  atomicWriteJson(receiptPath, leaseReceipt);
  // Lease ownership is durable before any exact session binding is exposed.
  const binding = bindSession({ root: destination, sessionId: snapshot.sessionId, taskId: snapshot.taskId, journalPath: snapshot.journalPath, repo: snapshot.repo, worktree: snapshot.worktree, ownerHost });
  const bindingReceipt = { ...leaseReceipt, phase: 'binding-created', importedSessionHash: hashFile(binding.path), bindingCreatedAt: leaseReceipt.bindingCreatedAt ?? now };
  atomicWriteJson(receiptPath, bindingReceipt);
  const handoffHashes = (snapshot.handoffs ?? []).map((handoff) => {
    const handoffId = handoff.handoff_id ?? handoff.handoffId;
    const handoffPath = join(destination, 'tasks', snapshot.taskId, 'handoffs', `${handoffId}.json`);
    mkdirSync(dirname(handoffPath), { recursive: true, mode: 0o700 });
    const translated = { ...handoff, taskId: snapshot.taskId, handoffId };
    atomicWriteJson(handoffPath, translated);
    return { handoffId, hash: hashFile(handoffPath), path: handoffPath };
  });
  const receipt = { ...bindingReceipt, phase: 'installed', importedHandoffHashes: handoffHashes, installedAt: now };
  atomicWriteJson(receiptPath, receipt);
  return receipt;
}

export function rollbackMigration({ receiptPath, root, taskId, context, now = new Date().toISOString() } = {}) {
  const path = receiptPath ?? join(resolve(root), 'migrations', `${taskId}.json`);
  const receipt = json(path);
  if (receipt.phase === 'rolled-back') return receipt;
  if (!['installed', 'rollback-prepared', 'ownership-revoked', 'removing', 'restored'].includes(receipt.phase)) fail('ROLLBACK_INVALID', 'Migration receipt is not installed or resumable');
  const destination = receipt.destinationRoot;
  const bindingPath = sessionBindingPath(destination, receipt.sessionId);
  let leaseRecord = null;
  if (receipt.phase === 'installed' || receipt.phase === 'rollback-prepared') {
    const record = readTask({ root: destination, taskId: receipt.taskId });
    if (record.recordVersion !== receipt.importedRecordVersion || sha256(JSON.stringify(record)) !== receipt.importedRecordHash || record.grants.length || record.externalAttempts.length || record.artifacts.length || record.checkpointEvents.length || record.status !== 'active') fail('ROLLBACK_REFUSED', 'Imported task has post-migration mutations');
    const lease = record.leases.find((item) => item.leaseId === receipt.importedLeaseId && item.revokedAt === null);
    if (!lease) fail('ROLLBACK_REFUSED', 'Imported canonical lease is missing or revoked');
    if (!context || context.leaseId !== lease.leaseId || context.fenceToken !== lease.fenceToken || context.expectedRecordVersion !== record.recordVersion) fail('ROLLBACK_REFUSED', 'Rollback requires the exact imported lease context');
    if (!existsSync(bindingPath) || hashFile(bindingPath) !== receipt.importedSessionHash) fail('ROLLBACK_REFUSED', 'Imported session binding changed');
    for (const item of receipt.importedHandoffHashes ?? []) if (!existsSync(item.path) || hashFile(item.path) !== item.hash) fail('ROLLBACK_REFUSED', `Imported handoff ${item.handoffId} changed`);
    try { assertOwnedTombstone(receipt); } catch (error) { if (error instanceof MigrationError) fail('ROLLBACK_REFUSED', error.message, error.details); throw error; }
    const prepared = receipt.phase === 'rollback-prepared'
      ? receipt
      : { ...receipt, phase: 'rollback-prepared', rollbackPhase: 'prepared', rollbackPreparedAt: receipt.rollbackPreparedAt ?? now, tombstoneVerifiedHash: receipt.tombstoneHash };
    if (receipt.phase === 'installed') atomicWriteJson(path, prepared);
    // Fence ownership first. A stale writer must lose before imported records disappear.
    leaseRecord = releaseLease({ root: destination, taskId: receipt.taskId, context, reason: 'migration-rollback', now }).record;
    if (leaseRecord.leases.find((item) => item.leaseId === lease.leaseId)?.revokedAt === null) fail('ROLLBACK_REFUSED', 'Imported lease remained usable');
    const revoked = { ...prepared, phase: 'ownership-revoked', rollbackPhase: 'ownership-revoked', rollbackLeaseRecordVersion: leaseRecord.recordVersion };
    atomicWriteJson(path, revoked);
  }
  const current = ['ownership-revoked', 'removing', 'restored'].includes(receipt.phase) ? receipt : json(path);
  if (current.phase === 'ownership-revoked') {
    const removing = { ...current, phase: 'removing', rollbackPhase: 'removing', removingAt: current.removingAt ?? now };
    atomicWriteJson(path, removing);
  }
  const removing = json(path);
  if (removing.phase === 'removing') {
    try { assertOwnedTombstone(removing, { allowMissingAfterVerified: true }); } catch (error) { if (error instanceof MigrationError) fail('ROLLBACK_REFUSED', error.message, error.details); throw error; }
  }
  const taskDirectory = join(destination, 'tasks', receipt.taskId);
  if (existsSync(taskDirectory)) rmSync(taskDirectory, { recursive: true, force: false });
  if (existsSync(bindingPath)) unlinkSync(bindingPath);
  if (removing.phase === 'removing') {
    if (existsSync(removing.tombstonePath)) unlinkSync(removing.tombstonePath);
    if (!existsSync(removing.quarantineRoot)) fail('ROLLBACK_REFUSED', 'Quarantine is missing; legacy state cannot be restored');
    if (sourceFingerprint(removing.quarantineRoot) !== removing.sourceFingerprint) fail('ROLLBACK_REFUSED', 'Quarantine changed before restore');
    writableV02(removing.quarantineRoot);
    renameSync(removing.quarantineRoot, removing.tombstonePath);
  }
  const restored = { ...removing, phase: 'restored', rollbackPhase: 'restored', restoredAt: removing.restoredAt ?? now };
  atomicWriteJson(path, restored);
  const completed = { ...restored, phase: 'rolled-back', rolledBackAt: now, rollbackLeaseRecordVersion: leaseRecord?.recordVersion ?? restored.rollbackLeaseRecordVersion };
  atomicWriteJson(path, completed);
  return completed;
}
