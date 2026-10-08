import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const names = ['INSTRUCTIONS.md', 'hooks.example.json'];
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
function regular(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
  return readFileSync(path);
}
function projectPaths(project) {
  const root = realpathSync(resolve(project));
  if (!lstatSync(root).isDirectory()) throw new Error('Project must be an existing directory');
  const directory = join(root, '.agent-process-kit');
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Setup destination must not be a symlink or file');
  }
  return { root, directory, receipt: join(directory, 'receipt.json'), lock: join(root, '.agent-process-kit.lock') };
}
function withLock(file, fn) {
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return fn(); }
  finally { closeSync(fd); unlinkSync(file); }
}
function commitReceipt(file, receipt, previous) {
  if (previous && hash(regular(file)) !== hash(previous)) throw new Error('Receipt changed during setup');
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function integrationFiles() {
  const cli = fileURLToPath(new URL('../bin/agent-process-kit.mjs', import.meta.url));
  const command = `${quote(process.execPath)} ${quote(cli)}`;
  return {
    'INSTRUCTIONS.md': `# Agent Process Kit integration\n\nRead https://github.com/malakhov-dmitrii/agent-process-kit/blob/main/docs/how-it-works.md and your project rules before non-trivial work.\nMatch the current request before binding a task. A repository pointer is only a candidate.\nUse init, bind, check and handoff through agent-process-kit. Keep acceptance criteria and evidence in the journal.\nA ready checklist is not independent proof of behavior. Run the actual checks and inspect their results.\nAgree on important UX choices with a concrete screen before broad implementation.\nPreserve user scope, permissions, existing instructions and unrelated changes.\nReview affected documentation before closing a task.\nPrepare handoffs explicitly; the receiving session must accept before continuing.\n\nCLI: ${command}\n\nMerge relevant rules into existing instructions. This file is not automatically loaded by every host.\n`,
    'hooks.example.json': JSON.stringify({ schemaVersion: 1, note: 'Examples only: merge with existing host hooks and verify native registration. Never overwrite permission hooks.',
      claude: { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${command} hook --host claude --event Stop` }] }] } },
      codex: { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${command} hook --host codex --event Stop` }] }] } },
    }, null, 2) + '\n',
  };
}
export function setupProject({ project, apply = false }) {
  const paths = projectPaths(project);
  if (existsSync(paths.directory)) throw new Error('Setup directory already exists; inspect it or rollback its receipt first');
  const content = integrationFiles();
  const files = names.map(path => ({ path, sha256: hash(content[path]) }));
  if (!apply) return { mode: 'dry-run', project: paths.root, directory: paths.directory, files, hostConfigChanged: false };
  return withLock(paths.lock, () => {
    mkdirSync(paths.directory, { mode: 0o700 });
    const receipt = { schemaVersion: 1, product: 'agent-process-kit', project: paths.root, phase: 'prepared', files };
    commitReceipt(paths.receipt, receipt);
    for (const file of files) writeFileSync(join(paths.directory, file.path), content[file.path], { flag: 'wx', mode: 0o600 });
    const previous = regular(paths.receipt);
    receipt.phase = 'installed';
    commitReceipt(paths.receipt, receipt, previous);
    return { mode: 'installed', project: paths.root, receipt: paths.receipt, files, hostConfigChanged: false };
  });
}
function readReceipt(paths) {
  const raw = regular(paths.receipt);
  const receipt = JSON.parse(raw);
  if (receipt.schemaVersion !== 1 || receipt.product !== 'agent-process-kit' || receipt.project !== paths.root
    || !['prepared', 'installed'].includes(receipt.phase) || !Array.isArray(receipt.files) || receipt.files.length !== names.length) {
    throw new Error('Invalid setup receipt');
  }
  if (new Set(receipt.files.map(file => file.path)).size !== names.length) throw new Error('Duplicate receipt path');
  for (const file of receipt.files) {
    if (!names.includes(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid receipt file');
    const path = join(paths.directory, file.path);
    if (existsSync(path) && hash(regular(path)) !== file.sha256) throw new Error(`Owned file changed; refusing rollback: ${file.path}`);
  }
  return { receipt, raw };
}
export function rollbackProject({ project, apply = false }) {
  const paths = projectPaths(project);
  const checked = readReceipt(paths);
  if (!apply) return { mode: 'dry-run', project: paths.root, remove: checked.receipt.files.map(file => file.path) };
  return withLock(paths.lock, () => {
    const latest = readReceipt(paths);
    if (hash(latest.raw) !== hash(checked.raw)) throw new Error('Receipt changed during rollback');
    const removed = [];
    for (const file of latest.receipt.files) {
      const path = join(paths.directory, file.path);
      if (existsSync(path)) { unlinkSync(path); removed.push(file.path); }
    }
    unlinkSync(paths.receipt);
    try { rmdirSync(paths.directory); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
    return { mode: 'rolled-back', project: paths.root, removed, retainedUnownedFiles: existsSync(paths.directory) };
  });
}
