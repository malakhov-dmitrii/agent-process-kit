import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'agent-process-kit-install-'));
const expected = [
  'capability-contract',
  'capability-core-adapters',
  'codebase-design',
  'depth-lock',
  'finish-task',
  'verify-delivery',
  'writing-for-agents',
];

function fixture(name) {
  const project = join(scratch, name);
  const home = join(scratch, `${name}-home`);
  mkdirSync(project); mkdirSync(home);
  execFileSync('git', ['-C', project, 'init', '-q']);
  return {
    project,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      npm_config_cache: join(scratch, 'npm-cache'),
    },
  };
}

function skills(target, ...args) {
  return execFileSync('npx', ['-y', 'skills@1.7.1', ...args], {
    cwd: target.project,
    env: target.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
}

function inventory(dir, prefix = dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...inventory(path, prefix));
    else result.push({ path: relative(prefix, path), body: readFileSync(path, 'utf8') });
  }
  return result;
}

function assertInstalled(target, skillNames) {
  for (const name of skillNames) {
    const source = inventory(join(root, 'skills', name));
    for (const hostPath of ['.agents', '.claude']) {
      assert.deepEqual(inventory(join(target.project, hostPath, 'skills', name)), source);
    }
  }
}

function assertRemoved(target, skillNames) {
  for (const name of skillNames) {
    for (const hostPath of ['.agents', '.claude']) {
      assert.equal(existsSync(join(target.project, hostPath, 'skills', name)), false);
    }
  }
  const lock = JSON.parse(readFileSync(join(target.project, 'skills-lock.json'), 'utf8'));
  assert.deepEqual(lock.skills, {}, 'remove must clear the project lock');
}

const pack = fixture('pack-project');
const packInstall = JSON.parse(skills(pack, 'add', root, '--skill', '*', '-a', 'codex', '-a', 'claude-code', '--copy', '-y', '--json'));
assert.deepEqual(packInstall.map((item) => item.name).sort(), expected);
for (const item of packInstall) assert.deepEqual(item.agents.sort(), ['Claude Code', 'Codex']);
assertInstalled(pack, expected);

const packLock = JSON.parse(readFileSync(join(pack.project, 'skills-lock.json'), 'utf8'));
assert.deepEqual(Object.keys(packLock.skills).sort(), expected);
skills(pack, 'update', '--project', '-y');
skills(pack, 'remove', ...expected, '-a', 'codex', '-a', 'claude-code', '-y');
assertRemoved(pack, expected);

const single = fixture('single-project');
const singleInstall = JSON.parse(skills(single, 'add', root, '--skill', 'finish-task', '-a', 'codex', '-a', 'claude-code', '--copy', '-y', '--json'));
assert.deepEqual(singleInstall.map((item) => item.name), ['finish-task']);
assertInstalled(single, ['finish-task']);
skills(single, 'remove', 'finish-task', '-a', 'codex', '-a', 'claude-code', '-y');
assertRemoved(single, ['finish-task']);

console.log(`Full pack and finish-task-only install/update/remove PASS for Codex and Claude Code in ${scratch}.`);
