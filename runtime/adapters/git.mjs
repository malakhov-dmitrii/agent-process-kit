import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class GitIdentityError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'GitIdentityError';
    this.code = 'IDENTITY_UNAVAILABLE';
  }
}

function git(repoPath, args) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new GitIdentityError(`Git worktree identity is unavailable: ${args.join(' ')}`, error);
  }
}

function optionalGit(repoPath, args) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function nulLines(bytes) {
  return bytes.toString('utf8').split('\0').filter(Boolean);
}

function normalisePath(repoPath, path) {
  if (path.includes('\0') || path.startsWith('/') || path.split('/').includes('..')) {
    throw new GitIdentityError(`Git returned an unsafe path: ${path}`);
  }
  const absolute = resolve(repoPath, path);
  const back = relative(resolve(repoPath), absolute);
  if (back === '' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new GitIdentityError(`Git returned a path outside the worktree: ${path}`);
  }
  return path;
}

function fileEntry(repoPath, path) {
  const absolute = resolve(repoPath, path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return { path, sha256: null, size: 0, state: 'deleted' };
    throw new GitIdentityError(`Cannot read worktree path: ${path}`, error);
  }
  if (!stat.isFile()) throw new GitIdentityError(`Worktree path is not a regular file: ${path}`);
  let bytes;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    throw new GitIdentityError(`Cannot read worktree path: ${path}`, error);
  }
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  };
}

export function inspectGitWorktree(repoPath, { pathOrder = 'normal' } = {}) {
  const root = resolve(repoPath);
  const worktreeRoot = git(root, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const currentPaths = nulLines(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--no-empty-directory']));
  const headTree = optionalGit(worktreeRoot, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
  const headPaths = headTree === null ? [] : nulLines(headTree);
  const paths = [...new Set([...currentPaths, ...headPaths])]
    .map((path) => normalisePath(worktreeRoot, path))
    .sort();
  const contentManifest = paths.map((path) => fileEntry(worktreeRoot, path));
  const material = JSON.stringify(contentManifest.map(({ path, sha256, size, state }) => ({ path, sha256, size, ...(state ? { state } : {}) })));
  const contentFingerprint = createHash('sha256').update(material).digest('hex');
  const head = optionalGit(worktreeRoot, ['rev-parse', '--verify', 'HEAD']);
  const commitSha = head === null ? undefined : head.toString('utf8').trim();
  if (pathOrder === 'reverse') contentManifest.reverse();
  return { repoPath: worktreeRoot, commitSha, contentFingerprint, contentManifest };
}
