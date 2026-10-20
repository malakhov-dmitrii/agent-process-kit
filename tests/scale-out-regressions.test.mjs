import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { alive, git, gitRepo, read, root, run, scratch, skill, start, until } from './fixtures/scale-out-helpers.mjs';

// Regressions for the review findings on the many-agent scripts. Each test names the failure it
// pins, and each was red against the script as first shipped.

const heavySlot = skill('run-agent-trains', 'scripts', 'heavy-slot.sh');
const slotEnv = (dir, extra = {}) => ({
  ...process.env,
  SLOT_DIR: join(dir, 'slots'),
  SLOTS: '2',
  RESERVED: '1',
  POLL: '0.05',
  GRACE: '2',
  ...extra,
});
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
// A finished claim stays behind as a `released` marker, so "freed" means no claim without one.
const heldClaims = (dir) => (existsSync(join(dir, 'slots')) ? readdirSync(join(dir, 'slots')).filter((name) => !existsSync(join(dir, 'slots', name, 'released'))) : []);
const plantClaim = (dir, name, files) => {
  const claim = join(dir, 'slots', name);
  mkdirSync(claim, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(claim, file), body);
  return claim;
};

test('heavy-slot stops the whole workload group on TERM and frees the slot only after it is gone', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'workload.sh'), `sleep 300 &\necho $! > "${dir}/descendant.pid"\ntouch "${dir}/started"\nwait\n`);
  const job = start('sh', [heavySlot, '--', 'sh', join(dir, 'workload.sh')], { env: slotEnv(dir) });
  await until(() => existsSync(join(dir, 'started')), 'the workload to start');
  const descendant = Number(read(join(dir, 'descendant.pid')).trim());
  try {
    job.child.kill('SIGTERM');
    const result = await job.done;
    assert.equal(result.status, 143, 'the wrapper reports the signal it was stopped by');
    assert.equal(alive(descendant), false, 'a descendant of the workload is gone before the wrapper exits');
    assert.deepEqual(heldClaims(dir), [], 'the slot is freed');
  } finally {
    if (alive(descendant)) process.kill(descendant, 'SIGKILL');
  }
});

test('heavy-slot escalates to KILL when the workload ignores TERM, and still frees the slot', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'workload.sh'), `trap '' TERM\necho $$ > "${dir}/workload.pid"\ntouch "${dir}/started"\nwhile :; do sleep 0.1; done\n`);
  const job = start('sh', [heavySlot, '--', 'sh', join(dir, 'workload.sh')], { env: slotEnv(dir, { GRACE: '1' }) });
  await until(() => existsSync(join(dir, 'started')), 'the workload to start');
  const workload = Number(read(join(dir, 'workload.pid')).trim());
  try {
    job.child.kill('SIGTERM');
    const result = await Promise.race([job.done, new Promise((resolve) => setTimeout(() => resolve(null), 15000))]);
    assert.notEqual(result, null, 'the wrapper must not wait forever on a workload that ignores TERM');
    assert.equal(result.status, 143);
    assert.equal(alive(workload), false);
    assert.deepEqual(heldClaims(dir), []);
  } finally {
    if (alive(workload)) process.kill(workload, 'SIGKILL');
  }
});

test('heavy-slot stops descendants that outlive a workload which exits on its own', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'workload.sh'), `sleep 300 &\necho $! > "${dir}/descendant.pid"\nexit 3\n`);
  const result = await run('sh', [heavySlot, '--', 'sh', join(dir, 'workload.sh')], { env: slotEnv(dir) });
  const descendant = Number(read(join(dir, 'descendant.pid')).trim());
  try {
    assert.equal(result.status, 3, 'the workload exit code still passes through');
    assert.equal(alive(descendant), false, 'a leftover background process does not outlive its slot');
    assert.deepEqual(heldClaims(dir), []);
  } finally {
    if (alive(descendant)) process.kill(descendant, 'SIGKILL');
  }
});

test('heavy-slot keeps a slot while the workload runs on after its wrapper was killed', async () => {
  const dir = scratch();
  const env = slotEnv(dir);
  const holder = start('sh', [heavySlot, '--', 'sh', '-c', `touch "${dir}/held"; while [ ! -e "${dir}/go" ]; do sleep 0.05; done`], { env });
  await until(() => existsSync(join(dir, 'held')), 'the workload to hold the slot');
  holder.child.kill('SIGKILL');
  await holder.done;
  const second = start('sh', [heavySlot, '--', 'sh', '-c', `touch "${dir}/second-ran"`], { env });
  try {
    await until(() => second.output().stderr.includes('waiting') || existsSync(join(dir, 'second-ran')), 'the second job to wait or run');
    assert.equal(existsSync(join(dir, 'second-ran')), false, 'the second job must not run while the first workload is alive');
  } finally {
    writeFileSync(join(dir, 'go'), '');
  }
  const result = await second.done;
  assert.equal(result.status, 0);
  assert.ok(existsSync(join(dir, 'second-ran')), 'it runs once the workload is gone');
});

test('heavy-slot treats a dead wrapper whose command may still be starting as a held slot until the claim is old', async () => {
  const dir = scratch();
  const claim = plantClaim(dir, 'slot-1.1', { pid: `${deadPid()}\n` });
  const second = start('sh', [heavySlot, '--', 'sh', '-c', `touch "${dir}/second-ran"`], { env: slotEnv(dir) });
  await until(() => second.output().stderr.includes('waiting') || existsSync(join(dir, 'second-ran')), 'the second job to wait or run');
  assert.equal(existsSync(join(dir, 'second-ran')), false, 'its command may be running with no group on record yet');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(claim, old, old);
  assert.equal((await second.done).status, 0, 'once the claim is old the command cannot be starting any more');
  assert.ok(existsSync(join(dir, 'second-ran')));
});

