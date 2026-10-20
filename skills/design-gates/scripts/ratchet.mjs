#!/usr/bin/env node
// A literal ratchet: design rules as a test that can only get stricter.
//
//   node ratchet.mjs [--config ratchet.config.json] [--diff <base-rev>] [--write]
//
// Run it from the repository root. Rules come from the config. Each rule has a key, a
// regex, a mode and a fix hint:
//   "zero"   any hit fails. Use it for literals that feature code must never contain.
//   "count"  the number of hits may only go down. Existing debt is recorded in the baseline.
// An allow-list entry exempts one file for one key and must carry a reason. An entry that
// no longer matches anything is stale and fails, so an exemption cannot outlive its cause.
//
//   --diff <rev>  also fail on a net new hit of a counted rule in any file this change
//                 touched, even when the baseline has headroom. Removing one old literal
//                 cannot hide adding a new one.
//   --write       record the baseline. It lowers counts that went down and refuses to raise
//                 any that were already recorded. A rule seen for the first time is recorded
//                 as it stands.
//
// Exit codes: 0 clean, 1 violations, 2 usage or config error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

const configPath = option('--config') ?? 'ratchet.config.json';
if (!existsSync(configPath)) fail(`ratchet: config not found: ${configPath}`);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const roots = config.roots ?? ['src'];
const extensions = config.extensions ?? ['.ts', '.tsx', '.css'];
const exclude = config.exclude ?? [];
const baselinePath = config.baseline ?? 'ratchet-baseline.json';
const allow = config.allow ?? [];
const allowRaise = args.includes('--allow-raise');

if (allow.some((entry) => !entry.file || !entry.key || !entry.reason)) {
  fail('ratchet: every allow entry needs file, key and reason');
}
const rules = (config.rules ?? []).map((rule) => {
  if (!rule.key || !rule.pattern || !['zero', 'count'].includes(rule.mode)) {
    fail(`ratchet: a rule needs key, pattern and mode zero|count: ${JSON.stringify(rule)}`);
  }
  return { ...rule, regex: new RegExp(rule.pattern, `g${rule.flags ?? ''}`) };
});

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') out.push(...listFiles(path));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      out.push(path.split(sep).join('/'));
    }
  }
  return out;
}

function scan(text, file) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const rule of rules) {
      const found = [...line.matchAll(rule.regex)].length;
      for (let n = 0; n < found; n += 1) hits.push({ key: rule.key, file, line: index + 1 });
    }
  });
  return hits;
}

for (const root of roots) {
  if (!existsSync(root)) fail(`ratchet: root not found: ${root}`);
}

