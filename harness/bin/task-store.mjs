import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function getStateRoot(env = process.env) {
  return resolve(env.AGENT_TASK_TRACE_ROOT || env.AGENT_PROCESS_STATE_DIR || join(homedir(), '.agent-process-kit'));
}

export function assertSafePath(file, { allowMissing = true, label = 'path' } = {}) {
  const target = resolve(file);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink ${label}: ${target}`);
  } else if (!allowMissing) throw new Error(`${label} does not exist: ${target}`);
  return target;
}

export function ensureStateRoot(root = getStateRoot()) {
  const target = assertSafePath(root, { label: 'state root' });
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (lstatSync(target).isSymbolicLink()) throw new Error(`Refusing symlink state root: ${target}`);
  for (const name of ['sessions', 'handoffs']) {
    const dir = join(target, name);
    assertSafePath(dir, { label: `${name} directory` });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return target;
}

export function readJson(file) {
  if (!existsSync(file)) { const error = new Error(`state file does not exist: ${file}`); error.code = 'ENOENT'; throw error; }
  assertSafePath(file, { allowMissing: false, label: 'state file' });
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function atomicWriteJson(file, value) {
  const target = assertSafePath(file, { label: 'state file' });
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return target;
}

export function withLock(file, callback) {
  const lockPath = `${assertSafePath(file, { label: 'lock target' })}.lock`;
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    return callback();
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (fd !== undefined) unlinkSync(lockPath);
  }
}

export function taskIdFromJournal(text) {
  let fence = null;
  const ids = [];
  for (const line of String(text).split(/\r?\n/)) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue; }
    if (!fence && /^Task-ID:\s*/.test(line)) ids.push(line.slice(8).trim());
  }
  if (ids.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ids[0])) throw new Error('journal must contain exactly one valid Task-ID');
  return ids[0];
}

export function validateJournal(journal, taskId) {
  const file = assertSafePath(journal, { allowMissing: false, label: 'journal' });
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error('journal must be a regular file');
  const actual = taskIdFromJournal(readFileSync(file, 'utf8'));
  if (actual !== taskId) throw new Error(`journal Task-ID ${actual} does not match ${taskId}`);
  return file;
}

function safeRecordId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}
export function sessionPath(root, session) {
  const stateRoot = assertSafePath(root, { label: 'state root' });
  return join(stateRoot, 'sessions', `${safeRecordId(session, 'session id')}.json`);
}
export function handoffPath(root, id) {
  const stateRoot = assertSafePath(root, { label: 'state root' });
  return join(stateRoot, 'handoffs', `${safeRecordId(id, 'handoff id')}.json`);
}
