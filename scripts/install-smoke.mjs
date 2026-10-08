import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'finish-task-install-'));
const project = join(scratch, 'project');
const home = join(scratch, 'home');
mkdirSync(project); mkdirSync(home);
execFileSync('git', ['-C', project, 'init', '-q']);

const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: join(home, '.codex'),
  npm_config_cache: join(scratch, 'npm-cache'),
};

function skills(...args) {
  return execFileSync('npx', ['-y', 'skills@1.7.1', ...args], {
    cwd: project,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
}

const installed = JSON.parse(skills('add', root, '--skill', 'finish-task', '-a', 'codex', '-a', 'claude-code', '--copy', '-y', '--json'));
assert.equal(installed.length, 1);
assert.equal(installed[0].name, 'finish-task');
assert.deepEqual(installed[0].agents.sort(), ['Claude Code', 'Codex']);

function inventory(dir, prefix = dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...inventory(path, prefix));
    else result.push({ path: relative(prefix, path), body: readFileSync(path, 'utf8') });
  }
  return result;
}

const source = inventory(join(root, 'skills', 'finish-task'));
for (const target of [
  join(project, '.agents', 'skills', 'finish-task'),
  join(project, '.claude', 'skills', 'finish-task'),
]) {
  assert.deepEqual(inventory(target), source);
}

const lock = JSON.parse(readFileSync(join(project, 'skills-lock.json'), 'utf8'));
assert.match(JSON.stringify(lock), /finish-task/);

skills('update', 'finish-task', '--project', '-y');
skills('remove', 'finish-task', '-a', 'codex', '-a', 'claude-code', '-y');

const removedLock = JSON.parse(readFileSync(join(project, 'skills-lock.json'), 'utf8'));
assert.deepEqual(removedLock.skills, {}, 'remove must clear the project lock entry');

for (const target of [
  join(project, '.agents', 'skills', 'finish-task'),
  join(project, '.claude', 'skills', 'finish-task'),
]) {
  assert.throws(() => readdirSync(target));
}

console.log(`Clean install/update/remove PASS for Codex and Claude Code in ${scratch}.`);
