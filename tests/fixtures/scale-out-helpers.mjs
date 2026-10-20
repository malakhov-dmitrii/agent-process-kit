import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const skill = (...parts) => join(root, 'skills', ...parts);
export const read = (path) => readFileSync(path, 'utf8');
export const scratch = () => mkdtempSync(join(tmpdir(), 'apk-scale-out-'));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Start a process and keep its output readable while it runs, so a test can wait for a
// message instead of sleeping for a guessed time. Output goes to files and `done` resolves on
// exit, so a surviving descendant that still holds the stream cannot hide a failure behind a hang.
export function start(command, args, options = {}) {
  const logs = mkdtempSync(join(tmpdir(), 'apk-run-'));
  const out = openSync(join(logs, 'stdout'), 'w');
  const err = openSync(join(logs, 'stderr'), 'w');
  const child = spawn(command, args, { ...options, stdio: ['ignore', out, err] });
  closeSync(out);
  closeSync(err);
  const output = () => ({ stdout: read(join(logs, 'stdout')), stderr: read(join(logs, 'stderr')) });
  const done = new Promise((resolve) => {
    child.on('exit', (status, signal) => resolve({ status, signal, ...output() }));
  });
  return { child, done, output };
}

export const run = (command, args, options) => start(command, args, options).done;

// Poll until the predicate holds. A handshake needs a limit, and the limit is a test failure.
export async function until(predicate, label, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

export function gitRepo() {
  const dir = scratch();
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}
