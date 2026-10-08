#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [, , cli, stateDir, taskId] = process.argv;
const result = spawnSync(process.execPath, [resolve(cli), 'task', 'status', '--task-id', taskId, '--state-dir', stateDir], { encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
