import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const repo = join(new URL('../..', import.meta.url).pathname);
const cli = join(repo, 'bin/agent-process-kit.mjs');
const fixture = () => mkdtempSync(join(tmpdir(), 'apk cp012 project '));
const run = (args, cwd) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const parsed = (result) => { assert.ok(result.stdout, result.stderr); return JSON.parse(result.stdout); };

test('CLI has stable JSON envelope and starts/statuses a durable task', () => {
  const project = fixture(); const state = join(project, '.state with spaces');
  const started = run(['task', 'start', '--task-id', 'cp012', '--request', 'Fix a typo', '--state-dir', state], project);
  assert.equal(started.status, 0, started.stderr); const start = parsed(started);
  assert.equal(start.ok, true); assert.equal(start.taskId, 'cp012'); assert.equal(start.result.record.taskId, 'cp012');
  const status = run(['task', 'status', '--task-id', 'cp012', '--state-dir', state], project);
  assert.equal(status.status, 0, status.stderr); const value = parsed(status);
  assert.equal(value.ok, true); assert.equal(value.result.taskId, 'cp012'); assert.equal(value.recordVersion, undefined);
  const fresh = run(['hook', '--state-dir', state, '--host', 'codex', '--event', 'SessionStart', '--data', JSON.stringify({ sessionId: 'fresh-session', workspace: project })], project);
  assert.equal(fresh.status, 0, fresh.stderr);
  const resolution = parsed(fresh).result.resolution;
  assert.equal(resolution.status, 'candidate');
  assert.equal(resolution.taskId, 'cp012');
});

test('setup preview/apply/verify/rollback is hash-owned and preserves foreign files', () => {
  const project = fixture(); writeFileSync(join(project, 'AGENTS.md'), 'human instructions');
  const preview = parsed(run(['setup', '--project', project], project)); assert.equal(preview.ok, true); assert.equal(preview.result.mode, 'preview');
  assert.equal(existsSync(join(project, '.agent-process-kit')), false);
  const installed = parsed(run(['setup', '--project', project, '--apply'], project)); assert.equal(installed.result.receiptPhase, 'installed');
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'human instructions');
  const verified = parsed(run(['verify-setup', '--project', project], project)); assert.equal(verified.result.ok, true);
  const rollback = parsed(run(['rollback', '--project', project, '--apply'], project)); assert.equal(rollback.result.mode, 'rolled-back');
  assert.equal(existsSync(join(project, 'AGENTS.md')), true); assert.equal(existsSync(join(project, '.agents')), false); assert.equal(existsSync(join(project, '.claude')), false);
});

test('rollback refuses edited owned bytes and unsupported commands are structured', () => {
  const project = fixture(); parsed(run(['setup', '--project', project, '--apply'], project));
  writeFileSync(join(project, '.agents/skills/orchestrate-task/SKILL.md'), 'edited');
  const rollback = parsed(run(['rollback', '--project', project, '--apply'], project)); assert.equal(rollback.ok, false); assert.equal(rollback.error.code, 'SETUP_CONFLICT');
  const unsupported = parsed(run(['evidence', 'verify', '--task-id', 'x'], project)); assert.equal(unsupported.ok, false); assert.equal(unsupported.error.code, 'UNSUPPORTED_COMMAND');
});

test('setup installs byte-identical host discovery payloads and detects repeat edits', () => {
  const project = fixture(); const installed = parsed(run(['setup', '--project', project, '--apply'], project));
  for (const host of ['.agents', '.claude']) {
    for (const file of ['SKILL.md', 'LICENSE', 'NOTICE.md', 'agents/openai.yaml']) {
      assert.equal(existsSync(join(project, host, 'skills/orchestrate-task', file)), true, `${host}/${file}`);
    }
  }
  assert.equal(installed.result.files.some((file) => file.path === '.agents/skills/orchestrate-task/SKILL.md'), true);
  const edited = join(project, '.claude/skills/orchestrate-task/SKILL.md'); writeFileSync(edited, 'foreign edit');
  const repeat = parsed(run(['setup', '--project', project, '--apply'], project));
  assert.equal(repeat.ok, false); assert.equal(repeat.error.code, 'SETUP_CONFLICT');
});

