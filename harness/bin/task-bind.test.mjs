import { fileURLToPath as processKitFilePath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const CLI = processKitFilePath(new URL('./task-bind.mjs', import.meta.url));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'task-bind-'));
  const journal = join(dir, 'task.md');
  writeFileSync(journal, '# Task\nTask-ID: task\n');
  const root = join(dir, 'traces');
  mkdirSync(join(root, 'sessions'), { recursive: true });
  return { dir, root, journal, binding: join(root, 'sessions', 's1.json') };
}
function run(fx, extra = []) {
  const result = spawnSync(process.execPath, [CLI, '--task', 'task', '--journal', fx.journal,
    '--repo', fx.dir, '--session', 's1', '--host', 'codex', ...extra], {
    encoding: 'utf8', env: { ...process.env, AGENT_TASK_TRACE_ROOT: fx.root, AGENT_PROCESS_STATE_DIR: fx.root },
  });
  return result;
}
test('bind existing journal explicitly without changing shared pointers or other sessions', () => {
  const fx = fixture();
  writeFileSync(join(fx.root, 'sessions', 's2.json'), 'other session');
  const r = run(fx);
  assert.equal(r.status, 0, r.stderr);
  const binding = JSON.parse(readFileSync(fx.binding, 'utf8'));
  assert.equal(binding.binding_kind, 'explicit');
  assert.equal(binding.task_id, 'task');
  assert.equal(readFileSync(join(fx.root, 'sessions', 's2.json'), 'utf8'), 'other session');
  assert.equal(existsSync(join(fx.dir, '.agent', 'CURRENT')), false);
});

test('distinct chat repo and execution worktree resolve from either context', () => {
  const fx = fixture();
  const execution = join(fx.dir, 'execution');
  mkdirSync(execution);
  assert.equal(run(fx, ['--worktree', execution]).status, 0);
  const resolver = processKitFilePath(new URL('./resolve-current-task.mjs', import.meta.url));
  for (const cwd of [fx.dir, execution]) {
    const result = spawnSync(process.execPath, [resolver, cwd], { encoding: 'utf8', env: { ...process.env, AGENT_TASK_TRACE_ROOT: fx.root, OPERATOR_TRANSPARENCY_SESSION_ID: 's1' } });
    assert.equal(JSON.parse(result.stdout).status, 'ok', result.stderr);
  }
});
test('replacement requires naming the old task and never silently overwrites it', () => {
  const fx = fixture();
  const old = JSON.stringify({ task_id: 'previous', repo: fx.dir, journal_path: fx.journal });
  writeFileSync(fx.binding, old);
  assert.equal(run(fx).status, 2);
  assert.equal(readFileSync(fx.binding, 'utf8'), old);
  assert.equal(run(fx, ['--replace', 'wrong']).status, 2);
  assert.equal(run(fx, ['--replace', 'previous']).status, 0);
});
test('receiver may have a different chat context from the sender', () => {
  const fx = fixture();
  const sender = join(fx.dir, 'sender-chat');
  mkdirSync(sender);
  mkdirSync(join(fx.root, 'handoffs'), { recursive: true });
  writeFileSync(join(fx.root, 'handoffs', 'different-chat.json'), JSON.stringify({
    status: 'prepared', generation: 1, task_id: 'task', recipient_host: 'codex',
    journal_path: realpathSync(fx.journal), repo: realpathSync(sender), worktree: realpathSync(fx.dir),
  }));
  const result = run(fx, ['--accept-handoff', 'different-chat']);
  assert.equal(result.status, 0, result.stderr);
  const binding = JSON.parse(readFileSync(fx.binding, 'utf8'));
  assert.equal(binding.repo, realpathSync(fx.dir));
  assert.equal(run(fx, ['--accept-handoff', 'different-chat']).status, 0);
});

