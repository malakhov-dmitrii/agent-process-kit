import { fileURLToPath as processKitFilePath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const CLI = processKitFilePath(new URL('./task-check.mjs', import.meta.url));
function run(body, task = 'test-task') {
  const dir = mkdtempSync(join(tmpdir(), 'task-check-'));
  const journal = join(dir, 'journal.md');
  writeFileSync(journal, body);
  const result = spawnSync(process.execPath, [CLI, '--journal', journal, '--task', task], { encoding: 'utf8' });
  return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}
const journal = (items) => `# Task\nTask-ID: test-task\n\n## Acceptance\n${items}\n\n## Follow-ups\n- [ ] unrelated work\n`;
test('pending user flow cannot be hidden by completed implementation and tests', () => {
  const result = run(journal('- [x] A1: implemented | Evidence: local regression PASS\n- [ ] A2: provider write/readback'));
  assert.equal(result.status, 2);
  assert.equal(result.value.status, 'incomplete');
  assert.deepEqual(result.value.pending, ['A2']);
});
test('checked box without evidence is not completion', () => {
  const result = run(journal('- [x] A1: feature done'));
  assert.equal(result.status, 2);
  assert.equal(result.value.status, 'invalid');
});
test('missing, empty and malformed acceptance fail closed', () => {
  for (const body of ['# Task', journal(''), journal('- [y] A1: done'), journal('Everything is finished.')]) {
    const result = run(body);
    assert.equal(result.status, 2);
    assert.equal(result.value.status, 'invalid');
  }
});
test('verified acceptance passes without closing unrelated follow-ups', () => {
  const result = run(journal('- [x] A1: behavior | Evidence: test exit 0; browser readback recorded'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.value.status, 'ready');
  assert.equal(result.value.evidenceVerified, false);
});
test('excluded criterion needs an operator decision, not an agent excuse', () => {
  assert.equal(run(journal('- [-] A1: mobile test')).status, 2);
  assert.equal(run(journal('- [-] A1: mobile test | Decision: operator excluded mobile, message 123')).status, 0);
});
test('duplicate identities, wrong task and evidence on a pending item do not pass', () => {
  assert.equal(run(journal('- [x] A1: x | Evidence: PASS\n- [x] A1: y | Evidence: PASS')).status, 2);
  assert.equal(run(journal('- [x] A1: x | Evidence: PASS'), 'other-task').status, 2);
  assert.equal(run(journal('- [ ] A1: x | Evidence: partial PASS')).status, 2);
});
test('checkbox text in a fenced example is not a completed criterion', () => {
  assert.equal(run(journal('```md\n- [x] A1: x | Evidence: PASS\n```')).status, 2);
});

test('unreadable journal is invalid and never evidence-verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-check-unreadable-'));
  const result = spawnSync(process.execPath, [CLI, '--journal', join(dir, 'missing.md'), '--task', 'test-task'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).evidenceVerified, false);
});
