import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecret } from '../harness/bin/secret-prompt-guard.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
const owned = ['bin', 'lib', 'harness/bin', 'checks', 'scripts', 'tests'].flatMap(dir => walk(join(root, dir)));
for (const file of owned.filter(file => file.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
for (const file of walk(join(root, 'harness/hooks')).filter(file => file.endsWith('.sh'))) execFileSync('bash', ['-n', file], { stdio: 'pipe' });
const licenses = JSON.parse(readFileSync(join(root, 'licenses/manifest.json')));
for (const item of licenses.files) {
  const data = readFileSync(join(root, item.path));
  if (createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error(`License changed: ${item.path}`);
}
const roots = ['bin', 'lib', 'harness', 'checks', 'scripts', 'tests', 'docs', 'examples', 'skills', 'vendor', 'licenses'];
const files = [...roots.flatMap(dir => walk(join(root, dir))), ...readdirSync(root).filter(name => /\.(md|json)$/.test(name)).map(name => join(root, name))];
const forbidden = [/\/Users\/malakhov\b/, /crm\.fanempire\.app/, /netcup-fanempire/, /launchctl kickstart -k gui\/501/, /tasks\.mlh\.one/];
for (const file of files) {
  if (!statSync(file).isFile()) continue;
  const text = readFileSync(file, 'utf8');
  // This checker contains the forbidden patterns, not any forbidden values.
  if (!file.endsWith('/scripts/check.mjs') && forbidden.some(pattern => pattern.test(text))) throw new Error(`Private host reference: ${file}`);
  if (findSecret(text)) throw new Error(`Secret-shaped literal: ${file}`);
}
let links = 0;
const docs = [...walk(join(root, 'docs')), ...readdirSync(root).filter(name => name.endsWith('.md')).map(name => join(root, name))];
for (const file of docs.filter(file => file.endsWith('.md'))) {
  for (const match of readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1].split('#')[0];
    if (!href || /^(https?:|mailto:)/.test(href)) continue;
    if (!existsSync(resolve(dirname(file), href))) throw new Error(`Broken local link: ${file} -> ${href}`);
    links++;
  }
}
console.log(`Checked ${owned.filter(file => file.endsWith('.mjs')).length} JS modules, shell syntax, ${licenses.files.length} licenses, ${links} local links and ${files.length} public files.`);
