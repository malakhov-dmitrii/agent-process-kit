import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const install = "npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code && npx @malakhov-dmitrii/agent-process-kit setup --apply";
const pack = ['capability-contract', 'capability-core-adapters', 'codebase-design', 'depth-lock', 'orchestrate-task', 'verify-delivery', 'writing-for-agents'];
const packInstall = "npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code";
const packRemove = `npx skills remove ${pack.join(' ')} -a codex -a claude-code -y`;
const singleUpdate = 'npx skills update orchestrate-task --project -y';

test('the public catalog has one front door and a coherent skill pack', () => {
  const skillNames = readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'skills', entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillNames, pack);

  const skill = read('skills/orchestrate-task/SKILL.md');
  assert.match(skill, /^---\nname: orchestrate-task\ndescription: Use when /);
  assert.match(skill, /natural-language request/i);
  assert.match(skill, /durable task control plane/i);
  assert.match(skill, /local UAT/i);
  assert.match(skill, /production proof/i);

  for (const skillName of pack) {
    for (const distributedNotice of ['LICENSE', 'NOTICE.md']) {
      assert.ok(existsSync(join(root, 'skills', skillName, distributedNotice)), `${skillName}/${distributedNotice}`);
    }
  }

  const capabilityCore = read('skills/capability-core-adapters/SKILL.md');
  assert.doesNotMatch(capabilityCore, /docs\/agent-(?:operating-model|workflows|tooling)\.md/);
});

test('the landing page reaches first value before internals', () => {
  const english = read('README.md');
  const russian = read('README.ru.md');

  assert.match(english, /Give your coding agent a durable finish line\./);
  assert.match(english, /Fix duplicate rows in CSV export/);
  assert.match(russian, /Дайте кодинг-агенту проверяемую финишную черту\./);

  for (const body of [english, russian]) {
    assert.ok(body.includes(install));
    assert.ok(body.includes(packInstall));
    assert.ok(body.includes(packRemove));
    assert.ok(body.includes(singleUpdate));
    const workflowHeading = Math.max(body.indexOf('## Try it on real work'), body.indexOf('## Попробуйте на реальной задаче'));
    assert.ok(workflowHeading > 0);
    assert.ok(body.indexOf(install) < workflowHeading);
  }

  assert.doesNotMatch(english, /Copy .*starter\/AGENTS\.md/);
});

test('v0.4 public source includes the runtime and preserves the v0.3 migration path', () => {
  assert.equal(existsSync(join(root, 'optional-automation')), false);
  assert.equal(existsSync(join(root, 'bin', 'agent-process-kit.mjs')), true);
  assert.equal(existsSync(join(root, 'runtime', 'setup', 'project-setup.mjs')), true);
  const migration = read('docs/migration-v0.2.md');
  assert.match(migration, /v0\.2 runtime/);
  assert.match(migration, /v0\.4/);
});
