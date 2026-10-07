import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const harness = resolve(process.argv[2]);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'process-runtime-')));
const chat = join(root, 'chat'), execution = join(root, 'execution'), traces = join(root, 'traces');
for (const dir of [chat, execution]) { mkdirSync(join(dir, '.agent', 'tasks'), { recursive: true }); execFileSync('git', ['-C', dir, 'init', '-q']); }
const journal = join(chat, '.agent', 'tasks', 'actual.md');
const old = join(chat, '.agent', 'tasks', 'old.md');
writeFileSync(old, '# Unrelated task'); writeFileSync(join(chat, '.agent', 'CURRENT'), 'old');
writeFileSync(journal, '# Actual task\nTask-ID: actual\n\n## Acceptance\n- [ ] A1: roundtrip\n');
writeFileSync(join(execution, 'unfinished.txt'), 'preserve new work');
const otherJournal = join(execution, '.agent', 'tasks', 'other.md'); writeFileSync(otherJournal, '# Different task');
const otherPointer = JSON.stringify({ task_id: 'actual', status: 'active', journal: '.agent/tasks/other.md' });
writeFileSync(join(execution, '.agent', 'CURRENT'), otherPointer);
const env = { ...process.env, AGENT_TASK_TRACE_ROOT: traces, RECEIPT_CHECK_LOG: join(root, 'receipts.jsonl') };
const results = [];
function run(file, args = [], { session = 'sender', cwd = chat, input } = {}) {
  const r = spawnSync(process.execPath, [join(harness, 'bin', file), ...args], {
    env: { ...env, OPERATOR_TRANSPARENCY_SESSION_ID: session }, cwd, input,
    encoding: 'utf8', timeout: 10000,
  });
  if (r.error) throw r.error;
  return r;
}
assert.equal(JSON.parse(run('resolve-current-task.mjs', [chat]).stdout).status, 'broken-pointer'); results.push('invalid-pointer-rejected');
let r = run('task-bind.mjs', ['--task', 'actual', '--journal', journal, '--repo', chat, '--worktree', execution, '--host', 'codex']);
assert.equal(r.status, 0, r.stderr); results.push('explicit-bind');
for (const cwd of [chat, execution]) assert.equal(JSON.parse(run('resolve-current-task.mjs', [cwd]).stdout).task_id, 'actual');
results.push('chat-and-execution-context');
r = run('handoff.mjs', ['--to', 'claude', '--next', 'verify A1', '-C', execution]);
assert.equal(r.status, 0, r.stderr);
assert.equal(readFileSync(join(execution, '.agent', 'CURRENT'), 'utf8'), otherPointer);
let body = readFileSync(journal, 'utf8');
assert.match(body, /dirty=3/);
const handoff = body.match(/^Handoff-ID: (.+)$/m)[1];
assert.ok(!body.includes('Handoff-accepted:')); results.push('handoff-prepared-no-false-ack');
assert.equal(JSON.parse(readFileSync(join(traces, 'handoffs', `${handoff}.json`), 'utf8')).status, 'prepared'); results.push('canonical-handoff-prepared');
r = run('task-bind.mjs', ['--task', 'actual', '--journal', journal, '--repo', execution, '--host', 'claude', '--accept-handoff', handoff], { session: 'receiver', cwd: execution });
assert.equal(r.status, 0, r.stderr); results.push('receiver-acknowledged');
assert.equal(run('task-check.mjs', ['--task', 'actual', '--journal', journal]).status, 2); results.push('pending-rejected');
const payload = { cwd: execution, session_id: 'receiver', last_assistant_message: 'Task complete: actual' };
r = run('scope-control-hook.mjs', ['--event', 'Stop'], { cwd: execution, session: 'receiver', input: JSON.stringify(payload) });
assert.equal(JSON.parse(r.stdout).decision, 'block'); results.push('stop-rejects-pending');
body = readFileSync(journal, 'utf8').replace('- [ ] A1: roundtrip', '- [x] A1: roundtrip | Evidence: runtime-smoke assertions passed');
writeFileSync(journal, body);
assert.equal(run('task-check.mjs', ['--task', 'actual', '--journal', journal]).status, 0);
assert.equal(JSON.parse(run('task-check.mjs', ['--task', 'actual', '--journal', journal]).stdout).status, 'ready'); results.push('ready-recorded-not-evidence-verified');
r = run('scope-control-hook.mjs', ['--event', 'Stop'], { cwd: execution, session: 'receiver', input: JSON.stringify(payload) });
assert.notEqual(JSON.parse(r.stdout).decision, 'block'); results.push('completed-accepted');
for (const host of ['claude', 'codex']) {
  r = spawnSync('/bin/bash', [join(harness, 'hooks', `operator-transparency-${host}.sh`)], {
    env: { ...env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, AGENT_TASK_RESOLVER: join(harness, 'bin', 'resolve-current-task.mjs') },
    input: JSON.stringify({ cwd: execution, session_id: 'receiver' }), encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr); assert.ok(r.stdout.includes(`active journal ${journal}`));
}
results.push('both-context-adapters');
process.env.AGENT_TASK_TRACE_ROOT = traces;
const { checkpointFromHook } = await import(pathToFileURL(join(harness, 'bin', 'checkpoint-from-hook.mjs')));
const checkpoint = await checkpointFromHook({ host: 'claude', event: 'PreCompact',
  payload: { cwd: execution, session_id: 'receiver', hook_event_name: 'PreCompact' },
  manifest: JSON.parse(readFileSync(join(harness, 'manifest.json'))), outputRoot: join(root, 'checkpoints'), stateRoot: join(root, 'state') });
assert.equal(checkpoint.mode, 'written', JSON.stringify(checkpoint)); results.push('precompact-correct-task');
assert.equal(readFileSync(join(chat, '.agent', 'CURRENT'), 'utf8'), 'old');
console.log(JSON.stringify({ status: 'PASS', harness, checks: results, fixture: root }, null, 2));
