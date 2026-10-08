import { fileURLToPath as processKitFilePath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAgentCurrent, VERBS } from './agent-current.mjs';

const N = process.execPath;
const resolverPath = () => processKitFilePath(new URL('./resolve-current-task.mjs', import.meta.url));
const fixtureEnv = (root) => ({ ...process.env, AGENT_TASK_TRACE_ROOT: join(root, '.agent-task-traces'),
  OPERATOR_TRANSPARENCY_SESSION_ID: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' });

function makeHome(label) {
  const home = mkdtempSync(join(tmpdir(), `resolver-${label}-`));
  mkdirSync(join(home, '.agent-task-traces', 'bin'), { recursive: true });
  copyFileSync(resolverPath(), join(home, '.agent-task-traces', 'bin', 'resolve-current-task.mjs'));
  copyFileSync(processKitFilePath(new URL('./task-store.mjs', import.meta.url)), join(home, '.agent-task-traces', 'bin', 'task-store.mjs'));
  writeFileSync(join(home, '.agent-task-traces', 'registry.json'), JSON.stringify({ version: 1, tasks: [] }));
  return home;
}

describe('parseAgentCurrent', () => {
  it('VERBS set contains expected values', () => {
    assert.ok(VERBS.has('active'));
    assert.ok(VERBS.has('paused'));
    assert.ok(VERBS.has('blocked'));
    assert.ok(VERBS.has('handoff'));
    assert.ok(VERBS.has('done'));
    assert.equal(VERBS.size, 5);
  });

  it('plain id', () => {
    const r = parseAgentCurrent('my-task-2026-01-01');
    assert.equal(r.format, 'plain');
    assert.equal(r.top.task_id, 'my-task-2026-01-01');
    assert.equal(r.top.status, 'unknown');
    assert.deepEqual(r.parked, []);
    assert.deepEqual(r.warnings, []);
  });

  it('FanEmpire-shaped JSON (no status → status unknown)', () => {
    const json = JSON.stringify({
      task_id: 'payment-inbound-write-time-2026-09-21',
      map: 'DELIVERED: something',
      phase: 'delivered-awaiting-chip-uat',
      journal: '.agent/tasks/payment-inbound-write-time-2026-09-21.md',
      note: 'some note',
      parked: [
        { task_id: 'dropp-donation-open-amount-2026-09-14', phase: 'some-phase' },
      ],
    });
    const r = parseAgentCurrent(json);
    assert.equal(r.format, 'json');
    assert.equal(r.top.task_id, 'payment-inbound-write-time-2026-09-21');
    assert.equal(r.top.status, 'unknown');
    assert.equal(r.parked.length, 1);
    assert.equal(r.parked[0].task_id, 'dropp-donation-open-amount-2026-09-14');
    assert.equal(r.parked[0].status, 'unknown');
    assert.deepEqual(r.warnings, []);
  });

  it('valid verb (active)', () => {
    const r = parseAgentCurrent(JSON.stringify({ task_id: 'my-task', status: 'active' }));
    assert.equal(r.format, 'json');
    assert.equal(r.top.status, 'active');
    assert.deepEqual(r.warnings, []);
  });

  it('invalid verb → warning + status unknown', () => {
    const r = parseAgentCurrent(JSON.stringify({ task_id: 'my-task', status: 'running' }));
    assert.equal(r.format, 'json');
    assert.equal(r.top.status, 'unknown');
    assert.ok(r.warnings.some(w => w.includes('unknown status')));
  });

  it('blocked without by → warning', () => {
    const r = parseAgentCurrent(JSON.stringify({ task_id: 'my-task', status: 'blocked' }));
    assert.equal(r.top.status, 'blocked');
    assert.ok(r.warnings.some(w => w.includes('"blocked" requires "by"')));
  });

  it('handoff without by → warning', () => {
    const r = parseAgentCurrent(JSON.stringify({ task_id: 'my-task', status: 'handoff' }));
    assert.equal(r.top.status, 'handoff');
    assert.ok(r.warnings.some(w => w.includes('"handoff" requires "by"')));
  });

  it('garbage → invalid', () => {
    const r = parseAgentCurrent('{not valid json}}');
    assert.equal(r.format, 'invalid');
    assert.equal(r.top, null);
    assert.ok(r.warnings.some(w => w.includes('invalid JSON')));
  });

  it('empty string → invalid', () => {
    const r = parseAgentCurrent('');
    assert.equal(r.format, 'invalid');
  });
});

describe('resolver subprocess: JSON CURRENT', () => {
  it('JSON CURRENT with valid journal → status ok', () => {
    const home = makeHome('json');
    const repo = mkdtempSync(join(tmpdir(), 'repo-json-'));
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
    mkdirSync(join(repo, '.agent', 'tasks'), { recursive: true });
    writeFileSync(join(repo, '.agent', 'tasks', 'test-task-2026.md'), '# Test Task\nTask-ID: test-task-2026\n');
    writeFileSync(join(repo, '.agent', 'CURRENT'), JSON.stringify({
      task_id: 'test-task-2026',
      journal: '.agent/tasks/test-task-2026.md',
      status: 'active',
    }, null, 2));

    const result = JSON.parse(execFileSync(
      N,
      [join(home, '.agent-task-traces', 'bin', 'resolve-current-task.mjs'), repo],
      { env: fixtureEnv(home), encoding: 'utf8' },
    ));
    assert.equal(result.status, 'ok', `expected ok, got ${JSON.stringify(result)}`);
    assert.ok(result.journal_path.endsWith('test-task-2026.md'), result.journal_path);
  });

  it('plain id CURRENT → ok (unchanged)', () => {
    const home = makeHome('plain');
    const repo = mkdtempSync(join(tmpdir(), 'repo-plain-'));
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
    mkdirSync(join(repo, '.agent', 'tasks'), { recursive: true });
    writeFileSync(join(repo, '.agent', 'tasks', 'plain-task.md'), '# Plain\nTask-ID: plain-task\n');
    writeFileSync(join(repo, '.agent', 'CURRENT'), 'plain-task');

    const result = JSON.parse(execFileSync(
      N,
      [join(home, '.agent-task-traces', 'bin', 'resolve-current-task.mjs'), repo],
      { env: fixtureEnv(home), encoding: 'utf8' },
    ));
    assert.ok(result.journal_path?.endsWith('plain-task.md'), `got ${result.journal_path}`);
  });

  it('invalid JSON CURRENT → broken-pointer', () => {
    const home = makeHome('invalid');
    const repo = mkdtempSync(join(tmpdir(), 'repo-invalid-'));
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
    mkdirSync(join(repo, '.agent'), { recursive: true });
    writeFileSync(join(repo, '.agent', 'CURRENT'), '{not valid json}');

    // resolver exits 1 for broken-pointer; use spawnSync to avoid throw
    const { stdout, status } = spawnSync(
      N,
      [join(home, '.agent-task-traces', 'bin', 'resolve-current-task.mjs'), repo],
      { env: fixtureEnv(home), encoding: 'utf8' },
    );
    assert.equal(status, 1, `expected exit 1, got ${status}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'broken-pointer', JSON.stringify(result));
    assert.ok(result.error?.includes('invalid JSON CURRENT'), `error: ${result.error}`);
  });
});

  it('journal without Task-ID → broken-pointer', () => {
    const home = makeHome('missing-task-id');
    const repo = mkdtempSync(join(tmpdir(), 'repo-missing-task-id-'));
    execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
    mkdirSync(join(repo, '.agent', 'tasks'), { recursive: true });
    writeFileSync(join(repo, '.agent', 'tasks', 'missing.md'), '# Missing identity\n');
    writeFileSync(join(repo, '.agent', 'CURRENT'), JSON.stringify({ task_id: 'missing', journal: '.agent/tasks/missing.md' }));
    const result = JSON.parse(spawnSync(N, [join(home, '.agent-task-traces', 'bin', 'resolve-current-task.mjs'), repo], { env: fixtureEnv(home), encoding: 'utf8' }).stdout);
    assert.equal(result.status, 'broken-pointer');
  });
