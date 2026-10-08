import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/agent-process-kit.mjs', import.meta.url));
const version = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)))).version;
function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
}
test('public help/version work without an account; unknown commands fail', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /init.*bind.*status/s);
  assert.equal(run(['--version']).stdout.trim(), version);
  assert.equal(run(['unknown']).status, 2);
});
test('init creates a usable pending journal without overwriting existing work', () => {
  const project = mkdtempSync(join(tmpdir(), 'kit CLI project '));
  const r = run(['init', '--project', project, '--task', 'demo', '--goal', 'Verify a user flow']);
  assert.equal(r.status, 0, r.stderr);
  const value = JSON.parse(r.stdout);
  const body = readFileSync(value.journal_path, 'utf8');
  assert.match(body, /Task-ID: demo/);
  assert.match(body, /Verify a user flow/);
  const check = run(['check', '--journal', value.journal_path, '--task', 'demo']);
  assert.equal(check.status, 2);
  assert.equal(JSON.parse(check.stdout).status, 'incomplete');
  writeFileSync(value.journal_path, 'human edit');
  assert.equal(run(['init', '--project', project, '--task', 'demo']).status, 2);
  assert.equal(readFileSync(value.journal_path, 'utf8'), 'human edit');
});
test('init rejects traversal and setup defaults to a non-mutating preview', () => {
  const project = mkdtempSync(join(tmpdir(), 'kit CLI safety '));
  assert.equal(run(['init', '--project', project, '--task', '../escape']).status, 2);
  const preview = run(['setup', '--project', project]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).mode, 'dry-run');
});
test('CLI works through the symlink used by npm global installations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit global bin '));
  const link = join(dir, 'agent-process-kit');
  symlinkSync(cli, link);
  const result = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), version);
});
test('hook adapter supplies the selected subagent event and rejects event mismatch', () => {
  const state = mkdtempSync(join(tmpdir(), 'kit hook state '));
  const invoke = payload => spawnSync(process.execPath, [cli, 'hook', '--host', 'claude', '--event', 'SubagentStop', '--state-dir', state], {
    input: JSON.stringify(payload), encoding: 'utf8',
  });
  const result = invoke({ last_assistant_message: 'Task complete: demo', session_id: 'child' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
  assert.equal(invoke({ hook_event_name: 'Stop' }).status, 2);
});
