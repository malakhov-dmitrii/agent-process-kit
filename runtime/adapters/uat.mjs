import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { assertMutationLease, mutateWithLease } from '../core/leases.mjs';
import { readTask } from '../core/store.mjs';

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be non-empty`);
  return value;
}

function assertCandidate(record, candidateIdentity) {
  if (candidateIdentity?.taskId !== record.taskId
      || candidateIdentity?.specGeneration !== record.specGeneration
      || candidateIdentity?.planGeneration !== record.planGeneration) {
    const error = new Error('candidate identity mismatch with current task');
    error.code = 'CANDIDATE_MISMATCH';
    throw error;
  }
}

function receiptBase({ taskId, candidateIdentity, scenarioId, producer, startedAt, completedAt }) {
  return {
    receiptId: `local-uat:${scenarioId}:${randomUUID()}`,
    type: 'local-uat',
    taskId,
    candidateIdentity: structuredClone(candidateIdentity),
    producer: structuredClone(producer ?? { kind: 'local-uat' }),
    scenario: scenarioId,
    coverage: 'full-candidate',
    startedAt,
    completedAt,
  };
}

function filesystemFailure(checks = []) {
  for (const check of checks) {
    object(check, 'filesystemChecks entry');
    text(check.path, 'filesystem check path');
    if (!existsSync(check.path)) return `missing-file:${check.path}`;
    if (check.contains !== undefined && !readFileSync(check.path, 'utf8').includes(check.contains)) return `content-mismatch:${check.path}`;
  }
  return null;
}

/** Execute a real local process/filesystem scenario and persist its candidate-bound receipt. */
export function runLocalUat({
  root, taskId, context, candidateIdentity, scenarioId, producer, command, filesystemChecks = [],
  provider = 'local-cli', providerAvailable = true, testsGreen = false, regressionOwner = 'verification-release',
  timeoutMs = 30_000, now = new Date().toISOString(),
}) {
  text(taskId, 'taskId');
  text(scenarioId, 'scenarioId');
  object(candidateIdentity, 'candidateIdentity');
  const current = readTask({ root, taskId });
  assertCandidate(current, candidateIdentity);
  // Validate ownership and fencing before invoking an irreversible or expensive UAT process.
  assertMutationLease(current, context, { now, requiredScope: 'canonical' });
  const startedAt = now;
  let verdict = 'pass';
  let reason;
  let commandResult;
  if (!providerAvailable) {
    verdict = 'missing';
    reason = `${provider}-provider-unavailable`;
  } else if (!Array.isArray(command) || command.length === 0) {
    verdict = 'missing';
    reason = testsGreen ? 'tests-do-not-substitute-for-local-uat' : 'real-uat-command-missing';
  } else {
    commandResult = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    if (commandResult.error) {
      verdict = 'fail';
      reason = commandResult.error.code === 'ETIMEDOUT' ? 'command-timeout' : `command-error:${commandResult.error.code ?? commandResult.error.message}`;
    } else if (commandResult.status !== 0) {
      verdict = 'fail';
      reason = `command-exit:${commandResult.status}`;
    } else {
      reason = filesystemFailure(filesystemChecks);
      if (reason) verdict = 'fail';
    }
  }
  const completedAt = now;
  const receipt = {
    ...receiptBase({ taskId, candidateIdentity, scenarioId, producer, startedAt, completedAt }),
    verdict,
    provider,
    ...(reason ? { reason } : {}),
    ...(commandResult ? { exitCode: commandResult.status, signal: commandResult.signal ?? null } : {}),
    ...(verdict === 'fail' ? { regressionOwner } : {}),
  };
  let record;
  record = mutateWithLease({
    root, taskId, context, now, requiredScope: 'canonical',
    mutate: (current) => ({
      ...current,
      evidence: [...current.evidence, receipt],
      ...(verdict === 'fail'
        ? { followUps: [...current.followUps, { id: `regression:local-uat:${scenarioId}`, owner: regressionOwner }] }
        : {}),
      lastTrace: { expected: 'real local UAT', actual: verdict, decision: verdict === 'pass' ? 'continue' : 'open regression', nextOwner: verdict === 'pass' ? 'release' : regressionOwner, nextAction: verdict === 'pass' ? 'assess release' : 'fix regression' },
    }),
  });
  return { receipt, record };
}