test('heavy-slot documented limit: a claim with no owner on record is held for a minute and then taken over', async () => {
  const dir = scratch();
  const claim = plantClaim(dir, 'slot-1.1', {});
  const second = start('sh', [heavySlot, '--', 'sh', '-c', `touch "${dir}/second-ran"`], { env: slotEnv(dir) });
  await until(() => second.output().stderr.includes('waiting') || existsSync(join(dir, 'second-ran')), 'the second job to wait or run');
  assert.equal(existsSync(join(dir, 'second-ran')), false, 'a fresh claim that has not recorded its owner yet keeps the slot');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(claim, old, old);
  assert.equal((await second.done).status, 0, 'an old one is taken over, which is the pause the header of the script lists');
});

test('heavy-slot keeps a slot whose wrapper is gone while the group on record is alive', async () => {
  const dir = scratch();
  const orphan = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  plantClaim(dir, 'slot-1.1', { pid: `${deadPid()}\n`, pgid: `${orphan.pid}\n` });
  const second = start('sh', [heavySlot, '--', 'sh', '-c', `touch "${dir}/second-ran"`], { env: slotEnv(dir) });
  try {
    await until(() => second.output().stderr.includes('waiting') || existsSync(join(dir, 'second-ran')), 'the second job to wait or run');
    assert.equal(existsSync(join(dir, 'second-ran')), false, 'the recorded group is still running');
  } finally {
    process.kill(-orphan.pid, 'SIGKILL');
  }
  assert.equal((await second.done).status, 0, 'it runs once the group is gone');
});

test('heavy-slot never touches a claim of another job when its own command ends', async () => {
  const dir = scratch();
  const slots = join(dir, 'slots');
  // While running, the command removes its own claim and a successor takes the number after it.
  writeFileSync(join(dir, 'workload.sh'), `rm -rf "${slots}/slot-1.1"\nmkdir "${slots}/slot-1.2"\necho ${process.pid} > "${slots}/slot-1.2/pid"\n`);
  const result = await run('sh', [heavySlot, '--', 'sh', join(dir, 'workload.sh')], { env: slotEnv(dir) });
  assert.equal(result.status, 0);
  assert.equal(read(join(slots, 'slot-1.2', 'pid')).trim(), String(process.pid), 'the successor keeps its record');
  assert.equal(existsSync(join(slots, 'slot-1.2', 'released')), false, 'and is not marked released by the job before it');
});

test('heavy-slot never reuses a claim number, and sweeps only stale claims that are old', async () => {
  const dir = scratch();
  const slots = join(dir, 'slots');
  const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  for (const number of [1, 2, 3]) plantClaim(dir, `slot-1.${number}`, { pid: `${deadPid()}\n`, released: '' });
  for (const number of [1, 2]) utimesSync(join(slots, `slot-1.${number}`), longAgo, longAgo);
  const live = plantClaim(dir, 'slot-1.0', {});
  rmSync(live, { recursive: true });
  const result = await run('sh', [heavySlot, '--', 'true'], { env: slotEnv(dir) });
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(slots).sort(), ['slot-1.3', 'slot-1.4'], 'the new claim is 4, never a number that was used; the old released claims are gone, the young one stays');
});

test('heavy-slot does not sweep a live claim however old it is', async () => {
  const dir = scratch();
  const slots = join(dir, 'slots');
  const claim = plantClaim(dir, 'slot-1.1', { pid: `${process.pid}\n` });
  const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(claim, longAgo, longAgo);
  plantClaim(dir, 'slot-2.1', { pid: `${process.pid}\n` });
  const result = await run('sh', [heavySlot, '--', 'true'], { env: slotEnv(dir, { SLOTS: '4', RESERVED: '1' }) });
  assert.equal(result.status, 0);
  assert.ok(existsSync(join(slots, 'slot-1.1')) && existsSync(join(slots, 'slot-2.1')), 'live claims stay');
  assert.equal(existsSync(join(slots, 'slot-1.1', 'released')), false);
});

test('heavy-slot claiming over a dead claim never admits two jobs on one slot', async () => {
  for (let round = 0; round < 5; round += 1) {
    const dir = scratch();
    const runDir = join(dir, 'running');
    mkdirSync(runDir);
    plantClaim(dir, 'slot-1.1', { pid: `${deadPid()}\n`, released: '' });
    writeFileSync(join(dir, 'job.sh'), `mkdir "${runDir}/$$"\nls "${runDir}" | wc -l >> "${dir}/peak"\nsleep 0.1\nrmdir "${runDir}/$$"\n`);
    const env = slotEnv(dir, { POLL: '0.02' });
    const results = await Promise.all(Array.from({ length: 6 }, () => run('sh', [heavySlot, '--', 'sh', join(dir, 'job.sh')], { env })));
    assert.deepEqual(new Set(results.map((result) => result.status)), new Set([0]));
    const peaks = read(join(dir, 'peak')).trim().split('\n').map(Number);
    assert.equal(peaks.length, 6, `round ${round}: every job ran`);
    assert.equal(Math.max(...peaks), 1, `round ${round}: one builder slot means one job at a time`);
    assert.deepEqual(heldClaims(dir), [], `round ${round}: every claim was released`);
    assert.equal(readdirSync(join(dir, 'slots')).length, 7, `round ${round}: the planted claim and six new ones, none reused`);
  }
});

