import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skip = new Set(['.git', '.omx', 'node_modules']);

function files(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...files(path));
    else result.push(path);
  }
  return result;
}

const all = files(root);
const markdown = all.filter((path) => extname(path) === '.md');
const javascript = all.filter((path) => ['.js', '.mjs', '.cjs'].includes(extname(path)));

for (const path of javascript) execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });

const skillRoot = join(root, 'skills');
const expectedSkills = [
  'capability-contract',
  'capability-core-adapters',
  'codebase-design',
  'depth-lock',
  'orchestrate-task',
  'verify-delivery',
  'writing-for-agents',
];
const skills = readdirSync(skillRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(skillRoot, entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(skills, expectedSkills);

for (const name of skills) {
  const skill = readFileSync(join(skillRoot, name, 'SKILL.md'), 'utf8');
  assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: Use when [^\\n]+\\n`));
  assert.ok(existsSync(join(skillRoot, name, 'LICENSE')), `${name} has no distributed LICENSE`);
  assert.ok(existsSync(join(skillRoot, name, 'NOTICE.md')), `${name} has no distributed NOTICE`);
}

const orchestrateSkill = readFileSync(join(skillRoot, 'orchestrate-task', 'SKILL.md'), 'utf8');
assert.ok(orchestrateSkill.length < 8000, 'orchestrate-task must keep specialist detail behind references');
for (const reference of ['delivery-stages.md', 'evidence-receipt.md']) {
  assert.ok(existsSync(join(skillRoot, 'verify-delivery', 'references', reference)), reference);
}

let links = 0;
for (const path of markdown) {
  const body = readFileSync(path, 'utf8');
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const pathname = decodeURIComponent(target.split('#')[0]);
    if (!pathname) continue;
    const resolved = resolve(dirname(path), pathname);
    assert.ok(resolved.startsWith(root), `${relative(root, path)} links outside the repository: ${target}`);
    assert.ok(existsSync(resolved), `${relative(root, path)} has broken link: ${target}`);
    links += 1;
  }
}

for (const removed of ['optional-automation', 'starter', 'vendor']) {
  assert.equal(existsSync(join(root, removed)), false, `${removed} must stay outside the v0.3 main surface`);
}

for (const path of all) {
  assert.equal(lstatSync(path).isSymbolicLink(), false, `repository file must not be a symlink: ${relative(root, path)}`);
  const body = readFileSync(path);
  if (body.includes(0)) continue;
  const text = body.toString('utf8');
  assert.doesNotMatch(text, /\/Users\/malakhov|\.op-secrets\.json|op:\/\/agents\//, `private source in ${relative(root, path)}`);
}

const checksumFile = join(root, 'licenses', 'SHA256SUMS');
for (const line of readFileSync(checksumFile, 'utf8').trim().split('\n')) {
  const match = line.match(/^([0-9a-f]{64})  (.+)$/);
  assert.ok(match, `invalid checksum row: ${line}`);
  const target = join(root, match[2]);
  assert.ok(existsSync(target), `missing checksum target: ${match[2]}`);
  const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
  assert.equal(actual, match[1], `checksum mismatch: ${match[2]}`);
}

console.log(`Checked ${javascript.length} JS files, ${skills.length} skills, ${links} local Markdown links and license checksums.`);
