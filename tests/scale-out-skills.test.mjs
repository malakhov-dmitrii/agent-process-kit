import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { git, gitRepo, read, run, scratch, skill, start, until } from './fixtures/scale-out-helpers.mjs';

const newSkills = ['run-agent-trains', 'brief-agents', 'design-gates', 'audit-agent-program'];

test('the four many-agent skills are compact, distributable and self-contained', () => {
  for (const name of newSkills) {
    const body = read(skill(name, 'SKILL.md'));
    assert.match(body, new RegExp(`^---\\nname: ${name}\\ndescription: Use when `), name);
    assert.ok(body.length < 9000, `${name} must keep branch detail in references`);
    assert.doesNotMatch(body.match(/^description: (.+)$/m)[1], /: | #/, `${name} description must be a valid plain YAML scalar`);
    assert.ok(existsSync(skill(name, 'LICENSE')) && existsSync(skill(name, 'NOTICE.md')), name);
    for (const link of body.matchAll(/\]\((references\/[^)]+)\)/g)) {
      assert.ok(existsSync(skill(name, link[1])), `${name} links ${link[1]}`);
    }
    // A skill must work when installed alone, so it never links outside its own folder.
    assert.doesNotMatch(body, /\]\(\.\.\//, `${name} links outside its folder`);
  }
});

test('the queue-format examples match the documented line formats', () => {
  const body = read(skill('run-agent-trains', 'references', 'queue-formats.md'));
  const lines = body.split('\n');
  const ready = lines.filter((line) => /^\d{2}:\d{2} [A-Z]{3,4} \| C-\d+ \|/.test(line));
  const trains = lines.filter((line) => /^\d{2}:\d{2} [A-Z]{3,4} \| train-/.test(line));
  const log = lines.filter((line) => /^- \d{2}:\d{2} [A-Z]{3,4}: /.test(line));
  assert.ok(ready.length > 0 && trains.length > 0 && log.length > 0, 'each format needs an example');
  for (const line of ready) {
    assert.match(line, /^\d{2}:\d{2} [A-Z]{3,4} \| [\w-]+ \| [\w/.-]+ @ [0-9a-f]{7,40} \| base: [^|]+ \| spec: [^|]+ \| surfaces: [^|]+ \| risks: [^|]+$/);
  }
  for (const line of trains) {
    assert.match(line, /^\d{2}:\d{2} [A-Z]{3,4} \| train-[\w-]+ @ [0-9a-f]{7,40} \| cards IN: [^|]+ \| cards OUT \(reason\): [^|]+ \| proofs: [^|]+ \| risks: [^|]+$/);
  }
});

test('heavy-slot never runs more commands than the slots allow and frees every slot', async () => {
  const dir = scratch();
  const runDir = join(dir, 'running');
  mkdirSync(runDir);
  const job = join(dir, 'job.sh');
  writeFileSync(job, `mkdir "${runDir}/$$"\nls "${runDir}" | wc -l >> "${dir}/peak"\nsleep 0.4\nrmdir "${runDir}/$$"\n`);
  const env = { ...process.env, SLOT_DIR: join(dir, 'slots'), SLOTS: '3', RESERVED: '1', POLL: '0.1' };
  const script = skill('run-agent-trains', 'scripts', 'heavy-slot.sh');
  const results = await Promise.all(Array.from({ length: 6 }, () => run('sh', [script, '--', 'sh', job], { env })));
  assert.deepEqual(results.map((result) => result.status), [0, 0, 0, 0, 0, 0]);
  const peaks = read(join(dir, 'peak')).trim().split('\n').map(Number);
  assert.equal(peaks.length, 6, 'every job ran');
  assert.equal(Math.max(...peaks), 2, 'builders may use SLOTS - RESERVED slots, and do use them');
  const claims = readdirSync(join(dir, 'slots'));
  assert.equal(claims.length, 6, 'one claim per job, none reused');
  assert.ok(claims.every((name) => existsSync(join(dir, 'slots', name, 'released'))), 'and every claim is released');
});

