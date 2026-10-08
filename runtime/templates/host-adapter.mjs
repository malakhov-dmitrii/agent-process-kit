#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const input = process.env.AGENT_PROCESS_KIT_EVENT_JSON || process.argv[2] || '{}';
let payload;
try { payload = JSON.parse(input); } catch (error) {
  console.error(`agent-process-kit host adapter: invalid event JSON: ${error.message}`);
  process.exit(2);
}
const cli = process.env.AGENT_PROCESS_KIT_CLI || 'agent-process-kit';
const result = spawnSync(cli, ['hook', '--data', JSON.stringify(payload)], { encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
