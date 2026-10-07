import { fileURLToPath as processKitFilePath } from 'node:url';
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resumeCommand } from "./handoff.mjs";

const HANDOFF = processKitFilePath(new URL("./handoff.mjs", import.meta.url));

// A repo with a journal and a fake resolver that points at it.
function fixture(current) {
  const repo = mkdtempSync(join(tmpdir(), "handoff-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  mkdirSync(join(repo, ".agent", "tasks"), { recursive: true });
  const journal = join(repo, ".agent", "tasks", "t1.md");
  writeFileSync(journal, "# t1\n\nearlier text\n");
  writeFileSync(join(repo, ".agent", "CURRENT"), current);
  const resolver = join(repo, "fake-resolver.mjs");
  writeFileSync(resolver, `console.log(JSON.stringify(${JSON.stringify({ status: "ok", task_id: "t1", journal_path: journal })}))`);
  return { repo, journal, resolver, current: join(repo, ".agent", "CURRENT") };
}

const run = (fx, args) => spawnSync(process.execPath, [HANDOFF, ...args, "-C", fx.repo], {
  encoding: "utf8", env: { ...process.env, HANDOFF_RESOLVER: fx.resolver, RECEIPT_CHECK_LOG: join(fx.repo, "r.jsonl"), AGENT_PROCESS_STATE_DIR: join(fx.repo, '.state') },
});

test("appends a Handoff entry, keeps earlier text, prints only the resume command", () => {
  const fx = fixture(JSON.stringify({ task_id: "t1", status: "active", phase: "x" }));
  const r = run(fx, ["--to", "codex", "--next", "finish step 3"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^cd '.*' && env .* codex 'Продолжи задачу t1:/);
  assert.ok(lines[0].includes('--accept-handoff'));
  const journal = readFileSync(fx.journal, "utf8");
  assert.ok(journal.startsWith("# t1\n\nearlier text\n"));
  assert.match(journal, /## Handoff \S+Z — unknown → codex/);
  assert.match(journal, /Status: handoff \(by codex\)\nRepo: .*dirty=\d+\nReceipt: .*\nNext: finish step 3\nResume: cd /);
  assert.deepEqual(JSON.parse(readFileSync(fx.current, "utf8")), { task_id: "t1", status: "active", phase: "x" });
});

test("blocked defaults to by operator", () => {
  const fx = fixture(JSON.stringify({ task_id: "t1" }));
  assert.equal(run(fx, ["--to", "claude", "--next", "need key", "--status", "blocked"]).status, 0);
  assert.equal(JSON.parse(readFileSync(fx.current, "utf8")).status, undefined);
});

test("a plain-id CURRENT is left untouched", () => {
  const fx = fixture("t1\n");
  assert.equal(run(fx, ["--to", "grok", "--next", "go"]).status, 0);
  assert.equal(readFileSync(fx.current, "utf8"), "t1\n");
});

test("a CURRENT whose top task differs is left untouched", () => {
  const text = JSON.stringify({ task_id: "other" });
  const fx = fixture(text);
  assert.equal(run(fx, ["--to", "grok", "--next", "go"]).status, 0);
  assert.equal(readFileSync(fx.current, "utf8"), text);
});

test("--dry-run writes nothing and prints the entry and the command", () => {
  const fx = fixture(JSON.stringify({ task_id: "t1" }));
  const state = join(fx.repo, '.state');
  const before = [readFileSync(fx.journal, "utf8"), readFileSync(fx.current, "utf8")];
  const r = run(fx, ["--to", "codex", "--next", "x", "--dry-run"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /## Handoff/);
  assert.match(r.stdout.trim().split("\n").at(-1), /^cd .* && env .* codex '/);
  assert.deepEqual([readFileSync(fx.journal, "utf8"), readFileSync(fx.current, "utf8")], before);
  assert.equal(existsSync(state), false);
});

test("an unresolved task exits 2", () => {
  const fx = fixture("t1\n");
  writeFileSync(fx.resolver, 'console.log(JSON.stringify({status:"ambiguous",reason:"two tasks"}))');
  const r = run(fx, ["--to", "codex", "--next", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ambiguous: two tasks/);
});

test("usage errors exit 2", () => {
  const fx = fixture("t1\n");
  assert.equal(run(fx, ["--to", "cursor", "--next", "x"]).status, 2);
  assert.equal(run(fx, ["--to", "codex"]).status, 2);
});

test("resumeCommand escapes single quotes", () => {
  const cmd = resumeCommand({ to: "claude", repo: "/tmp/it's", taskId: "t1", journalRel: "j.md", ts: "T" });
  assert.equal(cmd.split(" && ")[0], "cd '/tmp/it'\\''s'");
});

test('generated resume command carries custom state root and distinct repo/worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-command-'));
  const repo = join(root, 'chat repo');
  const worktree = join(root, 'execution');
  const stateRoot = join(root, 'state root');
  const bin = join(root, 'bin');
  const capture = join(root, 'captured');
  for (const dir of [repo, worktree, bin]) mkdirSync(dir, { recursive: true });
  const stub = join(bin, 'codex');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s' "$1" > '${capture}'\nprintf '%s' "$AGENT_PROCESS_STATE_DIR" > '${capture}.state'\nprintf '%s' "$AGENT_TASK_TRACE_ROOT" > '${capture}.compat'\n`);
  chmodSync(stub, 0o755);
  const command = resumeCommand({ to: 'codex', repo, worktree, taskId: 't1', journalRel: 'journal.md', ts: 'T', handoffId: 'h1', stateRoot });
  const result = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const prompt = readFileSync(capture, 'utf8');
  assert.match(prompt, /--repo '.*chat repo'/);
  assert.match(prompt, /--worktree '.*execution'/);
  assert.match(prompt, /--state-dir '.*state root'/);
  assert.equal(readFileSync(`${capture}.state`, 'utf8'), stateRoot);
  assert.equal(readFileSync(`${capture}.compat`, 'utf8'), stateRoot);
});

test('snapshot includes untracked work and the explicit execution worktree', () => {
  const fx = fixture('t1\n');
  const worktree = mkdtempSync(join(tmpdir(), 'handoff-execution-'));
  execFileSync('git', ['-C', worktree, 'init', '-q']);
  writeFileSync(join(worktree, 'unfinished.txt'), 'keep this work');
  writeFileSync(fx.resolver, `console.log(JSON.stringify(${JSON.stringify({ status: 'ok', task_id: 't1', journal_path: fx.journal, worktree })}))`);
  const result = run(fx, ['--to', 'codex', '--next', 'finish']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`cd '${realpathSync(worktree)}'`));
  const body = readFileSync(fx.journal, 'utf8');
  assert.match(body, /dirty=1/);
  assert.match(body, /Handoff-ID:/);
  assert.match(body, /Prepared: recipient has not acknowledged/);
});
test('provisional task candidate is never handed off', () => {
  const fx = fixture('t1\n');
  writeFileSync(fx.resolver, `console.log(JSON.stringify(${JSON.stringify({ status: 'candidate', task_id: 't1', journal_path: fx.journal })}))`);
  const before = readFileSync(fx.journal, 'utf8');
  assert.equal(run(fx, ['--to', 'codex', '--next', 'finish']).status, 2);
  assert.equal(readFileSync(fx.journal, 'utf8'), before);
});
test('same task id in execution workspace cannot overwrite a different journal pointer', () => {
  const fx = fixture('t1\n');
  const worktree = mkdtempSync(join(tmpdir(), 'handoff-other-task-'));
  execFileSync('git', ['-C', worktree, 'init', '-q']);
  mkdirSync(join(worktree, '.agent'), { recursive: true });
  const unrelated = join(worktree, '.agent', 'other.md');
  writeFileSync(unrelated, '# Another task with same local id');
  const pointer = join(worktree, '.agent', 'CURRENT');
  const original = JSON.stringify({ task_id: 't1', journal: '.agent/other.md', status: 'active', next: 'other work' });
  writeFileSync(pointer, original);
  writeFileSync(fx.resolver, `console.log(JSON.stringify(${JSON.stringify({ status: 'ok', task_id: 't1', journal_path: fx.journal, worktree })}))`);
  assert.equal(run(fx, ['--to', 'codex', '--next', 'our work']).status, 0);
  assert.equal(readFileSync(pointer, 'utf8'), original);
});