test('heavy-slot keeps one slot for the release class and passes the exit code through', async () => {
  const dir = scratch();
  const env = { ...process.env, SLOT_DIR: join(dir, 'slots'), SLOTS: '2', RESERVED: '1', POLL: '0.1' };
  const script = skill('run-agent-trains', 'scripts', 'heavy-slot.sh');
  const mark = (name) => join(dir, name);
  // Explicit handshakes: the holder says when it holds its slot and waits to be told to finish,
  // and the second builder says when it is queued. No step depends on how long anything takes.
  const holder = start('sh', [script, '--', 'sh', '-c', `touch "${mark('held')}"; while [ ! -e "${mark('go')}" ]; do sleep 0.05; done; touch "${mark('builder-done')}"`], { env });
  await until(() => existsSync(mark('held')), 'the first builder to hold its slot');
  const waiting = start('sh', [script, '--', 'sh', '-c', `touch "${mark('second-builder-done')}"`], { env });
  await until(() => /waiting for a builder slot/.test(waiting.output().stderr), 'the second builder to queue');
  const release = await run('sh', [script, '-r', '--', 'sh', '-c', `touch "${mark('release-done')}"; exit 7`], { env });
  try {
    assert.equal(release.status, 7, 'the command exit code is the wrapper exit code');
    assert.ok(existsSync(mark('release-done')), 'the release class ran in the reserved slot');
    assert.equal(existsSync(mark('builder-done')), false, 'while the first builder still held its slot');
    assert.equal(existsSync(mark('second-builder-done')), false, 'and the second builder was still waiting');
  } finally {
    writeFileSync(mark('go'), '');
  }
  await Promise.all([holder.done, waiting.done]);
  assert.ok(existsSync(mark('second-builder-done')));
});

test('heavy-slot claims over a slot whose owner is gone', async () => {
  const dir = scratch();
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  const slot = join(dir, 'slots', 'slot-1.1');
  mkdirSync(slot, { recursive: true });
  writeFileSync(join(slot, 'pid'), `${dead.pid}\n`);
  writeFileSync(join(slot, 'pgid'), `${dead.pid}\n`); // its command published a group, and the group is gone too
  const env = { ...process.env, SLOT_DIR: join(dir, 'slots'), SLOTS: '2', RESERVED: '1', POLL: '0.1' };
  const result = await run('sh', [skill('run-agent-trains', 'scripts', 'heavy-slot.sh'), '--', 'true'], { env });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /waiting/);
  assert.ok(existsSync(join(dir, 'slots', 'slot-1.2')), 'the new claim has the next number');
});

test('claim.sh lets exactly one of several racing agents own an item', async () => {
  const dir = scratch();
  const script = skill('run-agent-trains', 'scripts', 'claim.sh');
  const results = await Promise.all(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((agent) => run('sh', [script, 'FU-01'], { env: { ...process.env, CLAIMS: join(dir, 'claims'), AGENT: `agent-${agent}` } })),
  );
  assert.equal(results.filter((result) => result.status === 0).length, 1);
  assert.equal(results.filter((result) => result.status === 1).length, 5);
  assert.match(read(join(dir, 'claims', 'FU-01', 'status.txt')), /^claimed by agent-[a-f] at /);
});

