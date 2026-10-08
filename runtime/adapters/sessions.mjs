import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { readTask, atomicWriteJson, ensurePrivateDirectory, ensureStateRoot, taskDirectory } from '../core/store.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

function id(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function sessionFile(root, sessionId) {
  id(sessionId, 'sessionId');
  return join(ensureStateRoot(root), 'sessions', `${sessionId}.json`);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function publishDiscoveryCandidate({ root, taskId, repo, worktree = repo } = {}) {
  id(taskId, 'taskId');
  const state = ensureStateRoot(root);
  const path = join(state, 'registry.json');
  const current = existsSync(path) ? readJson(path) : null;
  const tasks = Array.isArray(current?.tasks) ? current.tasks : [];
  const candidate = { taskId, status: 'active', repo: canonical(repo), worktree: canonical(worktree), publishedAt: new Date().toISOString() };
  const next = [...tasks.filter((item) => item?.taskId !== taskId && item?.task_id !== taskId), candidate];
  atomicWriteJson(path, { schemaVersion: 1, tasks: next });
  return { path, candidate };
}

function workspaceMatches(binding, workspace) {
  if (!workspace) return true;
  const target = canonical(workspace);
  return [binding.repo, binding.worktree].filter(Boolean).some((path) => canonical(path) === target);
}

export function bindSession({ root, sessionId, taskId, journalPath, repo, worktree = repo, ownerHost = 'unknown', handoffId, handoffGeneration, replace } = {}) {
  id(sessionId, 'sessionId');
  id(taskId, 'taskId');
  if (typeof repo !== 'string' || repo.trim() === '') throw new TypeError('repo is required');
  if (typeof worktree !== 'string' || worktree.trim() === '') throw new TypeError('worktree is required');
  if (journalPath !== undefined && typeof journalPath !== 'string') throw new TypeError('journalPath must be a path');
  readTask({ root, taskId });
  const file = sessionFile(root, sessionId);
  ensurePrivateDirectory(join(ensureStateRoot(root), 'sessions'), 'sessions directory');
  const current = existsSync(file) ? readJson(file) : null;
  const same = current && current.taskId === taskId && current.repo === canonical(repo)
    && current.worktree === canonical(worktree) && current.journalPath === (journalPath ? canonical(journalPath) : undefined);
  if (current && !same && replace !== current.taskId) {
    const error = new Error(`session ${sessionId} is already bound to ${current.taskId}`);
    error.code = 'BINDING_CONFLICT';
    throw error;
  }
  const binding = {
    version: 1, bindingKind: 'explicit', sessionId, taskId,
    repo: canonical(repo), worktree: canonical(worktree), ownerHost,
    ...(journalPath ? { journalPath: canonical(journalPath) } : {}),
    ...(handoffId ? { handoffId, handoffGeneration } : {}),
    boundAt: new Date().toISOString(),
  };
  atomicWriteJson(file, binding);
  publishDiscoveryCandidate({ root, taskId, repo, worktree });
  return { binding, path: file };
}

function candidateFromPointer(repo, source) {
  if (!repo) return null;
  const pointer = join(repo, '.agent', 'CURRENT');
  if (!existsSync(pointer)) return null;
  const raw = readFileSync(pointer, 'utf8').trim();
  if (!raw) return null;
  let taskId = raw;
  if (raw.startsWith('{')) {
    try { taskId = JSON.parse(raw).task_id || JSON.parse(raw).taskId || ''; } catch {
      return { status: 'broken-pointer', source: pointer, reason: 'invalid CURRENT JSON' };
    }
  }
  return { status: 'candidate', source: pointer, taskId, repo: canonical(repo) };
}

function registryCandidates(root, repo) {
  const registry = readJson(join(ensureStateRoot(root), 'registry.json'));
  const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
  return tasks.filter((task) => task?.status === 'active' && (!repo || !task.repo || canonical(task.repo) === canonical(repo)))
    .map((task) => ({ ...task, taskId: task.taskId || task.task_id, status: 'candidate', source: join(ensureStateRoot(root), 'registry.json') }));
}

export function resolveCurrentTask({ root, sessionId, workspace, repo = workspace, now = new Date().toISOString() } = {}) {
  const target = workspace || repo;
  if (sessionId) {
    const file = sessionFile(root, sessionId);
    if (existsSync(file)) {
      const binding = readJson(file);
      const bindingKind = binding?.bindingKind || binding?.binding_kind;
      const boundTaskId = binding?.taskId || binding?.task_id;
      const boundRepo = binding?.repo;
      const boundWorktree = binding?.worktree;
      const boundJournal = binding?.journalPath || binding?.journal_path;
      if (!binding || bindingKind !== 'explicit' || !boundTaskId || !boundRepo) {
        return { status: 'candidate', source: file, reasonCode: 'broken-binding', reason: 'explicit binding is incomplete' };
      }
      const normalized = { ...binding, taskId: boundTaskId, repo: boundRepo, worktree: boundWorktree, journalPath: boundJournal };
      if (!workspaceMatches(normalized, target)) {
        return { status: 'candidate', source: file, taskId: boundTaskId, reasonCode: 'binding-mismatch', reason: 'session binding belongs to another workspace' };
      }
      if (boundJournal && !existsSync(boundJournal)) {
        return { status: 'candidate', source: file, taskId: boundTaskId, reasonCode: 'broken-binding', reason: 'bound journal is missing' };
      }
      try { readTask({ root, taskId: boundTaskId }); } catch (error) {
        return { status: 'candidate', source: file, taskId: boundTaskId, reasonCode: 'broken-binding', reason: error.message };
      }
      const handoffId = binding.handoffId || binding.handoff_id;
      if (handoffId) {
        let handoff;
        try {
          handoff = readJson(join(taskDirectory(root, boundTaskId), 'handoffs', `${handoffId}.json`));
        } catch { handoff = null; }
        const task = readTask({ root, taskId: boundTaskId });
        const acceptedLease = handoff?.status === 'accepted' && handoff.acceptedLeaseId
          ? task.leases.find((lease) => lease.leaseId === handoff.acceptedLeaseId
            && lease.ownerSession === (binding.sessionId || binding.session_id))
          : null;
        if (!acceptedLease) return { ...normalized, status: 'candidate', reasonCode: 'pending-handoff', reason: 'receiver binding awaits accepted active lease' };
        if (acceptedLease.revokedAt !== null) return { ...normalized, status: 'candidate', reasonCode: 'handoff-lease-revoked', reason: 'accepted receiver lease is revoked' };
        if (Date.parse(acceptedLease.expiresAt) <= Date.parse(now)) return { ...normalized, status: 'candidate', reasonCode: 'handoff-lease-expired', reason: 'accepted receiver lease is expired' };
      }
      return { ...normalized, status: 'exact', source: file };
    }
  }
  const pointer = candidateFromPointer(repo, 'repo-pointer');
  const registry = registryCandidates(root, repo);
  if (pointer?.status === 'broken-pointer') return { ...pointer, status: 'candidate', reasonCode: 'broken-pointer' };
  if (pointer && registry.length && registry.some((item) => item.taskId !== pointer.taskId)) {
    if (registry.length === 1) return registry[0];
    return { status: 'ambiguous', tasks: [pointer, ...registry], reason: 'repo pointer and registry identify different tasks' };
  }
  if (pointer) return pointer;
  if (registry.length === 1) return registry[0];
  if (registry.length > 1) return { status: 'ambiguous', tasks: registry, reason: 'multiple active task candidates' };
  const legacyPath = join(ensureStateRoot(root), 'CURRENT');
  if (existsSync(legacyPath)) {
    const raw = readFileSync(legacyPath, 'utf8').trim();
    if (raw) {
      const legacy = readJson(legacyPath);
      return { status: 'candidate', source: legacyPath, taskId: legacy?.taskId || legacy?.task_id || raw };
    }
  }
  return { status: 'missing', workspace: target || null };
}

export function sessionBindingPath(root, sessionId) { return sessionFile(root, sessionId); }
