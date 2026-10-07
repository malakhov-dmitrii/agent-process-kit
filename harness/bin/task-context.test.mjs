import { fileURLToPath as processKitFilePath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const RESOLVER = processKitFilePath(new URL('./resolve-current-task.mjs', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'task-context-'));
  const repo = join(root, 'repo');
  const traces = join(root, 'traces');
  mkdirSync(join(repo, '.agent', 'tasks'), { recursive: true });
  mkdirSync(join(traces, 'sessions'), { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const journal = join(repo, '.agent', 'tasks', 'old.md');
  writeFileSync(journal, '# Unrelated old task\nTask-ID: old\n');
  writeFileSync(join(repo, '.agent', 'CURRENT'), 'old\n');
  return { root, repo, traces, journal };
}
function resolveTask(fx, extra = [], session = 'fresh') {
  const env = { ...process.env, AGENT_TASK_TRACE_ROOT: fx.traces, OPERATOR_TRANSPARENCY_SESSION_ID: session,
    CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' };
  const run = spawnSync(process.execPath, [RESOLVER, fx.repo, ...extra], { encoding: 'utf8', env });
  assert.ok(run.stdout.trim(), run.stderr);
  return { run, value: JSON.parse(run.stdout) };
}
test('fresh session gets a candidate and never auto-binds an old CURRENT', () => {
  const fx = fixture();
  const { value } = resolveTask(fx, ['--bind-if-unambiguous']);
  assert.equal(value.status, 'candidate');
  assert.equal(existsSync(join(fx.traces, 'sessions', 'fresh.json')), false);
});
test('old implicit session binding is provisional, not authoritative', () => {
  const fx = fixture();
  writeFileSync(join(fx.traces, 'sessions', 'fresh.json'), JSON.stringify({ version: 1, task_id: 'old', repo: fx.repo,
    journal_path: fx.journal, source_task_resolution: join(fx.repo, '.agent', 'CURRENT') }));
  assert.equal(resolveTask(fx).value.status, 'candidate');
});
test('binding from a different workspace is rejected without falling back', () => {
  const fx = fixture();
  writeFileSync(join(fx.traces, 'sessions', 'fresh.json'), JSON.stringify({ version: 2, binding_kind: 'explicit',
    task_id: 'old', repo: join(fx.root, 'other'), journal_path: fx.journal }));
  assert.equal(resolveTask(fx).value.status, 'binding-mismatch');
});
test('broken explicit binding does not silently substitute another task', () => {
  const fx = fixture();
  writeFileSync(join(fx.traces, 'sessions', 'fresh.json'), JSON.stringify({ version: 2, binding_kind: 'explicit',
    task_id: 'new', repo: fx.repo, journal_path: join(fx.repo, 'missing.md') }));
  assert.equal(resolveTask(fx).value.status, 'broken-binding');
});
test('explicit binding wins and preserves the repo default for other sessions', () => {
  const fx = fixture();
  const journal = join(fx.repo, '.agent', 'tasks', 'new.md');
  writeFileSync(journal, '# New task\nTask-ID: new\n');
  writeFileSync(join(fx.traces, 'sessions', 'fresh.json'), JSON.stringify({ version: 2, binding_kind: 'explicit',
    task_id: 'new', repo: fx.repo, journal_path: journal }));
  assert.equal(resolveTask(fx).value.task_id, 'new');
  assert.equal(resolveTask(fx).value.status, 'ok');
  assert.equal(readFileSync(join(fx.repo, '.agent', 'CURRENT'), 'utf8'), 'old\n');
  assert.equal(resolveTask(fx, [], 'another').value.status, 'candidate');
});
test('headless legacy pointer read remains usable without a session', () => {
  const fx = fixture();
  assert.equal(resolveTask(fx, [], '').value.status, 'ok');
});
test('explicit execution worktree is also a valid context for the bound task', () => {
  const fx = fixture();
  const execution = join(fx.root, 'execution');
  mkdirSync(execution);
  execFileSync('git', ['-C', execution, 'init', '-q']);
  writeFileSync(join(fx.traces, 'sessions', 'fresh.json'), JSON.stringify({ version: 2, binding_kind: 'explicit',
    task_id: 'old', repo: fx.repo, worktree: execution, journal_path: fx.journal }));
  assert.equal(resolveTask({ ...fx, repo: execution }).value.status, 'ok');
});

test('nested repo task journal must match the directory task id', () => {
  const fx = fixture();
  const nested = join(fx.repo, '.agent', 'tasks', 'nested-task');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'journal.md'), '# Wrong identity\nTask-ID: another-task\n');
  writeFileSync(join(fx.repo, '.agent', 'CURRENT'), 'nested-task\n');
  const result = resolveTask(fx, [], 'nested-session').value;
  assert.equal(result.status, 'broken-pointer');
  assert.match(result.reason, /does not match/);
});

test('legacy nested task journal mismatch is rejected', () => {
  const fx = fixture();
  rmSync(join(fx.repo, '.agent', 'CURRENT'));
  const nested = join(fx.traces, 'legacy-task');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'journal.md'), '# Wrong identity\nTask-ID: another-task\n');
  writeFileSync(join(fx.traces, 'CURRENT'), nested);
  const result = resolveTask(fx, [], '').value;
  assert.equal(result.status, 'broken-pointer');
  assert.match(result.reason, /does not match/);
});