test('watchdog alerts once per stall and stays quiet when the batch is closed or the log is fresh', () => {
  const dir = scratch();
  const log = join(dir, 'orchestrator-log.md');
  const open = join(dir, 'batch.open');
  const alerts = join(dir, 'alerts.txt');
  writeFileSync(join(dir, 'notify.sh'), `echo "$1" >> "${alerts}"\n`);
  writeFileSync(log, '- 10:00 CEST: batch started\n');
  const env = { ...process.env, LOG: log, OPEN: open, MAX_MIN: '30', NOTIFY: `sh ${join(dir, 'notify.sh')}` };
  const script = skill('run-agent-trains', 'scripts', 'watchdog.sh');
  const count = () => (existsSync(alerts) ? read(alerts).trim().split('\n').length : 0);
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);

  utimesSync(log, stale, stale);
  spawnSync('sh', [script], { env });
  assert.equal(count(), 0, 'no batch is open');

  writeFileSync(open, '');
  utimesSync(log, new Date(), new Date());
  spawnSync('sh', [script], { env });
  assert.equal(count(), 0, 'the log is fresh');

  utimesSync(log, stale, stale);
  spawnSync('sh', [script], { env });
  spawnSync('sh', [script], { env });
  assert.equal(count(), 1, 'one alert for one stall');
  assert.match(read(alerts), /a batch is open and no new line/);

  utimesSync(log, new Date(), new Date());
  spawnSync('sh', [script], { env });
  utimesSync(log, stale, stale);
  spawnSync('sh', [script], { env });
  assert.equal(count(), 2, 'a new stall alerts again after the log moved');
});

test('gate receipts are keyed to the tree, survive docs-only commits and refuse a dirty or wrong tree', () => {
  const dir = gitRepo();
  for (const sub of ['src', 'docs', 'scripts']) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, 'src', 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'docs', 'd.md'), 'd\n');
  writeFileSync(join(dir, 'scripts', 's.sh'), 's\n');
  writeFileSync(join(dir, 'Dockerfile'), 'f\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'one');
  const lib = skill('verify-delivery', 'scripts', 'gate-receipt.sh');
  const sh = (body) => spawnSync('sh', ['-c', `RECEIPT_PATHS="src scripts Dockerfile"; . "${lib}"; ${body}`], { cwd: dir, encoding: 'utf8' });

  const key1 = sh('receipt_key HEAD').stdout.trim();
  assert.match(key1, /^[0-9a-f]{40}$/);
  assert.notEqual(sh('receipt_reuse gate=pass').status, 0, 'no receipt yet');
  assert.equal(sh(`receipt_write ${key1} "$(git rev-parse HEAD)" gate=pass design=pass`).status, 0);
  assert.equal(sh('receipt_reuse gate=pass design=pass').status, 0);
  assert.notEqual(sh('receipt_reuse gate=pass lint=pass').status, 0, 'a missing flag blocks reuse');

  writeFileSync(join(dir, 'docs', 'd.md'), 'd2\n');
  git(dir, 'commit', '-qam', 'docs only');
  assert.equal(sh('receipt_key HEAD').stdout.trim(), key1, 'docs are outside the key');
  assert.equal(sh('receipt_reuse gate=pass design=pass').status, 0, 'a docs-only commit keeps its receipt');

  writeFileSync(join(dir, 'src', 'a.txt'), 'b\n');
  git(dir, 'commit', '-qam', 'code');
  assert.notEqual(sh('receipt_key HEAD').stdout.trim(), key1, 'a code change gives a new key');
  assert.notEqual(sh('receipt_reuse gate=pass').status, 0, 'the old receipt no longer matches');
  assert.notEqual(sh(`receipt_write ${key1} "$(git rev-parse HEAD)" gate=pass`).status, 0, 'a key that is not the commit key is refused');

  writeFileSync(join(dir, 'src', 'a.txt'), 'dirty\n');
  assert.notEqual(sh('receipt_reuse gate=pass').status, 0, 'a dirty keyed path blocks reuse');
});

