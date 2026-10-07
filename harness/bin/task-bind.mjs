#!/usr/bin/env node
import { isMain } from './entrypoint.mjs';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  atomicWriteJson, ensureStateRoot, getStateRoot, handoffPath, readJson,
  sessionPath, validateJournal, withLock,
} from './task-store.mjs';

const HOSTS = new Set(['claude', 'codex', 'grok']);
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

function workspace(dir) {
  const value = resolve(dir);
  try {
    return realpathSync(execFileSync('git', ['-C', value, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim());
  } catch {
    return realpathSync(value);
  }
}

function parseArgs(argv) {
  const args = { repo: process.cwd(), host: 'codex' };
  const names = {
    '--task': 'task', '--journal': 'journal', '--repo': 'repo', '--worktree': 'worktree',
    '--session': 'session', '--host': 'host', '--replace': 'replace', '--accept-handoff': 'handoff', '--state-dir': 'stateRoot',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') args.dryRun = true;
    else if (names[argument]) args[names[argument]] = argv[++index];
    else if (argument !== '--help') throw new Error(`unknown argument ${argument}`);
  }
  args.session ||= process.env.OPERATOR_TRANSPARENCY_SESSION_ID
    || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (!TASK_ID.test(args.task || '')) throw new Error('valid --task required');
  if (!SESSION_ID.test(args.session || '')) throw new Error('valid --session required');
  if (!HOSTS.has(args.host)) throw new Error('invalid host');
  if (!args.journal) throw new Error('--journal required');
  return args;
}

function readCurrent(file) {
  try { return readJson(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertReplacementAllowed(current, args, journal, worktree) {
  if (!current) return;
  const same = current.task_id === args.task && current.journal_path === journal && current.worktree === worktree;
  if (!same && args.replace !== current.task_id) {
    throw new Error(`binding already selects ${current.task_id}; use --replace ${current.task_id}`);
  }
}

function preparedRecord(root, id, args, journal, repo, worktree) {
  const record = readJson(handoffPath(root, id));
  if (!['prepared', 'accepted'].includes(record.status)) throw new Error('handoff is not prepared');
  if (record.task_id !== args.task || record.recipient_host !== args.host
      || record.journal_path !== journal || record.worktree !== worktree) {
    throw new Error('handoff does not match this task and recipient');
  }
  return record;
}

export function acceptHandoff({ root = getStateRoot(), id, task, host, journal, repo, worktree, session, replace } = {}) {
  const args = { task, host };
  return withLock(handoffPath(root, id), () => {
    const record = preparedRecord(root, id, args, journal, repo, worktree);
    if (record.status === 'accepted') {
      if (record.accepted_session !== session) throw new Error('handoff already accepted by another session');
      const binding = readCurrent(sessionPath(root, session));
      if (!binding || binding.handoff_id !== id || binding.handoff_generation !== record.generation
          || binding.task_id !== task || binding.journal_path !== journal
          || binding.repo !== repo || binding.worktree !== worktree || binding.owner_host !== host) {
        throw new Error('accepted handoff has no matching receiver binding');
      }
      return record;
    }
    const binding = {
      version: 3, binding_kind: 'explicit', session_id: session, task_id: task,
      repo, worktree, journal_path: journal, owner_host: host,
      handoff_id: id, handoff_generation: record.generation, bound_at: new Date().toISOString(),
    };
    const receiver = sessionPath(root, session);
    withLock(receiver, () => {
      const current = readCurrent(receiver);
      if (current) {
        const same = current.task_id === task && current.journal_path === journal
          && current.worktree === worktree && current.owner_host === host;
        if (!same && replace !== current.task_id) {
          throw new Error(`binding already selects ${current.task_id}; use --replace ${current.task_id}`);
        }
      }
      atomicWriteJson(receiver, binding);
    });
    const accepted = {
      ...record, status: 'accepted', accepted_session: session, accepted_host: host,
      accepted_generation: record.generation, accepted_repo: repo, accepted_at: binding.bound_at,
    };
    atomicWriteJson(handoffPath(root, id), accepted);
    return accepted;
  });
}

function bind(args) {
  const root = args.stateRoot || getStateRoot();
  const journal = realpathSync(validateJournal(args.journal, args.task));
  const repo = workspace(args.repo);
  const worktree = workspace(args.worktree || args.repo);
  const file = sessionPath(root, args.session);
  if (args.handoff) {
    if (args.dryRun) { preparedRecord(root, args.handoff, args, journal, repo, worktree); return { mode: 'dry-run' }; }
    return { status: 'bound', handoff: acceptHandoff({ root, id: args.handoff, ...args, journal, repo, worktree, replace: args.replace }) };
  }
  const binding = {
    version: 3, binding_kind: 'explicit', session_id: args.session, task_id: args.task,
    repo, worktree, journal_path: journal, owner_host: args.host, bound_at: new Date().toISOString(),
  };
  if (args.dryRun) return { mode: 'dry-run', binding };
  withLock(file, () => {
    assertReplacementAllowed(readCurrent(file), args, journal, worktree);
    atomicWriteJson(file, binding);
  });
  return { status: 'bound', binding_path: file, ...binding };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('usage: task-bind.mjs --task <id> --journal <file> --repo <workspace> [--worktree <dir>] [--session <id>] [--host claude|codex|grok] [--replace <old-task>] [--accept-handoff <id>] [--dry-run]');
    return 0;
  }
  try {
    const args = parseArgs(argv);
    if (!args.dryRun) ensureStateRoot(getStateRoot());
    console.log(JSON.stringify(bind(args)));
    return 0;
  } catch (error) {
    console.error(`task-bind: ${error.message}`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exitCode = main();
