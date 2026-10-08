import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const install = 'npx skills add malakhov-dmitrii/agent-process-kit --skill finish-task';
const remove = 'npx skills remove finish-task -a codex -a claude-code -y';

test('the public catalog has one promoted skill', () => {
  const skillNames = readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'skills', entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillNames, ['finish-task']);

  const skill = read('skills/finish-task/SKILL.md');
  assert.match(skill, /^---\nname: finish-task\ndescription: Use when /);
  assert.match(skill, /Finish Card/);
  assert.match(skill, /Review the final diff/);
  assert.match(skill, /LOCAL-ONLY/);
  assert.match(skill, /PRODUCTION-VERIFIED/);

  for (const reference of [
    'finish-card.md',
    'evidence-receipt.md',
    'delivery-stages.md',
    'first-error-recovery.md',
    'architecture-decisions.md',
  ]) {
    assert.ok(existsSync(join(root, 'skills', 'finish-task', 'references', reference)), reference);
    assert.match(skill, new RegExp(`references/${reference.replace('.', '\\.')}`));
  }

  for (const distributedNotice of [
    'LICENSE',
    'NOTICE.md',
    'licenses/matt-pocock-skills.txt',
    'licenses/capability-core-adapters.txt',
    'licenses/depth-lock.txt',
  ]) {
    assert.ok(existsSync(join(root, 'skills', 'finish-task', distributedNotice)), distributedNotice);
  }
});

test('the landing page reaches first value before internals', () => {
  const english = read('README.md');
  const russian = read('README.ru.md');

  assert.match(english, /Give your coding agent a finish line\./);
  assert.match(english, /Use `finish-task` on this:/);
  assert.match(russian, /Дайте кодинг-агенту финишную черту\./);

  for (const body of [english, russian]) {
    assert.ok(body.includes(install));
    assert.ok(body.includes(remove));
    assert.ok(body.indexOf(install) < body.indexOf('## How it works') || body.indexOf(install) < body.indexOf('## Как это работает'));
  }

  assert.doesNotMatch(english, /Copy .*starter\/AGENTS\.md/);
});

test('v0.3 removes the runtime from main and preserves a migration path', () => {
  assert.equal(existsSync(join(root, 'optional-automation')), false);
  const migration = read('docs/migration-v0.2.md');
  assert.match(migration, /releases\/tag\/v0\.2\.0/);
  assert.match(migration, /finish-task/);
});

test('the finish card records acceptance, evidence and delivery separately', () => {
  const template = read('skills/finish-task/references/finish-card.md');
  for (const heading of ['## Goal', '## Scope lock', '## Acceptance', '## Evidence', '## Delivery']) {
    assert.match(template, new RegExp(`^${heading}$`, 'm'));
  }
  assert.match(template, /Delivery boundary/);
  assert.match(template, /Review:/);
  assert.match(template, /Remaining work/);
  assert.match(template, /Next owner/);
});
