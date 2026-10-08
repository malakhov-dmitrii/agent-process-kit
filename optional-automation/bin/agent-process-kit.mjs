#!/usr/bin/env node
import { isMain } from '../harness/bin/entrypoint.mjs';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupProject, rollbackProject } from '../lib/project-setup.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const help = `agent-process-kit — explicit task context and recorded-checklist gates

Usage: agent-process-kit <command> [options]

  init       --task ID [--project DIR] [--goal TEXT]
  bind       --task ID --journal FILE --repo DIR [--session ID] [--host HOST] [--accept-handoff ID]
  status     [DIR]
  check      --task ID --journal FILE
  handoff    --to HOST --next TEXT [-C DIR] [--dry-run]
  setup      [--project DIR] [--apply]
  rollback   [--project DIR] [--apply]
  hook       --host claude|codex --event EVENT
  review     --kind plan|code --target FILE|REF --task ID --model MODEL [-C DIR]

Global: --state-dir DIR, --help, --version
Setup/rollback preview by default; host configs and permissions are never changed.
"ready" means the recorded checklist is filled, not independently verified behavior.
`;
function options(args, allowed) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--apply' && allowed.includes(key)) { values.apply = true; continue; }
    if (!allowed.includes(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid option: ${key}`);
    values[key.slice(2)] = args[++index];
  }
  return values;
}
function initialize(args) {
  const opts = options(args, ['--project', '--task', '--goal']);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(opts.task || '')) throw new Error('--task must be a safe ID of at most 128 characters');
  const project = realpathSync(resolve(opts.project || process.cwd()));
  let directory = project;
  for (const part of ['.agent', 'tasks']) {
    directory = join(directory, part);
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe task directory: ${directory}`);
  }
  const journal = join(directory, `${opts.task}.md`);
  const template = `# ${opts.task}\nTask-ID: ${opts.task}\n\n## Goal\n${opts.goal || 'Describe the user-visible outcome and delivery boundary.'}\n\n## Scope\nIn scope:\nNon-goals:\nOwner:\nReview cap: two plan rounds and two code rounds.\n\n## Acceptance\n- [ ] A1: Verify the requested user-visible behavior\n- [ ] A2: Run relevant checks on the final changed state\n- [ ] A3: Check affected documentation\n\n## Progress\nNext step: agree on concrete acceptance criteria before implementation.\n\n## Follow-ups\n`;
  writeFileSync(journal, template, { flag: 'wx', mode: 0o600 });
  return { task_id: opts.task, journal_path: journal, repo: project, checklist_status: 'incomplete' };
}
export function main(argv = process.argv.slice(2)) {
  try {
    const args = [...argv];
    const env = { ...process.env };
    const state = args.indexOf('--state-dir');
    if (state >= 0) {
      if (!args[state + 1] || args[state + 1].startsWith('--')) throw new Error('--state-dir requires a path');
      env.AGENT_PROCESS_STATE_DIR = resolve(args[state + 1]); args.splice(state, 2);
      delete env.AGENT_TASK_TRACE_ROOT;
    }
    const command = args.shift();
    if (!command || command === '--help' || args.includes('--help')) { process.stdout.write(help); return 0; }
    if (command === '--version') { console.log(JSON.parse(readFileSync(join(root, 'package.json'))).version); return 0; }
    if (command === 'init') { console.log(JSON.stringify(initialize(args))); return 0; }
    if (command === 'setup' || command === 'rollback') {
      const opts = options(args, ['--project', '--apply']);
      const run = command === 'setup' ? setupProject : rollbackProject;
      console.log(JSON.stringify(run({ project: opts.project || process.cwd(), apply: opts.apply }))); return 0;
    }
    const scripts = { bind: 'task-bind.mjs', status: 'resolve-current-task.mjs', check: 'task-check.mjs', handoff: 'handoff.mjs', review: 'review.mjs' };
    let executable = process.execPath, path, forwarded = args, input;
    if (command === 'hook') {
      const opts = options(args, ['--host', '--event']);
      if (!['claude', 'codex'].includes(opts.host)) throw new Error('--host must be claude or codex');
      const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('Hook payload must be an object');
      const event = payload.hook_event_name || payload.hookEventName || payload.event_name || payload.eventName;
      if (event && event !== opts.event) throw new Error('Hook event disagrees with payload');
      input = JSON.stringify({ ...payload, hook_event_name: opts.event });
      if (opts.event === 'Stop' || (opts.event === 'SubagentStop' && opts.host === 'claude')) {
        path = join(root, 'harness/bin', opts.host === 'claude' ? 'stop-receipt-gate.mjs' : 'scope-control-hook.mjs');
        forwarded = opts.host === 'claude' ? [] : ['--event', 'Stop'];
      } else if (['SessionStart', 'UserPromptSubmit', 'PreCompact'].includes(opts.event)) {
        executable = 'bash'; path = join(root, 'harness/hooks', `operator-transparency-${opts.host}.sh`); forwarded = [];
      } else throw new Error('Unsupported hook event');
    } else {
      if (!scripts[command]) throw new Error(`Unknown command: ${command}`);
      path = join(root, 'harness/bin', scripts[command]);
    }
    const result = spawnSync(executable, [path, ...forwarded], { env, input,
      stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'] });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) { console.error(`agent-process-kit: ${error.message}`); return 2; }
}
if (isMain(import.meta.url)) process.exitCode = main();
