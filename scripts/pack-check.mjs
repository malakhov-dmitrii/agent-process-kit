import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'agent process package '));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run via npm run pack:check');
const userConfig = join(scratch, 'user.npmrc'), globalConfig = join(scratch, 'global.npmrc');
writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
const runNpm = (args, cwd) => execFileSync(process.execPath, [npm, '--cache', join(scratch, 'cache'),
  '--userconfig', userConfig, '--globalconfig', globalConfig, ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const packed = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], root))[0];
const forbidden = /(^|\/)(?:\.git|\.work|\.agent|\.omx|node_modules|\.env)(?:\/|$)|(?:runtime-state|hook-receipts|transactions\/profile-writes|checkpoints)\//;
assert.ok(packed.files.length > 0);
for (const file of packed.files) assert.ok(!forbidden.test(file.path), `Unexpected package member ${file.path}`);
const archive = join(scratch, packed.filename);
const prefix = join(scratch, 'installed prefix');
runNpm(['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, archive], scratch);
const executable = join(prefix, 'bin', 'agent-process-kit');
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
assert.equal(execFileSync(process.execPath, [executable, '--version'], { encoding: 'utf8' }).trim(), version);
const installed = join(prefix, 'lib/node_modules/@malakhov-dmitrii/agent-process-kit');
execFileSync(process.execPath, [join(installed, 'scripts/check.mjs')], { cwd: installed, stdio: 'pipe' });
const smoke = execFileSync(process.execPath, [join(installed, 'checks/runtime-smoke.mjs'), join(installed, 'harness')], { cwd: scratch, encoding: 'utf8' });
assert.equal(JSON.parse(smoke).status, 'PASS');
console.log(`Package ${packed.filename}: ${packed.files.length} allowlisted files; global symlink, integrity checks and installed runtime PASS.`);
