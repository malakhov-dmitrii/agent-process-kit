import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { taskIdFromJournal, validateJournal, ensureStateRoot, atomicWriteJson, sessionPath, handoffPath } from './task-store.mjs';

test('Task-ID parser ignores fenced examples and rejects a mismatched journal', () => {
  const text = '```md\nTask-ID: example\n```\nTask-ID: actual\n';
  assert.equal(taskIdFromJournal(text), 'actual');
  const dir = mkdtempSync(join(tmpdir(), 'task-store-id-'));
  const journal = join(dir, 'journal.md');
  writeFileSync(journal, text);
  assert.throws(() => validateJournal(journal, 'wrong'), /does not match/);
});

test('state records validate IDs and reject a symlink root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-store-root-'));
  const target = join(dir, 'real');
  const link = join(dir, 'link');
  mkdirSync(target);
  symlinkSync(target, link);
  assert.throws(() => ensureStateRoot(link), /symlink/);
  assert.throws(() => sessionPath(target, '../escape'), /invalid session id/);
  assert.throws(() => handoffPath(target, '../escape'), /invalid handoff id/);
});

test('interrupted acceptance remains pending until the canonical record is accepted', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-store-recovery-'));
  ensureStateRoot(root);
  const journal = join(root, 'journal.md');
  writeFileSync(journal, 'Task-ID: recovery\n');
  const session = sessionPath(root, 'receiver');
  atomicWriteJson(session, { version: 3, binding_kind: 'explicit', session_id: 'receiver', task_id: 'recovery', handoff_id: 'h1', handoff_generation: 1 });
  atomicWriteJson(handoffPath(root, 'h1'), { status: 'prepared', generation: 1, task_id: 'recovery' });
  assert.equal(JSON.parse(readFileSync(session, 'utf8')).handoff_generation, 1);
  atomicWriteJson(handoffPath(root, 'h1'), { status: 'accepted', generation: 1, accepted_session: 'receiver', accepted_generation: 1, task_id: 'recovery' });
  assert.equal(JSON.parse(readFileSync(handoffPath(root, 'h1'), 'utf8')).status, 'accepted');
});