test('setup installs explicit runtime and host registration wiring with reported limits', () => {
  const project = fixture(); const installed = parsed(run(['setup', '--project', project, '--apply'], project));
  assert.equal(installed.result.hostRegistration.codex.state, 'installed');
  assert.equal(installed.result.hostRegistration.claude.state, 'installed');
  assert.deepEqual(installed.result.hostRegistration.codex.hooks, ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop']);
  assert.equal(installed.result.hostRegistration.codex.wiring.statusCommand, 'task status');
  assert.equal(installed.result.hostRegistration.claude.wiring.continuation, true);
  assert.equal(installed.result.hostRegistration.codex.limits.nativeRegistration, 'project-instructions-only');
  const verified = parsed(run(['verify-setup', '--project', project], project));
  assert.equal(verified.result.ok, true);
  assert.equal(verified.result.hostRegistration.codex.state, 'installed');
  assert.equal(verified.result.hostRegistration.claude.state, 'installed');
  assert.equal(verified.result.hostRegistration.codex.actualFiles.length > 0, true);
});

test('pause revokes leases and resume acquires a higher fence', () => {
  const project = fixture(); const state = join(project, '.state');
  const start = parsed(run(['task', 'start', '--task-id', 'pause-resume', '--request', 'Fix a typo', '--state-dir', state], project));
  const before = JSON.parse(readFileSync(join(state, 'tasks/pause-resume/task.json'), 'utf8'));
  const pause = parsed(run(['task', 'pause', '--task-id', 'pause-resume', '--state-dir', state, '--data', JSON.stringify({ context: start.result.context })], project));
  assert.equal(pause.ok, true); const paused = JSON.parse(readFileSync(join(state, 'tasks/pause-resume/task.json'), 'utf8'));
  assert.equal(paused.status, 'paused'); assert.equal(paused.leases.every((lease) => lease.revokedAt !== null), true);
  const resume = parsed(run(['task', 'resume', '--task-id', 'pause-resume', '--state-dir', state, '--data', JSON.stringify({ recoverySatisfied: true, ownerHost: 'codex', ownerSession: 'resume-session' })], project));
  assert.equal(resume.ok, true); const after = JSON.parse(readFileSync(join(state, 'tasks/pause-resume/task.json'), 'utf8'));
  assert.equal(after.status, 'active'); assert.equal(after.leases.at(-1).fenceToken > before.leases.at(-1).fenceToken, true);
});

test('migration commands route to the v0.2 adapter before task-scoped dispatch', () => {
  const project = fixture();
  const missing = run([
    'migrate-v0.2',
    'dry-run',
    '--data',
    JSON.stringify({ sourceRoot: join(project, 'missing-v0.2') }),
  ], project);
  assert.equal(missing.status, 2);
  const value = parsed(missing);
  assert.equal(value.ok, false);
  assert.equal(value.error.code, 'SOURCE_MISSING');
  const help = run(['--help'], project);
  assert.match(help.stdout, /migrate-v0\.2 dry-run\|apply\|rollback/);
});

test('evidence record is a canonical candidate-bound command', () => {
  const project = fixture(); const state = join(project, '.state');
  const started = parsed(run(['task', 'start', '--task-id', 'evidence-task', '--request', 'Fix a typo', '--state-dir', state], project));
  const candidateIdentity = { taskId: 'evidence-task', specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64) };
  const receipt = {
    receiptId: 'test-receipt', type: 'test', taskId: 'evidence-task', candidateIdentity,
    producer: { kind: 'test', id: 'node' }, scenario: 'unit', coverage: 'full-candidate',
    startedAt: '2026-10-08T12:00:00.000Z', completedAt: '2026-10-08T12:00:01.000Z', verdict: 'pass',
  };
  const recorded = parsed(run(['evidence', 'record', '--task-id', 'evidence-task', '--state-dir', state, '--data', JSON.stringify({ context: started.result.context, receipt })], project));
  assert.equal(recorded.ok, true);
  assert.equal(recorded.result.receipt.receiptId, 'test-receipt');
  const task = JSON.parse(readFileSync(join(state, 'tasks/evidence-task/task.json'), 'utf8'));
  assert.equal(task.evidence.length, 1);
});