test('heavy-slot does not run a command whose group it cannot record', async () => {
  const dir = scratch();
  // A stand-in sh removes the claim just before the command's own shell starts, as a manual
  // cleanup would, so the command cannot publish its group into it.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'sh'), `#!/bin/sh\nrm -rf "${join(dir, 'slots', 'slot-1.1')}"\nexec /bin/sh "$@"\n`, { mode: 0o755 });
  const env = slotEnv(dir, { PATH: `${join(dir, 'bin')}:${process.env.PATH}` });
  const result = await run('/bin/sh', [heavySlot, '--', '/bin/sh', '-c', `touch "${dir}/ran"`], { env });
  assert.equal(result.status, 70);
  assert.match(result.stderr, /cannot record the command group/);
  assert.equal(existsSync(join(dir, 'ran')), false, 'the command is not run when its group could not be recorded');
});

test('heavy-slot runs a command that is not there as a failure, not as success', async () => {
  const dir = scratch();
  const result = await run('sh', [heavySlot, '--', 'no-such-command-for-heavy-slot'], { env: slotEnv(dir) });
  assert.equal(result.status, 127);
  assert.deepEqual(heldClaims(dir), []);
});

const receiptLib = skill('verify-delivery', 'scripts', 'gate-receipt.sh');

function receiptRepo() {
  const dir = gitRepo();
  for (const sub of ['src', 'docs', 'scripts']) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, 'src', 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'docs', 'd.md'), 'd\n');
  writeFileSync(join(dir, 'scripts', 'build.sh'), 'echo build\n');
  writeFileSync(join(dir, 'Dockerfile'), 'f\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'one');
  return dir;
}

const receipt = (dir, body, { paths = 'src scripts Dockerfile', cwd = dir } = {}) =>
  spawnSync('sh', ['-c', `RECEIPT_PATHS="${paths}"; . "${receiptLib}"; ${body}`], { cwd, encoding: 'utf8' });

test('a receipt key changes with a file mode, so a chmod commit cannot reuse the old receipt', () => {
  const dir = receiptRepo();
  const paths = 'src scripts/build.sh Dockerfile';
  const key = receipt(dir, 'receipt_key HEAD', { paths }).stdout.trim();
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`, { paths }).status, 0);
  git(dir, 'update-index', '--chmod=+x', 'scripts/build.sh');
  git(dir, 'commit', '-qm', 'make the build script executable');
  assert.notEqual(receipt(dir, 'receipt_key HEAD', { paths }).stdout.trim(), key, 'a mode change gives a new key');
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass', { paths }).status, 0, 'the old receipt is not reused');
});

test('receipt_key refuses an empty path list, an unknown revision and a list that matches nothing', () => {
  const dir = receiptRepo();
  for (const [body, paths, label] of [
    ['receipt_key HEAD', '', 'empty RECEIPT_PATHS'],
    ['receipt_key no-such-revision', 'src', 'invalid revision'],
    ['receipt_key HEAD', 'no-such-path', 'no listed path exists'],
    ['receipt_key HEAD', '../src', 'a path that leaves the repository'],
    ['receipt_key HEAD', 'src/.', 'a directory alias that lists its children one by one'],
    ['receipt_key HEAD', 'src//a.txt', 'a path with an empty segment'],
  ]) {
    const result = receipt(dir, body, { paths });
    assert.notEqual(result.status, 0, label);
    assert.equal(result.stdout.trim(), '', `${label}: no key is printed`);
    assert.notEqual(result.stderr.trim(), '', `${label}: the reason is printed`);
  }
  assert.notEqual(receipt(dir, 'receipt_write abc "$(git rev-parse HEAD)" gate=pass', { paths: '' }).status, 0, 'nothing is written for an empty list');
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass', { paths: '' }).status, 0, 'nothing is reused for an empty list');
  assert.notEqual(receipt(dir, 'receipt_write "" "$(git rev-parse HEAD)" gate=pass').status, 0, 'an empty key is refused');
});

test('the clean-tree check and the key are anchored at the repository root, from any directory', () => {
  const dir = receiptRepo();
  const key = receipt(dir, 'receipt_key HEAD').stdout.trim();
  assert.equal(receipt(dir, 'receipt_key HEAD', { cwd: join(dir, 'docs') }).stdout.trim(), key, 'the same key from a subdirectory');
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0);
  assert.equal(receipt(dir, 'receipt_reuse gate=pass', { cwd: join(dir, 'docs') }).status, 0, 'clean, so reuse works from docs');
  writeFileSync(join(dir, 'src', 'a.txt'), 'dirty\n');
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'dirty source blocks reuse from the root');
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass', { cwd: join(dir, 'docs') }).status, 0, 'and from docs');
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass', { cwd: join(dir, 'src') }).status, 0, 'and from the dirty directory itself');
});

test('receipt_write refuses a dirty tested tree and a key that is not the key of HEAD', () => {
  const dir = receiptRepo();
  const key = receipt(dir, 'receipt_key HEAD').stdout.trim();
  writeFileSync(join(dir, 'src', 'a.txt'), 'edited after the commit\n');
  const result = receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`);
  assert.notEqual(result.status, 0, 'a gate that ran on a dirty tree writes no receipt');
  assert.equal(receipt(dir, `receipt_read ${key}`).status, 1, 'and nothing was stored');
  git(dir, 'checkout', '--', 'src/a.txt');
  const first = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'src', 'a.txt'), 'second\n');
  git(dir, 'commit', '-qam', 'second');
  assert.notEqual(receipt(dir, `receipt_write ${key} ${first} gate=pass`).status, 0, 'the key of a commit that is not checked out is refused');
});

