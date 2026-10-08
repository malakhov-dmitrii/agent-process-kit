import { fileURLToPath as processKitFilePath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

for (const host of ['claude', 'codex']) {
  test(`${host} context hook distinguishes candidate from explicit binding`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-hook-')));
    const repo = join(root, 'repo'), traces = join(root, 'traces');
    mkdirSync(join(repo, '.agent', 'tasks'), { recursive: true });
    mkdirSync(join(traces, 'sessions'), { recursive: true });
    execFileSync('git', ['-C', repo, 'init', '-q']);
    const journal = join(repo, '.agent', 'tasks', 'task.md');
    writeFileSync(journal, '# Task\nTask-ID: task\n');
    writeFileSync(join(repo, '.agent', 'CURRENT'), 'task');
    const script = processKitFilePath(new URL(`../hooks/operator-transparency-${host}.sh`, import.meta.url));
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      AGENT_TASK_TRACE_ROOT: traces, AGENT_TASK_RESOLVER: processKitFilePath(new URL('./resolve-current-task.mjs', import.meta.url)) };
    const run = () => spawnSync('/bin/bash', [script], { env, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: repo }) });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /candidate journal/);
    assert.equal(existsSync(join(traces, 'sessions', 's1.json')), false);
    writeFileSync(join(traces, 'sessions', 's1.json'), JSON.stringify({ version: 2, binding_kind: 'explicit', repo, task_id: 'task', journal_path: journal }));
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /active journal/);
  });
}
