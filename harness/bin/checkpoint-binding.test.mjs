import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { findActiveTask } from './checkpoint-from-hook.mjs';

test('checkpoint follows explicit chat binding instead of stale CURRENT', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-binding-')));
  const traces = join(dir, 'traces');
  mkdirSync(join(traces, 'sessions'), { recursive: true });
  mkdirSync(join(dir, '.agent', 'tasks'), { recursive: true });
  writeFileSync(join(dir, '.agent', 'CURRENT'), 'old');
  writeFileSync(join(dir, '.agent', 'tasks', 'old.md'), '# Wrong task');
  const journal = join(dir, 'new.md');
  writeFileSync(journal, '# Correct task\nTask-ID: new\n');
  writeFileSync(join(traces, 'sessions', 's1.json'), JSON.stringify({ version: 2, binding_kind: 'explicit', task_id: 'new', repo: dir, journal_path: journal }));
  const task = await findActiveTask(dir, { session_id: 's1' }, traces);
  assert.equal(task?.id, 'new');
  assert.equal(task?.text, '# Correct task\nTask-ID: new\n');
  assert.equal(await findActiveTask(dir, { session_id: 'fresh' }, traces), null);
});
