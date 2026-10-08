import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('internal CLI executes through a directory alias with spaces', () => {
  const temp = mkdtempSync(join(tmpdir(), 'kit entry alias '));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const alias = join(temp, 'alias package');
  symlinkSync(root, alias, 'dir');
  for (const script of ['task-bind', 'task-check', 'review']) {
    const result = spawnSync(process.execPath, [join(alias, 'harness/bin', `${script}.mjs`), '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage:/i, script);
  }
});
