import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const setup = "npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code && npx @malakhov-dmitrii/agent-process-kit setup --apply";

test('English and Russian onboarding expose the same install and removal commands', () => {
  const english = read('README.md');
  const russian = read('README.ru.md');
  for (const body of [english, russian, read('docs/compatibility.md')]) {
    assert.ok(body.includes(setup));
    assert.match(body, /npx skills update --project -y/);
    assert.match(body, /orchestrate-task/);
    assert.doesNotMatch(body, /There is no framework|нет runtime|no runtime dependency/i);
  }
  const remove = 'npx skills remove capability-contract capability-core-adapters codebase-design depth-lock orchestrate-task verify-delivery writing-for-agents -a codex -a claude-code -y';
  assert.ok(english.includes(remove));
  assert.ok(russian.includes(remove));
});

test('public onboarding names the durable task and proof chain', () => {
  const body = `${read('README.md')}\n${read('README.ru.md')}\n${read('docs/how-it-works.md')}`;
  for (const phrase of ['durable task', 'conditional clarification', 'ATDD', 'TDD', 'local UAT', 'production', 'push', 'deploy']) {
    assert.match(body, new RegExp(phrase, 'i'), phrase);
  }
  assert.match(body, /дай статус/iu);
  assert.match(body, /кати/iu);
  assert.match(body, /продолжай/iu);
  assert.match(body, /pause/iu);
  assert.match(body, /stop/iu);
});
