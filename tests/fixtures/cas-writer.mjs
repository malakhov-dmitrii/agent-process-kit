import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareAndSwapTask, StoreError } from '../../runtime/core/store.mjs';

const [root, taskId, marker] = process.argv.slice(2);
const start = join(root, 'barrier', 'start');
while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);

try {
  const record = compareAndSwapTask({
    root,
    taskId,
    expectedRecordVersion: 0,
    mutate: (current) => ({ ...current, lastTrace: { marker } }),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, marker, recordVersion: record.recordVersion })}\n`);
} catch (error) {
  const code = error instanceof StoreError ? error.code : 'UNEXPECTED';
  process.stderr.write(`${code}: ${error.message}\n`);
  process.exitCode = 2;
}
