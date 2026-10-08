import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { recordExternalAttempt } from '../../runtime/core/grants.mjs';

const [root, taskId, rawContext, idempotencyKey, attemptId] = process.argv.slice(2);
const start = join(root, 'barrier', 'start');
while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);

try {
  const result = recordExternalAttempt({
    root,
    taskId,
    context: JSON.parse(rawContext),
    grantId: 'grant-1',
    idempotencyKey,
    attemptId,
    intent: {
      allowedAction: 'push',
      targetResource: 'git:origin/main',
      candidateIdentity: { taskId, specGeneration: 0, planGeneration: 0, contentFingerprint: 'a'.repeat(64), commitSha: 'b'.repeat(40) },
    },
    now: '2026-10-08T12:05:00.000Z',
  });
  process.stdout.write(`${JSON.stringify({ ok: true, attemptId: result.attempt.attemptId })}\n`);
} catch (error) {
  process.stderr.write(`${error.code ?? 'UNEXPECTED'}: ${error.message}\n`);
  process.exitCode = 2;
}