test('a failed rerun invalidates the earlier passing receipt for the same tree', () => {
  const dir = receiptRepo();
  const key = receipt(dir, 'receipt_key HEAD').stdout.trim();
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass design=pass`).status, 0);
  assert.equal(receipt(dir, 'receipt_reuse gate=pass design=pass').status, 0);
  assert.equal(receipt(dir, `receipt_invalidate ${key} gate=fail`).status, 0);
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass design=pass').status, 0, 'a red rerun blocks reuse');
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass').status, 0);
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass design=pass`).status, 0);
  assert.equal(receipt(dir, 'receipt_reuse gate=pass design=pass').status, 0, 'a later green run restores it');
});

test('receipt_invalidate fails loudly when it cannot store, so the documented gate stops before it runs', { skip: process.getuid?.() === 0 }, () => {
  const dir = receiptRepo();
  const key = receipt(dir, 'receipt_key HEAD').stdout.trim();
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0);
  const records = join(dir, '.git', 'gate-receipts', `${key}.d`);
  chmodSync(records, 0o500);
  try {
    const result = receipt(dir, `receipt_invalidate ${key} gate=fail`);
    assert.notEqual(result.status, 0, 'the caller can see the failure');
    assert.match(result.stderr, /could not record/);
  } finally {
    chmodSync(records, 0o700);
  }
  assert.equal(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'and the earlier pass is untouched, so the caller must not go on to run the gate');
});

// Two gate runs of one tree, as separate processes that hand over through marker files.
function overlap({ bStaysAlive }) {
  const dir = receiptRepo();
  const key = receipt(dir, 'receipt_key HEAD').stdout.trim();
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0, 'an earlier green run');
  const marks = scratch(); // outside the repository, whose cleanliness is checked as a whole
  const mark = (name) => join(marks, name);
  const wait = (name) => `while [ ! -e "${mark(name)}" ]; do sleep 0.05; done`;
  const sh = (body) => start('sh', ['-c', `RECEIPT_PATHS="src scripts Dockerfile"; . "${receiptLib}"; ${body}`], { cwd: dir });
  const a = sh(`receipt_invalidate ${key} || exit 9; touch "${mark('a-started')}"; ${wait('b-started')}; ${bStaysAlive ? 'sleep 0.3' : wait('b-done')}; receipt_write ${key} "$(git rev-parse HEAD)" gate=pass; echo "write=$?"`);
  const b = sh(`${wait('a-started')}; receipt_invalidate ${key} || exit 9; touch "${mark('b-started')}"; ${bStaysAlive ? wait('b-go') : 'touch "' + mark('b-done') + '"'}; exit 1`);
  return { dir, key, a, b, go: () => writeFileSync(mark('b-go'), '') };
}

test('overlapping gate runs: a run that failed after another one passed keeps the receipt unusable', async () => {
  const { dir, a, b } = overlap({ bStaysAlive: false });
  const [first, second] = await Promise.all([a.done, b.done]);
  assert.equal(second.status, 1, 'the later run was red');
  assert.match(first.stdout, /write=/, 'the earlier run reached its write');
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'a red run that started after the pass blocks reuse');
});

test('overlapping gate runs: a pass is not written while another run of the tree is still going', async () => {
  const { dir, a, b, go } = overlap({ bStaysAlive: true });
  const first = await a.done;
  go();
  await b.done;
  assert.match(first.stdout, /write=1/, 'the write was refused');
  assert.match(first.stderr, /still in progress/);
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'and nothing is reusable');
});

test('pathspec magic cannot be smuggled in behind a leading ./', () => {
  const dir = receiptRepo();
  for (const paths of ['./:(top)src', ':(top)src', './:/src', '././:(glob)src']) {
    const result = receipt(dir, 'receipt_key HEAD', { paths });
    assert.notEqual(result.status, 0, paths);
    assert.equal(result.stdout.trim(), '');
  }
  const key = receipt(dir, 'receipt_key HEAD', { paths: './src/' }).stdout.trim();
  assert.equal(key, receipt(dir, 'receipt_key HEAD', { paths: 'src' }).stdout.trim(), 'a plain ./ and a trailing slash still normalise to the same key');
});

test('a symlink above or at a keyed path is refused, in the commit and in the working tree', () => {
  const dir = receiptRepo();
  symlinkSync('src', join(dir, 'link'));
  git(dir, 'add', 'link');
  git(dir, 'commit', '-qm', 'add a symlink to a directory');
  for (const [paths, label] of [
    ['src link/a.txt', 'a file under a symlink to a directory'],
    ['src link', 'the symlink itself'],
  ]) {
    const result = receipt(dir, 'receipt_key HEAD', { paths });
    assert.notEqual(result.status, 0, label);
    assert.equal(result.stdout.trim(), '', `${label}: no key`);
    assert.match(result.stderr, /symlink/);
  }
  assert.equal(receipt(dir, 'receipt_key HEAD', { paths: 'src' }).status, 0, 'a key that stays clear of the symlink is fine');
  // the commit may differ from the working tree: the commit's own symlink ancestors are refused too
  const first = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'rm', '-q', '--cached', 'link');
  unlinkSync(join(dir, 'link'));
  mkdirSync(join(dir, 'link'));
  writeFileSync(join(dir, 'link', 'a.txt'), 'plain\n');
  const result = receipt(dir, `receipt_key ${first}`, { paths: 'src link/a.txt' });
  assert.notEqual(result.status, 0, 'a symlink ancestor in the commit being keyed');
  assert.match(result.stderr, /symlink/);
});