const inScope = (file) =>
  roots.some((root) => {
    const prefix = root.replace(/^\.\//, '').replace(/\/+$/, '');
    return file === prefix || file.startsWith(`${prefix}/`);
  }) &&
  extensions.some((extension) => file.endsWith(extension)) &&
  !exclude.some((part) => file.includes(part));

const files = roots
  .flatMap(listFiles)
  .filter((file) => !exclude.some((part) => file.includes(part)));
if (files.length === 0) fail(`ratchet: no ${extensions.join(', ')} files under ${roots.join(', ')}, so nothing was checked`);
const allHits = files.flatMap((file) => scan(readFileSync(file, 'utf8'), file));
const counted = allHits.filter((hit) => !allow.some((entry) => entry.file === hit.file && entry.key === hit.key));
const totals = Object.fromEntries(rules.map((rule) => [rule.key, counted.filter((hit) => hit.key === rule.key).length]));
const recorded = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
const diffBase = option('--diff');

// The baseline file is edited by hand and by --write, so it cannot vouch for itself. The copy at
// the reference revision (--diff <rev>, or HEAD) is the trusted one: a count may sit below it and
// never above it unless --allow-raise says the raise is deliberate.
function trustedBaseline() {
  const reference = diffBase ?? 'HEAD';
  const path = relative(process.cwd(), resolve(baselinePath)).split(sep).join('/');
  try {
    return JSON.parse(execFileSync('git', ['show', `${reference}:./${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}
const trusted = trustedBaseline();

// A count that is not a plain non-negative integer would turn every comparison below into a pass.
for (const [label, source] of [['baseline', recorded], ['committed baseline', trusted ?? {}]]) {
  for (const rule of rules.filter((item) => item.mode === 'count')) {
    const value = source[rule.key];
    if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
      fail(`ratchet: the ${label} count for ${rule.key} must be a non-negative integer, found ${JSON.stringify(value)}`);
    }
  }
}

function resolveBaseline(file) {
  const baseline = {};
  const raised = [];
  for (const rule of rules.filter((item) => item.mode === 'count')) {
    const mine = file[rule.key];
    const theirs = trusted?.[rule.key];
    if (theirs === undefined) baseline[rule.key] = mine;
    else if (mine === undefined) baseline[rule.key] = theirs;
    else if (mine > theirs) {
      raised.push({ key: rule.key, from: theirs, to: mine });
      baseline[rule.key] = allowRaise ? mine : theirs;
    } else baseline[rule.key] = mine;
  }
  return { baseline, raised };
}

function evaluate(file) {
  const { baseline, raised } = resolveBaseline(file);
  const violations = [];
  for (const entry of allow) {
    if (!allHits.some((hit) => hit.file === entry.file && hit.key === entry.key)) {
      violations.push(`[${entry.key}] stale allow entry for ${entry.file} (${entry.reason}). Delete it.`);
    }
  }
  for (const rule of rules) {
    const fix = rule.fix ?? '';
    const bump = allowRaise ? undefined : raised.find((item) => item.key === rule.key);
    if (rule.mode === 'zero') {
      for (const hit of counted.filter((item) => item.key === rule.key)) {
        violations.push(`[${rule.key}] ${hit.file}:${hit.line} must stay at zero. ${fix}`.trim());
      }
    } else if (bump) {
      violations.push(`[${rule.key}] baseline raised from ${bump.from} to ${bump.to} against ${diffBase ?? 'HEAD'}. Lower the count instead, or pass --allow-raise to raise it on purpose.`);
    } else if (totals[rule.key] > (baseline[rule.key] ?? 0)) {
      violations.push(`[${rule.key}] grew from ${baseline[rule.key] ?? 0} to ${totals[rule.key]}. ${fix}`.trim());
    }
  }
  if (diffBase) violations.push(...diffViolations(diffBase));
  return violations;
}

function diffViolations(base) {
  let raw;
  try {
    raw = execFileSync('git', ['diff', '--name-status', '-z', '--relative', '-M', '-C', '--diff-filter=AMRCT', base, '--'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail(`ratchet: cannot diff against ${base}: ${String(error.stderr ?? error.message).trim()}`);
  }
  const fields = raw.split('\0');
  const changed = [];
  for (let index = 0; index < fields.length && fields[index]; ) {
    const status = fields[index];
    if (status.startsWith('R') || status.startsWith('C')) {
      changed.push({ status: status[0], from: fields[index + 1], file: fields[index + 2] });
      index += 3;
    } else {
      changed.push({ status: status[0], from: fields[index + 1], file: fields[index + 1] });
      index += 2;
    }
  }
  // Files that git does not track yet are new to the scan, so every hit in them is a new hit.
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\0')
    .filter(Boolean);
  for (const file of untracked) changed.push({ status: 'A', from: file, file });
  const violations = [];
  for (const { status, from, file } of changed.filter((entry) => files.includes(entry.file))) {
    // What the file held before: a copy, a type change and a file new to the scan start empty, so
    // they get no credit for hits the old file held. A rename or an edit starts from the old path's
    // content.
    let before = '';
    if (status !== 'A' && status !== 'C' && status !== 'T' && inScope(from)) {
      try {
        before = execFileSync('git', ['show', `${base}:./${from}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        before = '';
      }
    }
    const was = scan(before, file);
    for (const rule of rules.filter((item) => item.mode === 'count')) {
      const added =
        counted.filter((hit) => hit.file === file && hit.key === rule.key).length -
        was.filter((hit) => hit.key === rule.key).length;
      if (added > 0) violations.push(`[${rule.key}] ${file} adds ${added} new hit(s) against ${base}. ${rule.fix ?? ''}`.trim());
    }
  }
  return violations;
}

let current = recorded;
if (args.includes('--write')) {
  const next = { ...recorded };
  const refused = [];
  const { baseline: floor } = resolveBaseline(recorded);
  for (const rule of rules.filter((item) => item.mode === 'count')) {
    const was = floor[rule.key];
    if (!allowRaise && was !== undefined && totals[rule.key] > was) refused.push(`${rule.key}: ${was} -> ${totals[rule.key]}`);
    else next[rule.key] = totals[rule.key];
  }
  if (refused.length > 0) {
    fail(`ratchet: refusing to raise the baseline (${refused.join(', ')}). Remove the new hits, or pass --allow-raise to raise it on purpose.`, 1);
  }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`ratchet: baseline written to ${baselinePath}`);
  current = next;
}

const violations = evaluate(current);
if (violations.length > 0) {
  console.error('RATCHET FAILED');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log(`ratchet: ${files.length} files, ${rules.length} rules, clean`);
