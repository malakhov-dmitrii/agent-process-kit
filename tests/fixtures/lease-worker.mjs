import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { LeaseError, acquireLease, currentFence } from '../../runtime/core/leases.mjs';
import { StoreError, readTask } from '../../runtime/core/store.mjs';

const [root, taskId, scope, marker, mode] = process.argv.slice(2);
const start = join(root, 'barrier', 'start');
while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);

let attempts = 0;
while (attempts < (mode === 'retry' ? 20 : 1)) {
  attempts += 1;
  const record = readTask({ root, taskId });
  try {
    const result = acquireLease({
      root,
      taskId,
      scope,
      ownerHost: 'fixture',
      ownerSession: marker,
      expectedRecordVersion: record.recordVersion,
      expectedFence: currentFence(record, scope),
      renewBefore: '2026-10-08T12:10:00.000Z',
      expiresAt: '2026-10-08T12:20:00.000Z',
      now: '2026-10-08T12:00:00.000Z',
      leaseId: `lease-${marker}`,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, fence: result.lease.fenceToken, attempts })}\n`);
    process.exit(0);
  } catch (error) {
    const retryable = error instanceof StoreError && error.code === 'STALE_RECORD_VERSION';
    if (mode === 'retry' && retryable) continue;
    const code = error instanceof LeaseError || error instanceof StoreError ? error.code : 'UNEXPECTED';
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exit(2);
  }
}

process.stderr.write('STALE_RECORD_VERSION: retry budget exhausted\n');
process.exit(2);