test('a repository with a submodule is refused outright, whatever git says about the child', () => {
  const dir = receiptRepo();
  const child = gitRepo();
  writeFileSync(join(child, 'lib.js'), 'one\n');
  git(child, 'add', '.');
  git(child, 'commit', '-qm', 'child');
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'module');
  git(dir, 'commit', '-qm', 'add a submodule');
  for (const [paths, label] of [
    ['src module', 'a key that lists the submodule'],
    ['src', 'a key that does not'],
  ]) {
    for (const body of ['receipt_key HEAD', 'receipt_clean', 'receipt_reuse gate=pass', 'receipt_write abc "$(git rev-parse HEAD)" gate=pass']) {
      const result = receipt(dir, body, { paths });
      assert.notEqual(result.status, 0, `${label}: ${body}`);
      assert.match(result.stderr, /submodule/, `${label}: ${body}`);
    }
  }
  const gitlinkOnly = receiptRepo();
  git(gitlinkOnly, 'update-index', '--add', '--cacheinfo', `160000,${git(gitlinkOnly, 'rev-parse', 'HEAD')},module`);
  git(gitlinkOnly, 'commit', '-qm', 'a gitlink without a .gitmodules file');
  assert.notEqual(receipt(gitlinkOnly, 'receipt_key HEAD').status, 0, 'a gitlink alone is enough');
  const markerOnly = receiptRepo();
  writeFileSync(join(markerOnly, '.gitmodules'), '');
  assert.notEqual(receipt(markerOnly, 'receipt_key HEAD').status, 0, 'so is a .gitmodules file alone');
});

test('a symlink that appears in the working tree above a keyed path is refused, although git calls the tree clean', () => {
  const dir = receiptRepo();
  const paths = 'src optional/code.txt';
  const key = receipt(dir, 'receipt_key HEAD', { paths }).stdout.trim();
  assert.notEqual(key, '', 'a path that is absent at the commit still gives a key');
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`, { paths }).status, 0);
  assert.equal(receipt(dir, 'receipt_reuse gate=pass', { paths }).status, 0);
  const elsewhere = scratch();
  writeFileSync(join(elsewhere, 'code.txt'), 'different code\n');
  symlinkSync(elsewhere, join(dir, 'optional'));
  const result = receipt(dir, 'receipt_reuse gate=pass', { paths });
  assert.notEqual(result.status, 0, 'the receipt is not reused for code read through the new symlink');
  assert.match(result.stderr, /symlink/);
  assert.notEqual(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`, { paths }).status, 0, 'and no receipt is written for it');
});

test('core.symlinks=false is refused, since a symlink replaced by a file holding its link text reads as clean', () => {
  const dir = receiptRepo();
  symlinkSync('a.txt', join(dir, 'src', 'ln'));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'add a symlink under src');
  const key = receipt(dir, 'receipt_key HEAD').stdout.trim();
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0);
  assert.equal(receipt(dir, 'receipt_reuse gate=pass').status, 0);
  git(dir, 'config', 'core.symlinks', 'false');
  rmSync(join(dir, 'src', 'ln'));
  writeFileSync(join(dir, 'src', 'ln'), 'a.txt');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'git itself reports nothing for the replaced symlink');
  const result = receipt(dir, 'receipt_reuse gate=pass');
  assert.notEqual(result.status, 0, 'the receipt is not reused');
  assert.match(result.stderr, /core\.symlinks/);
  assert.notEqual(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0, 'and none is written');
});

test('cleanliness covers the whole repository, and an assume-unchanged or skip-worktree entry anywhere is refused', () => {
  const dir = receiptRepo();
  const key = receipt(dir, 'receipt_key HEAD').stdout.trim();
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0);
  assert.equal(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'clean to begin with');
  writeFileSync(join(dir, 'notes.md'), 'untracked, and outside the keyed paths\n');
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'an untracked file outside the keyed paths');
  assert.notEqual(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0);
  rmSync(join(dir, 'notes.md'));
  writeFileSync(join(dir, 'docs', 'd.md'), 'edited\n');
  assert.notEqual(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'a tracked file outside the keyed paths');
  git(dir, 'checkout', '--', 'docs/d.md');
  assert.equal(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'clean again');
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    git(dir, 'update-index', `--${flag}`, 'docs/d.md');
    const result = receipt(dir, 'receipt_reuse gate=pass');
    assert.notEqual(result.status, 0, `${flag} outside the keyed paths`);
    assert.match(result.stderr, /assume-unchanged or skip-worktree/);
    git(dir, 'update-index', `--no-${flag}`, 'docs/d.md');
  }
  assert.equal(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'and clean once the flags are gone');
});

