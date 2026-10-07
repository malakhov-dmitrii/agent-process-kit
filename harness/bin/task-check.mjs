#!/usr/bin/env node
import { isMain } from './entrypoint.mjs';
// Structural acceptance check. Evidence semantics still require execution/review.
import { readFileSync } from 'node:fs';

export function checkAcceptance(text, taskId) {
  const errors = [];
  const pending = [];
  const verified = [];
  const excluded = [];
  const ids = new Set();
  let section = false, found = 0, fence = null;
  const taskLines = text.split(/\r?\n/).filter(line => /^Task-ID:\s*/.test(line));
  if (taskLines.length !== 1 || taskLines[0].slice(8).trim() !== taskId) errors.push('Task-ID must match the selected task exactly');
  for (const line of text.split(/\r?\n/)) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^## Acceptance\s*$/.test(line)) { section = true; found++; continue; }
    if (/^#{1,2}\s/.test(line)) section = false;
    if (!section || !line.trim()) continue;
    const item = line.match(/^- \[([ xX-])\] ([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/);
    if (!item) { errors.push('Each acceptance line must be an identified checkbox'); continue; }
    const [, state, id, body] = item;
    if (ids.has(id)) errors.push(`duplicate criterion ${id}`);
    ids.add(id);
    if (state === ' ') pending.push(id);
    else if (state === '-') {
      if (!/\| Decision:\s*\S.+/.test(body)) errors.push(`${id}: excluded without an operator decision reference`);
      else excluded.push(id);
    } else {
      if (!/\| Evidence:\s*\S.+/.test(body)) errors.push(`${id}: checked without evidence`);
      else verified.push(id);
    }
  }
  if (found !== 1 || ids.size === 0) errors.push('Exactly one non-empty ## Acceptance section is required');
  return { task_id: taskId, status: errors.length ? 'invalid' : pending.length ? 'incomplete' : 'ready',
    evidenceVerified: false, pending, verified, excluded, errors };
}

export function checkJournal(journal, taskId) {
  return checkAcceptance(readFileSync(journal, 'utf8'), taskId);
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('usage: task-check.mjs --journal <file> --task <id>');
    return 0;
  }
  let journal, task;
  try {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--journal') journal = argv[++i];
      else if (argv[i] === '--task') task = argv[++i];
      else throw new Error(`Unknown argument ${argv[i]}`);
    }
    if (!journal || !task) throw new Error('--journal and --task required');
    const result = checkJournal(journal, task);
    console.log(JSON.stringify(result));
    return result.status === 'ready' ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify({ status: 'invalid', evidenceVerified: false, errors: [error.message] }));
    return 2;
  }
}
if (isMain(import.meta.url)) process.exitCode = main();
