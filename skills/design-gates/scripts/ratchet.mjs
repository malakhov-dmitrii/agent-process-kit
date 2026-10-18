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
import { join, sep } from 'node:path';

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

const files = roots
  .filter(existsSync)
  .flatMap(listFiles)
  .filter((file) => !exclude.some((part) => file.includes(part)));
const allHits = files.flatMap((file) => scan(readFileSync(file, 'utf8'), file));
const counted = allHits.filter((hit) => !allow.some((entry) => entry.file === hit.file && entry.key === hit.key));
const totals = Object.fromEntries(rules.map((rule) => [rule.key, counted.filter((hit) => hit.key === rule.key).length]));
const recorded = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};

function evaluate(baseline) {
  const violations = [];
  for (const entry of allow) {
    if (!allHits.some((hit) => hit.file === entry.file && hit.key === entry.key)) {
      violations.push(`[${entry.key}] stale allow entry for ${entry.file} (${entry.reason}). Delete it.`);
    }
  }
  for (const rule of rules) {
    const fix = rule.fix ?? '';
    if (rule.mode === 'zero') {
      for (const hit of counted.filter((item) => item.key === rule.key)) {
        violations.push(`[${rule.key}] ${hit.file}:${hit.line} must stay at zero. ${fix}`.trim());
      }
    } else if (totals[rule.key] > (baseline[rule.key] ?? 0)) {
      violations.push(`[${rule.key}] grew from ${baseline[rule.key] ?? 0} to ${totals[rule.key]}. ${fix}`.trim());
    }
  }
  const base = option('--diff');
  if (base) {
    const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', base, '--'], { encoding: 'utf8' })
      .split('\n')
      .filter((file) => files.includes(file));
    for (const file of changed) {
      let before = '';
      try {
        before = execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        before = '';
      }
      const was = scan(before, file);
      for (const rule of rules.filter((item) => item.mode === 'count')) {
        const added =
          counted.filter((hit) => hit.file === file && hit.key === rule.key).length -
          was.filter((hit) => hit.key === rule.key).length;
        if (added > 0) violations.push(`[${rule.key}] ${file} adds ${added} new hit(s) against ${base}. ${rule.fix ?? ''}`.trim());
      }
    }
  }
  return violations;
}

let baseline = recorded;
if (args.includes('--write')) {
  const next = { ...recorded };
  const raised = [];
  for (const rule of rules.filter((item) => item.mode === 'count')) {
    const was = recorded[rule.key];
    if (was !== undefined && totals[rule.key] > was) raised.push(`${rule.key}: ${was} -> ${totals[rule.key]}`);
    else next[rule.key] = totals[rule.key];
  }
  if (raised.length > 0) fail(`ratchet: refusing to raise the baseline (${raised.join(', ')}). Remove the new hits.`, 1);
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`ratchet: baseline written to ${baselinePath}`);
  baseline = next;
}

const violations = evaluate(baseline);
if (violations.length > 0) {
  console.error('RATCHET FAILED');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log(`ratchet: ${files.length} files, ${rules.length} rules, clean`);