test('a tree that git cannot report on, or that hides changes, is never called clean', () => {
  const dir = receiptRepo();
  const key = receipt(dir, 'receipt_key HEAD').stdout.trim();
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0);
  assert.equal(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'clean to begin with');

  git(dir, 'update-index', '--assume-unchanged', 'src/a.txt');
  writeFileSync(join(dir, 'src', 'a.txt'), 'changed behind git\n');
  let result = receipt(dir, 'receipt_reuse gate=pass');
  assert.notEqual(result.status, 0, 'an assume-unchanged file with changed content');
  assert.match(result.stderr, /assume-unchanged or skip-worktree/);
  assert.notEqual(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0, 'and no receipt is written for it');
  git(dir, 'update-index', '--no-assume-unchanged', 'src/a.txt');
  git(dir, 'checkout', '--', 'src/a.txt');

  git(dir, 'config', 'core.fileMode', 'false');
  result = receipt(dir, 'receipt_reuse gate=pass');
  assert.notEqual(result.status, 0, 'core.fileMode=false hides mode changes');
  assert.match(result.stderr, /core\.fileMode/);
  git(dir, 'config', 'core.fileMode', 'true');
  assert.equal(receipt(dir, 'receipt_reuse gate=pass').status, 0, 'and it is clean again once the setting is back');

  writeFileSync(join(dir, 'src', 'a.txt'), 'changed\n');
  writeFileSync(join(dir, '.git', 'index'), '');
  result = receipt(dir, 'receipt_reuse gate=pass');
  assert.notEqual(result.status, 0, 'a failing git status must not read as clean');
  assert.notEqual(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0);
});

test('a receipt key that is not a hex object id never becomes a path', () => {
  const dir = receiptRepo();
  const key = receipt(dir, 'receipt_key HEAD').stdout.trim();
  assert.equal(receipt(dir, `receipt_write ${key} "$(git rev-parse HEAD)" gate=pass`).status, 0, 'the receipt directory now exists');
  assert.notEqual(receipt(dir, 'receipt_read ../HEAD').status, 0, 'a key cannot climb out of the receipt directory');
  const result = receipt(dir, 'receipt_write ../../escaped "$(git rev-parse HEAD)" gate=pass');
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(dir, '.git', 'escaped')), false);
});

function ratchetRepo() {
  const dir = gitRepo();
  mkdirSync(join(dir, 'src', 'features'), { recursive: true });
  const config = JSON.parse(read(skill('design-gates', 'scripts', 'ratchet.config.example.json')));
  writeFileSync(join(dir, 'ratchet.config.json'), JSON.stringify(config));
  const ratchet = (...args) => spawnSync(process.execPath, [skill('design-gates', 'scripts', 'ratchet.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, config, ratchet };
}

test('the ratchet baseline cannot be raised by hand, and --allow-raise is the explicit way to raise it', () => {
  const { dir, ratchet } = ratchetRepo();
  const baseline = join(dir, 'ratchet-baseline.json');
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px] text-[14px]">a</p>\n');
  assert.equal(ratchet('--write').status, 0);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');

  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px] text-[14px] text-[15px] text-[16px]">a</p>\n');
  writeFileSync(baseline, `${JSON.stringify({ 'px-font-size': 4 }, null, 2)}\n`);
  let result = ratchet();
  assert.equal(result.status, 1, 'new debt plus a hand-raised baseline is not clean');
  assert.match(result.stderr, /\[px-font-size\] baseline raised from 2 to 4/);
  result = ratchet('--write');
  assert.equal(result.status, 1, '--write does not launder the raise');
  assert.match(result.stderr, /refusing to raise the baseline/);
  assert.equal(ratchet('--allow-raise').status, 0, 'an explicit flag accepts a deliberate raise');
  assert.equal(ratchet('--write', '--allow-raise').status, 0);
  assert.deepEqual(JSON.parse(read(baseline)), { 'px-font-size': 4 });

  writeFileSync(baseline, '{}\n');
  git(dir, 'checkout', '--', 'ratchet-baseline.json');
  writeFileSync(baseline, '{}\n');
  result = ratchet();
  assert.equal(result.status, 1, 'deleting the recorded count does not reset it');
  assert.match(result.stderr, /\[px-font-size\] grew from 2 to 4/);
});

test('ratchet --diff judges the new path of a renamed or copied file', () => {
  const { dir, ratchet } = ratchetRepo();
  const filler = Array.from({ length: 20 }, (_, index) => `const filler${index} = ${index};`).join('\n');
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), `${filler}\n<p className="text-[13px]">a</p>\n`);
  writeFileSync(join(dir, 'src', 'features', 'b.tsx'), `${filler}\n<p className="text-[11px] text-[12px]">b</p>\n`);
  assert.equal(ratchet('--write').status, 0);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');

  git(dir, 'mv', 'src/features/a.tsx', 'src/features/renamed.tsx');
  writeFileSync(join(dir, 'src', 'features', 'renamed.tsx'), `${filler}\n<p className="text-[13px] text-[14px]">a</p>\n`);
  writeFileSync(join(dir, 'src', 'features', 'b.tsx'), `${filler}\n<p className="text-[11px]">b</p>\n`);
  git(dir, 'add', '-A');
  assert.equal(ratchet().status, 0, 'the total is unchanged, so the plain run passes');
  const result = ratchet('--diff', 'HEAD');
  assert.equal(result.status, 1, 'the rename may not hide a new literal behind a removed one');
  assert.match(result.stderr, /src\/features\/renamed\.tsx adds 1 new hit/);

  writeFileSync(join(dir, 'src', 'features', 'renamed.tsx'), `${filler}\n<p className="text-[13px]">a</p>\n`);
  git(dir, 'add', '-A');
  assert.equal(ratchet('--diff', 'HEAD').status, 0, 'a pure rename adds nothing');
});