test('same task id with another journal requires explicit replacement', () => {
  const fx = fixture();
  assert.equal(run(fx).status, 0);
  const other = join(fx.dir, 'other.md');
  writeFileSync(other, 'Task-ID: task\n');
  assert.equal(run(fx, ['--journal', other]).status, 2);
  assert.equal(run(fx, ['--journal', other, '--replace', 'task']).status, 0);
  assert.equal(JSON.parse(readFileSync(fx.binding, 'utf8')).journal_path, realpathSync(other));
});
test('missing journal, unsafe session and held lock reject without writes', () => {
  const fx = fixture();
  assert.equal(run(fx, ['--journal', join(fx.dir, 'missing')]).status, 2);
  assert.equal(run(fx, ['--session', '../escape']).status, 2);
  writeFileSync(`${fx.binding}.lock`, 'other writer');
  assert.equal(run(fx).status, 2);
  assert.equal(existsSync(fx.binding), false);
});
test('receiving bind acknowledges only matching task and intended host, once', () => {
  const fx = fixture();
  writeFileSync(fx.journal, '# Task\nTask-ID: task\n');
  mkdirSync(join(fx.root, 'handoffs'), { recursive: true });
  const foreign = join(fx.dir, 'foreign.md');
  writeFileSync(foreign, 'Task-ID: task\n');
  const prepared = spawnSync(process.execPath, [processKitFilePath(new URL('./handoff.mjs', import.meta.url)), '--to', 'codex', '--next', 'finish', '-C', fx.dir], {
    encoding: 'utf8', env: { ...process.env, AGENT_TASK_TRACE_ROOT: fx.root, AGENT_PROCESS_STATE_DIR: fx.root, HANDOFF_RESOLVER: processKitFilePath(new URL('./resolve-current-task.mjs', import.meta.url)), OPERATOR_TRANSPARENCY_SESSION_ID: 'sender' },
  });
  assert.equal(prepared.status, 2); // no explicit sender binding: prepare through the fixture below
  writeFileSync(join(fx.root, 'handoffs', 'h1.json'), JSON.stringify({ status: 'prepared', generation: 1, task_id: 'task', recipient_host: 'codex', journal_path: realpathSync(fx.journal), repo: realpathSync(fx.dir), worktree: realpathSync(fx.dir) }));
  assert.equal(run(fx, ['--accept-handoff', 'h1', '--host', 'claude']).status, 2);
  assert.equal(run(fx, ['--accept-handoff', 'missing']).status, 2);
  assert.equal(run(fx, ['--accept-handoff', 'h1']).status, 0);
  assert.equal(run(fx, ['--accept-handoff', 'h1']).status, 0);
  assert.equal(JSON.parse(readFileSync(join(fx.root, 'handoffs', 'h1.json'), 'utf8')).status, 'accepted');
});

test('accepted retry rejects a same-id receiver bound to another journal', () => {
  const fx = fixture();
  mkdirSync(join(fx.root, 'handoffs'), { recursive: true });
  const other = join(fx.dir, 'other.md');
  writeFileSync(other, 'Task-ID: task\n');
  writeFileSync(join(fx.root, 'handoffs', 'h1.json'), JSON.stringify({
    status: 'accepted', generation: 1, task_id: 'task', recipient_host: 'codex',
    journal_path: realpathSync(fx.journal), repo: realpathSync(fx.dir), worktree: realpathSync(fx.dir),
    accepted_session: 's1', accepted_generation: 1,
  }));
  writeFileSync(fx.binding, JSON.stringify({ version: 3, binding_kind: 'explicit', session_id: 's1', task_id: 'task', owner_host: 'codex', handoff_id: 'h1', handoff_generation: 1, journal_path: realpathSync(other), worktree: realpathSync(fx.dir) }));
  assert.equal(run(fx, ['--accept-handoff', 'h1']).status, 2);
});

test('handoff receiver accepts explicit replacement for same task id', () => {
  const fx = fixture();
  mkdirSync(join(fx.root, 'handoffs'), { recursive: true });
  const foreign = join(fx.dir, 'foreign.md');
  writeFileSync(foreign, 'Task-ID: task\n');
  writeFileSync(join(fx.root, 'handoffs', 'h1.json'), JSON.stringify({
    status: 'prepared', generation: 1, task_id: 'task', recipient_host: 'codex',
    journal_path: realpathSync(fx.journal), repo: realpathSync(fx.dir), worktree: realpathSync(fx.dir),
  }));
  writeFileSync(fx.binding, JSON.stringify({ version: 3, binding_kind: 'explicit', session_id: 's1', task_id: 'task', owner_host: 'codex', journal_path: realpathSync(foreign), worktree: realpathSync(fx.dir) }));
  assert.equal(run(fx, ['--accept-handoff', 'h1']).status, 2);
  assert.equal(run(fx, ['--accept-handoff', 'h1', '--replace', 'task']).status, 0);
});
test('dry run creates no session binding or acknowledgement', () => {
  const fx = fixture();
  assert.equal(run(fx, ['--dry-run']).status, 0);
  assert.equal(existsSync(fx.binding), false);
  assert.equal(readFileSync(fx.journal, 'utf8'), '# Task\nTask-ID: task\n');
});
test('task ids must satisfy the checkpoint identity contract', () => {
  const fx = fixture();
  assert.equal(run(fx, ['--task', 'task.1', '--dry-run']).status, 2);
  assert.equal(run(fx, ['--task', 'a'.repeat(129), '--dry-run']).status, 2);
  writeFileSync(fx.journal, `# Task\nTask-ID: ${'a'.repeat(128)}\n`);
  assert.equal(run(fx, ['--task', 'a'.repeat(128), '--dry-run']).status, 0);
});