test('the ratchet is red on a planted violation and cannot be loosened to pass', () => {
  const dir = gitRepo();
  mkdirSync(join(dir, 'src', 'features'), { recursive: true });
  mkdirSync(join(dir, 'src', 'components', 'ui'), { recursive: true });
  const config = JSON.parse(read(skill('design-gates', 'scripts', 'ratchet.config.example.json')));
  writeFileSync(join(dir, 'ratchet.config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px] text-[14px]">a</p>\n');
  writeFileSync(join(dir, 'src', 'features', 'b.tsx'), '<p className="text-[11px]">b</p>\n');
  writeFileSync(join(dir, 'src', 'components', 'ui', 'primitive.tsx'), 'const c = "#ff0000";\n');
  const ratchet = (...args) => spawnSync(process.execPath, [skill('design-gates', 'scripts', 'ratchet.mjs'), ...args], { cwd: dir, encoding: 'utf8' });

  assert.equal(ratchet('--write').status, 0, 'first write records the debt');
  assert.deepEqual(JSON.parse(read(join(dir, 'ratchet-baseline.json'))), { 'px-font-size': 3 });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  assert.equal(ratchet().status, 0, 'clean tree, and the excluded primitive layer is ignored');

  // zero target
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px] text-[14px]">a</p>\nconst c = "#ff0000";\n');
  let result = ratchet();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RATCHET FAILED/);
  assert.match(result.stderr, /\[colour-hex\] src\/features\/a\.tsx:2 must stay at zero/);
  assert.match(result.stderr, /Use a colour role token/);

  // growth of a counted rule, and a refused baseline raise
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px] text-[14px] text-[15px]">a</p>\n');
  result = ratchet();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[px-font-size\] grew from 3 to 4/);
  result = ratchet('--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to raise the baseline/);
  assert.deepEqual(JSON.parse(read(join(dir, 'ratchet-baseline.json'))), { 'px-font-size': 3 });

  // --diff catches a net new hit in a touched file although the total has headroom
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px]">a</p>\n');
  writeFileSync(join(dir, 'src', 'features', 'b.tsx'), '<p className="text-[11px] text-[12px]">b</p>\n');
  assert.equal(ratchet().status, 0, 'the total is unchanged, so the plain run passes');
  result = ratchet('--diff', 'HEAD');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/features\/b\.tsx adds 1 new hit/);

  // an allow entry with no hit is stale
  writeFileSync(join(dir, 'src', 'features', 'b.tsx'), '<p className="text-[11px]">b</p>\n');
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px] text-[14px]">a</p>\n');
  config.allow = [{ file: 'src/features/a.tsx', key: 'colour-hex', reason: 'fixture' }];
  writeFileSync(join(dir, 'ratchet.config.json'), JSON.stringify(config));
  result = ratchet();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale allow entry/);

  // lowering a count is recorded
  config.allow = [];
  writeFileSync(join(dir, 'ratchet.config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'src', 'features', 'a.tsx'), '<p className="text-[13px]">a</p>\n');
  assert.equal(ratchet('--write').status, 0);
  assert.deepEqual(JSON.parse(read(join(dir, 'ratchet-baseline.json'))), { 'px-font-size': 2 });
});

test('uncovered.sh lists files that no card names, by path and then by file name', () => {
  const dir = gitRepo();
  mkdirSync(join(dir, 'src', 'a'), { recursive: true });
  mkdirSync(join(dir, 'src', 'b'));
  mkdirSync(join(dir, 'cards'));
  for (const file of ['a/panel.tsx', 'a/menu.tsx', 'b/dialog.tsx', 'b/dialog.test.tsx', 'b/footer.tsx']) writeFileSync(join(dir, 'src', file), '');
  writeFileSync(join(dir, 'cards', '1.md'), 'Card 1 restyles src/a/panel.tsx and the footer.tsx strip.\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'x');
  const script = skill('brief-agents', 'scripts', 'uncovered.sh');
  const byPath = spawnSync('sh', [script, 'src/*.tsx', 'cards'], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(byPath.stdout.trim().split('\n'), ['src/a/menu.tsx', 'src/b/dialog.tsx', 'src/b/footer.tsx']);
  const byName = spawnSync('sh', [script, 'src/*.tsx', 'cards', '-b'], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(byName.stdout.trim().split('\n'), ['src/a/menu.tsx', 'src/b/dialog.tsx']);
  assert.match(byName.stderr, /uncovered: 2 of 4 files/);
});