test('ratchet --diff against an unknown revision is an error, not a crash or a pass', () => {
  const { dir, ratchet } = ratchetRepo();
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), 'const a = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const result = ratchet('--diff', 'no-such-revision');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no-such-revision/);
});

test('a recorded count that is not a plain non-negative integer is an error, never a pass', () => {
  const { dir, ratchet } = ratchetRepo();
  const baseline = join(dir, 'ratchet-baseline.json');
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px] text-[14px]">a</p>\n');
  assert.equal(ratchet('--write').status, 0);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px] text-[14px] text-[15px]">a</p>\n');
  for (const value of ['not-a-number', -1, 1.5, null, [], {}, true]) {
    writeFileSync(baseline, JSON.stringify({ 'px-font-size': value }));
    const result = ratchet();
    assert.equal(result.status, 2, `baseline ${JSON.stringify(value)}`);
    assert.match(result.stderr, /must be a non-negative integer/);
    assert.doesNotMatch(result.stdout, /clean/);
  }
});

test('ratchet --diff counts untracked files and type changes as new', () => {
  const { dir, ratchet } = ratchetRepo();
  const filler = Array.from({ length: 20 }, (_, index) => `const filler${index} = ${index};`).join('\n');
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), `${filler}\n<p className="text-[13px] text-[14px]">a</p>\n`);
  writeFileSync(join(dir, 'doc.txt'), 'plain text\n');
  symlinkSync('../../doc.txt', join(dir, 'src', 'features', 'link.tsx'));
  assert.equal(ratchet('--write').status, 0);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');

  // one hit moves out of a.tsx into a file that git does not track yet
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), `${filler}\n<p className="text-[13px]">a</p>\n`);
  writeFileSync(join(dir, 'src', 'features', 'new.tsx'), '<p className="text-[14px]">n</p>\n');
  assert.equal(ratchet().status, 0, 'the total is unchanged');
  let result = ratchet('--diff', 'HEAD');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/features\/new\.tsx adds 1 new hit/);
  rmSync(join(dir, 'src', 'features', 'new.tsx'));

  // one hit moves out of a.tsx into a symlink that becomes a regular file
  rmSync(join(dir, 'src', 'features', 'link.tsx'));
  writeFileSync(join(dir, 'src', 'features', 'link.tsx'), '<p className="text-[14px]">l</p>\n');
  assert.equal(ratchet().status, 0, 'the total is unchanged again');
  result = ratchet('--diff', 'HEAD');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/features\/link\.tsx adds 1 new hit/);
});

test('ratchet --diff gives a type change no credit for the hits the old file held', () => {
  const { dir, ratchet } = ratchetRepo();
  writeFileSync(join(dir, 'doc.txt'), '<p className="text-[15px]">d</p>\n');
  writeFileSync(join(dir, 'src', 'features', 'b.tsx'), '<p className="text-[15px]">b</p>\n');
  assert.equal(ratchet('--write').status, 0);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  // b.tsx becomes a symlink to a file that holds the same single hit, so the total does not move
  rmSync(join(dir, 'src', 'features', 'b.tsx'));
  symlinkSync('../../doc.txt', join(dir, 'src', 'features', 'b.tsx'));
  assert.equal(ratchet().status, 0, 'the total is unchanged');
  const result = ratchet('--diff', 'HEAD');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/features\/b\.tsx adds 1 new hit/);
});

test('a scan that finds no files is an error and never reads as clean', () => {
  const { dir, ratchet } = ratchetRepo();
  const result = ratchet();
  assert.equal(result.status, 2, 'src exists but holds nothing to scan');
  assert.match(result.stderr, /nothing was checked/);
  assert.doesNotMatch(result.stdout, /clean/);
  writeFileSync(join(dir, 'src', 'features', 'notes.md'), 'text-[13px]\n');
  assert.equal(ratchet().status, 2, 'files of other extensions do not count');
});

test('a missing source root is an error and never reads as clean', () => {
  const { dir, config, ratchet } = ratchetRepo();
  config.roots = ['src', 'no-such-root'];
  writeFileSync(join(dir, 'ratchet.config.json'), JSON.stringify(config));
  const result = ratchet();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /root not found: no-such-root/);
  assert.doesNotMatch(result.stdout, /clean/);
});

test('watchdog sends one alert for one stall even when two runs overlap', async () => {
  const dir = scratch();
  const log = join(dir, 'orchestrator-log.md');
  writeFileSync(log, '- 10:00 CEST: batch started\n');
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(log, stale, stale);
  writeFileSync(join(dir, 'batch.open'), '');
  writeFileSync(join(dir, 'notify.sh'), `sleep 1\necho "$1" >> "${join(dir, 'alerts.txt')}"\n`);
  const env = { ...process.env, LOG: log, OPEN: join(dir, 'batch.open'), MAX_MIN: '30', NOTIFY: `sh ${join(dir, 'notify.sh')}` };
  const script = skill('run-agent-trains', 'scripts', 'watchdog.sh');
  await Promise.all([run('sh', [script], { env }), run('sh', [script], { env })]);
  assert.equal(read(join(dir, 'alerts.txt')).trim().split('\n').length, 1, 'one stall, one alert');
});

