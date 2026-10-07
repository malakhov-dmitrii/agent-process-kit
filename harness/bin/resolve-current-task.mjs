#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { assertSafePath, getStateRoot, handoffPath, readJson, validateJournal } from './task-store.mjs';

const home = homedir();
const root = getStateRoot();
const args = process.argv.slice(2);
const cwdArg = args.find((arg) => arg !== '--bind-if-unambiguous');
const cwd = cwdArg ? resolve(cwdArg) : process.cwd();

const rawSessionId =
  process.env.OPERATOR_TRANSPARENCY_SESSION_ID ||
  process.env.CODEX_THREAD_ID ||
  process.env.CODEX_SESSION_ID ||
  process.env.CLAUDE_SESSION_ID ||
  process.env.CLAUDE_CODE_SESSION_ID ||
  '';
const sessionId = rawSessionId.replace(/[^A-Za-z0-9_.-]/g, '_');

function readText(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function gitRoot(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function candidateFromDir(taskDir, source) {
  if (!taskDir) return null;
  const journal = join(taskDir, 'journal.md');
  if (!existsSync(journal)) return null;
  return {
    source,
    task_id: basename(taskDir),
    task_dir: taskDir,
    journal_path: journal,
  };
}

function candidateFromRepoPointer(repo) {
  if (!repo) return null;
  const pointer = join(repo, '.agent', 'CURRENT');
  const raw = readText(pointer);
  if (!raw) return null;

  // JSON branch: .agent/CURRENT may be a JSON object
  let taskId = raw;
  let journalOverride = null;
  if (raw.startsWith('{')) {
    let obj;
    try { obj = JSON.parse(raw); } catch (e) {
      return { source: pointer, task_id: raw, repo, error: 'invalid JSON CURRENT: ' + e.message };
    }
    taskId = obj.task_id || '';
    if (obj.journal) journalOverride = join(repo, obj.journal);
  }

  if (journalOverride && existsSync(journalOverride)) {
    try { validateJournal(journalOverride, taskId); } catch (error) { return { source: pointer, task_id: taskId, repo, error: error.message }; }
    return { source: pointer, task_id: taskId, repo, journal_path: journalOverride };
  }

  const direct = join(repo, '.agent', 'tasks', taskId + '.md');
  if (existsSync(direct)) {
    try { validateJournal(direct, taskId); } catch (error) { return { source: pointer, task_id: taskId, repo, error: error.message }; }
    return { source: pointer, task_id: taskId, repo, journal_path: direct };
  }

  const taskDir = join(repo, '.agent', 'tasks', taskId);
  const nested = candidateFromDir(taskDir, pointer);
  if (nested) return { ...nested, task_id: taskId, repo };

  return {
    source: pointer,
    task_id: taskId,
    repo,
    error: 'repo pointer found but journal missing',
  };
}

function candidateFromSessionBinding() {
  if (!sessionId) return null;
  const sessionFile = join(root, 'sessions', sessionId + '.json');
  if (!existsSync(sessionFile)) return null;
  try {
    assertSafePath(sessionFile, { allowMissing: false, label: 'session binding' });
    const binding = JSON.parse(readFileSync(sessionFile, 'utf8'));
    const canonical = (value) => {
      try { return realpathSync(value); } catch { return resolve(value); }
    };
    const contexts = [binding.repo, binding.binding_kind === 'explicit' && binding.worktree].filter(Boolean);
    if (contexts.length && !contexts.some(value => canonical(value) === canonical(repo || cwd))) {
      return { status: 'binding-mismatch', source: sessionFile,
        task_id: binding.task_id, reason: 'session binding belongs to another workspace; explicitly rebind after matching the current request' };
    }
    if (!binding.task_id || !binding.journal_path || !existsSync(binding.journal_path)) {
      return { status: 'broken-binding', source: sessionFile, reason: 'bound journal is missing or binding is incomplete; do not substitute another task' };
    }
    try { validateJournal(binding.journal_path, binding.task_id); } catch (error) { return { status: 'broken-binding', source: sessionFile, reason: error.message }; }
    if (binding.handoff_id) {
      let handoff;
      try { handoff = readJson(handoffPath(root, binding.handoff_id)); } catch { return { status: 'pending-handoff', source: sessionFile, task_id: binding.task_id, reason: 'handoff record is missing or unreadable; retry acceptance' }; }
      if (handoff.status !== 'accepted' || handoff.accepted_session !== binding.session_id || handoff.accepted_generation !== binding.handoff_generation) {
        return { status: 'pending-handoff', source: sessionFile, task_id: binding.task_id, reason: 'receiver binding has no matching accepted handoff record; retry acceptance' };
      }
    }
    const explicit = binding.version >= 2 && binding.binding_kind === 'explicit' && Boolean(binding.repo);
    return { ...binding, status: explicit ? 'ok' : 'candidate', source: sessionFile,
      ...(!explicit ? { reason: 'legacy or inferred binding; verify current user intent before task-bind' } : {}) };
  } catch {
    return { status: 'broken-binding', source: sessionFile, reason: 'session binding cannot be read; do not substitute another task' };
  }
}

function readRegistry() {
  const path = join(root, 'registry.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

function activeRegistryTasks() {
  return readRegistry().filter((task) => {
    return task.status === 'active' && task.journal_path && existsSync(task.journal_path);
  });
}

function scopedRegistryCandidates(repo) {
  const active = activeRegistryTasks();
  if (!repo) return active;
  return active.filter((task) => {
    return !task.repo || resolve(task.repo) === resolve(repo);
  });
}

function taskIdentity(task) {
  return task.task_id || task.journal_path || '';
}

function sameTask(left, right) {
  if (!left || !right) return false;
  if (left.task_id && right.task_id && left.task_id === right.task_id) return true;
  return Boolean(left.journal_path && right.journal_path && left.journal_path === right.journal_path);
}

function compactTask(task) {
  return {
    task_id: task.task_id || null,
    human_label: task.human_label || null,
    repo: task.repo || null,
    journal_path: task.journal_path || null,
    owner_host: task.owner_host || null,
  };
}

function finish(result, code) {
  if (result.journal_path && ['ok', 'legacy', 'candidate'].includes(result.status)) {
    try {
      validateJournal(result.journal_path, result.task_id);
    } catch (error) {
      const source = String(result.source || '');
      const status = source.includes(`${join(root, 'sessions')}${pathSep()}`)
        ? 'broken-binding' : source.endsWith('/CURRENT') ? 'broken-pointer' : 'broken-task';
      result = { ...result, status, reason: error.message };
      code = 1;
    }
  }
  // --bind-if-unambiguous is accepted for old hook callers but intentionally does
  // not mutate state. A repo default cannot establish the intent of a new chat.
  if (sessionId && ['ok', 'legacy'].includes(result.status)
      && result.binding_kind !== 'explicit') {
    result = { ...result, status: 'candidate',
      reason: 'workspace default is only a candidate; match the latest request and explicitly bind this session' };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(code);
}

function pathSep() { return process.platform === 'win32' ? '\\' : '/'; }

const repo = gitRoot(cwd);

const sessionCandidate = candidateFromSessionBinding();
if (sessionCandidate) {
  finish(sessionCandidate, ['ok', 'candidate'].includes(sessionCandidate.status) ? 0 : 1);
}

const repoCandidate = candidateFromRepoPointer(repo);
if (repoCandidate?.journal_path) {
  finish({ status: 'ok', ...repoCandidate }, 0);
}

if (repoCandidate?.error) {
  finish({ status: 'broken-pointer', ...repoCandidate }, 1);
}

const registryCandidates = scopedRegistryCandidates(repo);

if (registryCandidates.length > 1) {
  finish(
    {
      status: 'ambiguous',
      source: join(root, 'registry.json'),
      reason: 'multiple active task journals match this context and no session binding disambiguates them',
      tasks: registryCandidates.map(compactTask),
    },
    2,
  );
}

if (registryCandidates.length === 1) {
  const registryCandidate = registryCandidates[0];
  if (repoCandidate?.journal_path && !sameTask(repoCandidate, registryCandidate)) {
    finish(
      {
        status: 'ambiguous',
        source: join(root, 'registry.json'),
        reason: 'repo pointer and registry point at different active tasks',
        tasks: [compactTask(registryCandidate), compactTask(repoCandidate)],
      },
      2,
    );
  }

  finish(
    {
      ...registryCandidate,
      status: 'ok',
      source: join(root, 'registry.json'),
    },
    0,
  );
}

const allActiveTasks = activeRegistryTasks();
if (allActiveTasks.length > 1) {
  finish(
    {
      status: 'ambiguous',
      source: join(root, 'registry.json'),
      reason: 'multiple active task journals exist and none matches this context',
      tasks: allActiveTasks.map(compactTask),
    },
    2,
  );
}

const legacyCurrent = readText(join(root, 'CURRENT'));
const legacyCandidate = candidateFromDir(legacyCurrent, join(root, 'CURRENT'));
if (legacyCandidate) {
  finish({ status: 'legacy', ...legacyCandidate }, 0);
}

finish({ status: 'missing', cwd, repo: repo || null }, 1);
