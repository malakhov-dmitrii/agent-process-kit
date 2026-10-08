import { fileURLToPath as processKitFilePath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const CLI = processKitFilePath(new URL('./stop-receipt-gate.mjs', import.meta.url));
function fixture(items, explicit = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'completion-hook-')));
  const root = join(dir, 'traces');
  mkdirSync(join(root, 'sessions'), { recursive: true });
  const journal = join(dir, 'journal.md');
  writeFileSync(journal, `Task-ID: t1\n\n## Acceptance\n${items}\n`);
  writeFileSync(join(root, 'sessions', 's1.json'), JSON.stringify({ version: explicit ? 2 : 1,
    binding_kind: explicit ? 'explicit' : undefined, task_id: 't1', repo: dir, journal_path: journal }));
  return { dir, root };
}
function gate(fx, text, rest = {}) {
  const { scopeHook, ...payloadRest } = rest;
  const command = scopeHook ? [processKitFilePath(new URL('./scope-control-hook.mjs', import.meta.url)), '--event', 'Stop'] : [CLI];
  const r = spawnSync(process.execPath, command, { encoding: 'utf8',
    env: { ...process.env, AGENT_TASK_TRACE_ROOT: fx.root },
    input: JSON.stringify({ session_id: 's1', cwd: fx.dir, last_assistant_message: text, ...payloadRest }) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
test('overall task completion blocks while the real user flow is pending', () => {
  const fx = fixture('- [x] A1: code | Evidence: tests PASS\n- [ ] A2: provider readback');
  assert.equal(gate(fx, 'LOCAL-ONLY: tests passed.\nTask complete: t1')?.decision, 'block');
});
test('Codex existing scope Stop adapter also checks task completion', () => {
  const fx = fixture('- [ ] A1: actual provider write');
  assert.equal(gate(fx, 'Task complete: t1', { scopeHook: true })?.decision, 'block');
});
test('valid acceptance allows completion but cannot close another task', () => {
  const fx = fixture('- [x] A1: real flow | Evidence: fixture readback PASS');
  assert.equal(gate(fx, 'Task complete: t1'), null);
  assert.equal(gate(fx, 'Task complete: other')?.decision, 'block');
});
test('provisional binding and absent acceptance cannot justify completion', () => {
  assert.equal(gate(fixture('', true), 'Task complete: t1')?.decision, 'block');
  assert.equal(gate(fixture('- [x] A1: x | Evidence: PASS', false), 'Task complete: t1')?.decision, 'block');
});
test('partial delivery, subagent result and block-once do not cause a stop loop', () => {
  const fx = fixture('- [ ] A1: real flow');
  assert.equal(gate(fx, 'DELIVERED: QA plan checked; actual write remains.'), null);
  assert.equal(gate(fx, 'Task complete: t1', { hook_event_name: 'SubagentStop' }), null);
  assert.equal(gate(fx, 'Task complete: t1', { stop_hook_active: true }), null);
});
