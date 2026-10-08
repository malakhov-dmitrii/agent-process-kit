import { createHash, randomUUID } from 'node:crypto';
import { existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, closeSync, writeFileSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT = 'agent-process-kit';
const VERSION = 1;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (value) => Buffer.from(value, 'utf8');
const safeProject = (project) => {
  const root = resolve(project || process.cwd());
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project must be an existing directory');
  return root;
};
const regular = (path) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
  return readFileSync(path);
};
const writeAtomic = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  try { const directoryFd = openSync(dirname(path), 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); } } catch { /* directory fsync is platform-specific */ }
};

const cliPath = fileURLToPath(new URL('../../bin/agent-process-kit.mjs', import.meta.url));
const skillRoot = fileURLToPath(new URL('../../skills/orchestrate-task/', import.meta.url));
const templateRoot = fileURLToPath(new URL('../templates/', import.meta.url));
const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)}`;
const payloads = () => {
  const result = {};
  for (const host of ['.agents', '.claude']) {
    for (const file of ['SKILL.md', 'LICENSE', 'NOTICE.md', 'agents/openai.yaml']) {
      result[`${host}/skills/orchestrate-task/${file}`] = readFileSync(join(skillRoot, file));
    }
  }
  result['.agent-process-kit/hosts/codex-registration.md'] = readFileSync(join(templateRoot, 'codex-registration.md'));
  result['.agent-process-kit/hosts/claude-registration.md'] = readFileSync(join(templateRoot, 'claude-registration.md'));
  result['.agent-process-kit/runtime/host-adapter.mjs'] = readFileSync(join(templateRoot, 'host-adapter.mjs'));
  return result;
};

const HOSTS = {
  codex: {
    instruction: '.agent-process-kit/hosts/codex-registration.md',
    hooks: ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop'],
    wiring: { statusCommand: 'task status', continuation: true, adapter: '.agent-process-kit/runtime/host-adapter.mjs' },
    limits: { nativeRegistration: 'project-instructions-only', globalConfigChanged: false },
  },
  claude: {
    instruction: '.agent-process-kit/hosts/claude-registration.md',
    hooks: ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop'],
    wiring: { statusCommand: 'task status', continuation: true, adapter: '.agent-process-kit/runtime/host-adapter.mjs' },
    limits: { nativeRegistration: 'project-instructions-only', globalConfigChanged: false },
  },
};

function paths(project) {
  const root = safeProject(project);
  const directory = join(root, '.agent-process-kit');
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Setup destination must not be a symlink or file');
  }
  return { root, directory, receipt: join(directory, 'setup-receipt.json'), lock: join(root, '.agent-process-kit.setup.lock') };
}
function lock(path, fn) {
  const fd = openSync(path, 'wx', 0o600);
  try { return fn(); } finally { closeSync(fd); unlinkSync(path); }
}
function receiptFor(p) {
  if (!existsSync(p.receipt)) return null;
  const receipt = JSON.parse(regular(p.receipt).toString('utf8'));
  if (receipt.product !== PRODUCT || receipt.schemaVersion !== VERSION || receipt.project !== p.root || !Array.isArray(receipt.files)) throw new Error('Invalid setup receipt');
  for (const file of receipt.files) {
    if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('..') || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid setup receipt file');
  }
  return { receipt, raw: regular(p.receipt) };
}
function expectedFiles() { return Object.entries(payloads()).map(([path, value]) => ({ path, bytes: text(value), sha256: hash(text(value)) })); }
function publicFiles(files) { return files.map(({ path, sha256 }) => ({ path, sha256 })); }
function registrationState(files, state = 'planned') {
  return Object.fromEntries(Object.entries(HOSTS).map(([host, details]) => [host, {
    state,
    hooks: details.hooks,
    wiring: details.wiring,
    limits: details.limits,
    instruction: details.instruction,
    files: files.filter((file) => file.path === details.instruction || file.path === details.wiring.adapter).map((file) => file.path),
  }]));
}

export function setupProject({ project = process.cwd(), apply = false } = {}) {
  const p = paths(project); const files = expectedFiles(); const current = existsSync(p.directory) ? receiptFor(p) : null;
  const plan = { mode: apply ? 'apply' : 'preview', project: p.root, directory: p.directory, files: publicFiles(files), hostRegistration: registrationState(files, apply ? 'planned' : 'preview') };
  if (!apply) return { ...plan, receiptPhase: current?.receipt.phase ?? 'absent' };
  return lock(p.lock, () => {
    const existing = existsSync(p.directory) ? receiptFor(p) : null;
    if (existing && existing.receipt.phase === 'installed') {
      for (const file of existing.receipt.files) {
        const target = join(p.root, file.path);
        if (!existsSync(target) || hash(regular(target)) !== file.sha256) throw Object.assign(new Error(`Owned file changed or missing; refusing setup: ${file.path}`), { code: 'SETUP_CONFLICT', details: { path: file.path } });
      }
      return { ...plan, hostRegistration: registrationState(files, 'installed'), mode: 'installed', receipt: p.receipt, receiptPhase: 'installed', resumed: false };
    }
    if (existsSync(p.directory) && !existing) throw new Error('Setup directory exists without an owned receipt; refusing overwrite');
    mkdirSync(p.directory, { recursive: true, mode: 0o700 });
    const receipt = { schemaVersion: VERSION, product: PRODUCT, project: p.root, phase: 'prepared', files: publicFiles(files), preparedAt: new Date().toISOString(), hostRegistration: registrationState(files, 'prepared') };
    writeAtomic(p.receipt, text(`${JSON.stringify(receipt, null, 2)}\n`));
    for (const file of files) {
      const target = join(p.root, file.path);
      if (existsSync(target)) {
        if (hash(regular(target)) !== file.sha256) throw new Error(`Owned file changed or foreign content exists: ${file.path}`);
      } else writeAtomic(target, file.bytes);
    }
    receipt.phase = 'installed'; receipt.installedAt = new Date().toISOString(); receipt.hostRegistration = registrationState(files, 'installed'); writeAtomic(p.receipt, text(`${JSON.stringify(receipt, null, 2)}\n`));
    return { ...plan, hostRegistration: receipt.hostRegistration, mode: 'installed', receipt: p.receipt, receiptPhase: 'installed', resumed: Boolean(existing) };
  });
}
export function verifySetup({ project = process.cwd() } = {}) {
  const p = paths(project); const loaded = receiptFor(p);
  if (!loaded) return { ok: false, project: p.root, phase: 'absent', hostRegistration: registrationState([], 'not-installed') };
  const files = loaded.receipt.files.map((file) => { const path = join(p.root, file.path); return { ...file, present: existsSync(path), actualSha256: existsSync(path) ? hash(regular(path)) : null, matches: existsSync(path) && hash(regular(path)) === file.sha256 }; });
  const byPath = new Map(files.map((file) => [file.path, file]));
  const hostRegistration = Object.fromEntries(Object.entries(HOSTS).map(([host, details]) => {
    const tracked = [details.instruction, details.wiring.adapter].map((path) => byPath.get(path));
    const matches = tracked.every((file) => file?.matches === true);
    return [host, { state: matches ? 'installed' : tracked.some((file) => file?.present) ? 'drifted' : 'missing', hooks: details.hooks, wiring: details.wiring, limits: details.limits, instruction: details.instruction, actualFiles: tracked.filter(Boolean) }];
  }));
  return { ok: files.every((file) => file.matches) && Object.values(hostRegistration).every((item) => item.state === 'installed'), project: p.root, phase: loaded.receipt.phase, files, hostRegistration };
}
export function rollbackProject({ project = process.cwd(), apply = false } = {}) {
  const p = paths(project); const loaded = receiptFor(p); if (!loaded) throw new Error('No owned setup receipt found');
  const files = loaded.receipt.files;
  const conflicts = files.filter((file) => { const path = join(p.root, file.path); return existsSync(path) && hash(regular(path)) !== file.sha256; });
  const result = { mode: apply ? 'apply' : 'preview', project: p.root, receipt: p.receipt, remove: files.map((file) => file.path), conflicts, hostRegistration: loaded.receipt.hostRegistration ?? registrationState(files, 'unknown') };
  if (conflicts.length) throw Object.assign(new Error(`Owned file changed; refusing rollback: ${conflicts[0].path}`), { code: 'SETUP_CONFLICT', details: result });
  if (!apply) return result;
  return lock(p.lock, () => {
    for (const file of files) { const path = join(p.root, file.path); if (existsSync(path)) unlinkSync(path); }
    if (existsSync(p.receipt)) unlinkSync(p.receipt);
    const empty = (directory) => { if (!existsSync(directory)) return; for (const entry of readdirSync(directory, { withFileTypes: true })) { const child = join(directory, entry.name); if (entry.isDirectory() && !entry.isSymbolicLink()) empty(child); } try { if (readdirSync(directory).length === 0) rmdirSync(directory); } catch { /* user-owned residue remains */ } };
    for (const file of files) { let directory = dirname(join(p.root, file.path)); while (directory !== p.root && directory.startsWith(`${p.root}/`)) { empty(directory); directory = dirname(directory); } }
    empty(p.directory);
    return { ...result, mode: 'rolled-back', residue: existsSync(p.directory) ? 'user-files-retained' : 'none' };
  });
}