test('watchdog retries after a failed notification and then stays quiet once one went out', () => {
  const dir = scratch();
  const log = join(dir, 'orchestrator-log.md');
  writeFileSync(log, '- 10:00 CEST: batch started\n');
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  writeFileSync(join(dir, 'batch.open'), '');
  writeFileSync(join(dir, 'notify.sh'), `echo "$1" >> "${join(dir, 'attempts.txt')}"\n[ -e "${join(dir, 'ok')}" ]\n`);
  const env = { ...process.env, LOG: log, OPEN: join(dir, 'batch.open'), MAX_MIN: '30', NOTIFY: `sh ${join(dir, 'notify.sh')}` };
  const script = skill('run-agent-trains', 'scripts', 'watchdog.sh');
  const attempts = () => (existsSync(join(dir, 'attempts.txt')) ? read(join(dir, 'attempts.txt')).trim().split('\n').length : 0);
  const age = () => utimesSync(log, stale, stale);
  age();
  spawnSync('sh', [script], { env });
  spawnSync('sh', [script], { env });
  assert.equal(attempts(), 2, 'a failed notification leaves no marker, so the next run tries again');
  writeFileSync(join(dir, 'ok'), '');
  spawnSync('sh', [script], { env });
  spawnSync('sh', [script], { env });
  assert.equal(attempts(), 3, 'after a delivered alert the stall is not announced again');
});

const claimScript = skill('run-agent-trains', 'scripts', 'claim.sh');

test('claim.sh refuses an id that is not a plain file name and never writes outside the claim directory', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'claims'));
  const env = { ...process.env, CLAIMS: join(dir, 'claims'), AGENT: 'agent-a' };
  for (const id of ['../escaped', '..', '.', 'a/b', 'a b', 'a..b', '/abs']) {
    const result = spawnSync('sh', [claimScript, id], { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `id ${JSON.stringify(id)} is refused`);
    assert.doesNotMatch(result.stdout, /claimed/);
  }
  assert.equal(existsSync(join(dir, 'escaped')), false, 'nothing was created beside the claim directory');
  assert.deepEqual(readdirSync(join(dir, 'claims')), [], 'and nothing inside it');
  assert.equal(spawnSync('sh', [claimScript, 'FU-01.a_b'], { env, encoding: 'utf8' }).status, 0, 'a normal id is fine');
});

test('claim.sh does not report a claim whose owner record could not be written', { skip: process.getuid?.() === 0 }, () => {
  const dir = scratch();
  mkdirSync(join(dir, 'claims'));
  const result = spawnSync('sh', ['-c', `umask 0777; sh "${claimScript}" FU-09`], {
    env: { ...process.env, CLAIMS: join(dir, 'claims'), AGENT: 'agent-a' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /claimed/);
  assert.deepEqual(readdirSync(join(dir, 'claims')), [], 'the half-made claim is removed so the item can be claimed again');
});

const uncovered = skill('brief-agents', 'scripts', 'uncovered.sh');

test('uncovered.sh fails outside a git work tree, on a missing cards directory and on a pattern that matches nothing', () => {
  const outside = scratch();
  mkdirSync(join(outside, 'cards'));
  let result = spawnSync('sh', [uncovered, 'src/*.tsx', 'cards'], { cwd: outside, encoding: 'utf8' });
  assert.equal(result.status, 2, 'outside git');
  assert.match(result.stderr, /git work tree/);

  const dir = gitRepo();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.tsx'), '');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'x');
  result = spawnSync('sh', [uncovered, 'src/*.tsx', 'missing-cards'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 2, 'missing cards directory');
  assert.match(result.stderr, /missing-cards/);

  mkdirSync(join(dir, 'cards'));
  result = spawnSync('sh', [uncovered, 'nothing/*.tsx', 'cards'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 2, 'a pattern that matches no tracked file');
  assert.match(result.stderr, /matches no tracked files/);
});

test('the docs state the corrected contracts', () => {
  const audit = read(skill('audit-agent-program', 'SKILL.md'));
  assert.doesNotMatch(audit, /Build the top|nobody builds|in the same session/i, 'the audit stays read-only');
  assert.match(audit, /separate task/i);
  assert.match(audit, /approv/i);

  const queue = read(skill('run-agent-trains', 'references', 'queue-formats.md'));
  assert.doesNotMatch(queue, /mkdir release\.lock/, 'the lock path is not relative to a worktree');
  assert.match(queue, /LOCK=\/[^\s]+/, 'one absolute shared lock path');
  assert.match(queue, /deadline|gives up|timeout/i, 'a bounded wait');
  assert.match(queue, /stale/i, 'a stale-lock recovery');

  const verify = read(skill('verify-delivery', 'SKILL.md'));
  assert.match(verify, /requested boundary includes production/i);
  assert.doesNotMatch(verify, /Builders report `LOCAL-ONLY:` until the production proof exists\./);

  assert.match(read(skill('verify-delivery', 'references', 'tree-keyed-receipts.md')), /receipt_invalidate "\$key" \|\| exit 1/, 'the documented gate stops when invalidation fails');
  assert.match(read(skill('run-agent-trains', 'scripts', 'heavy-slot.sh')), /best-effort limit.*ONE host/s, 'the slot script states what it is');
  assert.match(read(skill('run-agent-trains', 'references', 'heavy-slots.md')), /## Limits[\s\S]*paused for more than a minute/, 'and lists the pause that can admit an extra job');
  assert.match(read(skill('run-agent-trains', 'scripts', 'watchdog.sh')), /second alert for the same stall/, 'the watchdog states its overlap limit');
  assert.match(read(skill('design-gates', 'references', 'visual-gates.md')), /in our environment/i);
  assert.match(read(join(root, 'docs', 'compatibility.md')), /^Agent Process Kit v0\.5 /m);
});
