import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('package entrypoint responds to help', () => {
  const result = spawnSync(process.execPath, ['bin/agent-process-kit.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /task start/); assert.match(result.stdout, /verify-setup/); assert.match(result.stdout, /integrate/); assert.match(result.stdout, /record-intent/);
});

test('installed bin symlink executes the CLI main entrypoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apk-bin-smoke-'));
  const link = join(directory, 'agent-process-kit');
  symlinkSync(resolve('bin/agent-process-kit.mjs'), link);
  const result = spawnSync(link, ['--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agent-process-kit 0\.4/);
});
