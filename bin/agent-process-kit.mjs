#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { startTask, recordDecision, freezeSpec, freezePlan, recordSpecification, recordPlan, recordReview, recordSelfCheck, advancePhase } from '../runtime/core/control-plane.mjs';
import { readTask, getStateRoot, inspectTaskState } from '../runtime/core/store.mjs';
import { getStatus } from '../runtime/core/status.mjs';
import { resolveTaskStatusTransition } from '../runtime/core/transitions.mjs';
import { completeTask } from '../runtime/core/eligibility.mjs';
import { getReadyStories, claimStory, submitStoryResult, recordStoryReceipt, refreshStoryReceipts, freezeStoryGraph } from '../runtime/core/stories.mjs';
import { acquireLease, releaseLease, renewLease, mutateWithLease, currentFence } from '../runtime/core/leases.mjs';
import { bindSession, publishDiscoveryCandidate, resolveCurrentTask } from '../runtime/adapters/sessions.mjs';
import { prepareHandoff, acceptHandoff } from '../runtime/adapters/handoff.mjs';
import { checkpointTask, resumeFromCheckpoint } from '../runtime/adapters/checkpoint.mjs';
import { handleHostEvent } from '../runtime/adapters/hooks.mjs';
import { recordAuthorizationIntent, issueExecutionGrant, revokeGrant, recordExternalAttempt, reconcileExternalAttempt } from '../runtime/core/grants.mjs';
import { assessReleaseReadiness, executeRelease, recordProductionUat, recordProductionObservation } from '../runtime/adapters/release.mjs';
import { runLocalUat } from '../runtime/adapters/uat.mjs';
import { setupProject, verifySetup, rollbackProject } from '../runtime/setup/project-setup.mjs';
import { applyMigration, dryRunMigration, rollbackMigration } from '../runtime/adapters/migrate-v0.2.mjs';
import { recordEvidenceReceipt } from '../runtime/core/evidence.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `agent-process-kit 0.4\n\nCommands:\n  setup | verify-setup | rollback\n  migrate-v0.2 dry-run|apply|rollback\n  task start|status|resume|resume-checkpoint|pause|cancel|complete|advance|renew|bind|handoff|accept-handoff|checkpoint\n  spec decision|record-decision|record|self-check|freeze|review\n  plan record|self-check|freeze|ready-stories|claim|submit|integrate|review\n  code self-check|review\n  lease renew\n  evidence record|list|verify\n  uat record\n  grant intent|record-intent|issue|revoke\n  external begin|reconcile\n  release ready|execute|record|production-uat|observation|verify\n  hook | repair\n\nOptions accept --task-id, --request, --project, --state-dir, --data JSON, --context JSON and --apply.\n`;
const UNSUPPORTED = new Set(['evidence.verify']);

function parse(argv) {
  const args = [...argv]; const command = []; const options = {};
  while (args.length) {
    const value = args.shift();
    if (value === '--help' || value === '-h') return { help: true };
    if (value.startsWith('--')) {
      const key = value.slice(2).replaceAll('-', '_');
      if (key === 'apply') options.apply = true;
      else { const next = args.shift(); if (next === undefined || next.startsWith('--')) throw Object.assign(new Error(`${value} requires a value`), { code: 'INVALID_ARGUMENT' }); options[key] = next; }
    } else command.push(value);
  }
  return { command, options };
}
function json(value, label) { try { return JSON.parse(value); } catch (error) { throw Object.assign(new Error(`${label} must be valid JSON`), { code: 'INVALID_ARGUMENT', details: { cause: error.message } }); } }
function input(options) {
  const value = options.data ?? options.input;
  if (!value) return {};
  if (value === '-') return json(readFileSync(0, 'utf8'), 'input');
  return json(value, 'data');
}
function rootFor(options) { return resolve(options.state_dir ?? getStateRoot()); }
function taskId(options, data) { return options.task_id ?? data.taskId ?? data.task_id; }
function context(options, data) { return options.context ? json(options.context, 'context') : data.context; }
function payload(options) { return { ...input(options), ...Object.fromEntries(Object.entries(options).filter(([key]) => !['data', 'input', 'state_dir', 'apply', 'context'].includes(key))) }; }
function envelope(result, task, recordVersion) { return JSON.stringify({ ok: true, ...(task ? { taskId: task } : {}), ...(recordVersion !== undefined ? { recordVersion } : {}), result: result ?? null }); }
function errorEnvelope(error, options = {}) { const task = options.task_id; return JSON.stringify({ ok: false, ...(task ? { taskId: task } : {}), error: { code: error.code ?? 'COMMAND_FAILED', message: error.message, ...(error.details ? { details: error.details } : {}) } }); }
function resultOf(result, task) { return envelope(result, task ?? result?.record?.taskId ?? result?.task?.taskId, result?.record?.recordVersion); }
function requireTask(options, data) { const id = taskId(options, data); if (!id) throw Object.assign(new Error('--task-id is required'), { code: 'INVALID_ARGUMENT' }); return id; }
function mutateStatus({ root, id, ctx, event, facts, now }) {
  const current = readTask({ root, taskId: id }); const transition = resolveTaskStatusTransition({ from: current.status, event, facts });
  const record = mutateWithLease({ root, taskId: id, context: ctx, now, requiredScope: 'canonical', mutate: (value) => ({ ...value, status: transition.to, grants: ['pause', 'cancel'].includes(event) ? value.grants.map((grant) => grant.revokedAt == null ? { ...grant, revokedAt: now, revokeReason: `task-${event}` } : grant) : value.grants, leases: ['pause', 'cancel'].includes(event) ? value.leases.map((lease) => lease.revokedAt == null ? { ...lease, revokedAt: now, revokeReason: `task-${event}` } : lease) : value.leases, lastTrace: { event: `status-${event}`, nextOwner: 'orchestrator', nextAction: `continue in ${transition.to}`, at: now } }) });
  return { transition, record };
}
function resumeTask({ root, id, data, now }) {
  const current = readTask({ root, taskId: id });
  const event = current.status === 'paused' ? 'resume' : current.status === 'parked' ? 'decision-recorded' : current.status === 'blocked' ? 'blocking-condition-changed' : null;
  if (!event) throw Object.assign(new Error(`Task ${id} is not recoverable from ${current.status}`), { code: 'INVALID_STATUS_TRANSITION' });
  const transition = resolveTaskStatusTransition({ from: current.status, event, facts: { recoverySatisfied: data.recoverySatisfied === true } });
  const nowValue = now ?? new Date().toISOString();
  const ownerHost = data.ownerHost ?? data.host ?? 'orchestrator'; const ownerSession = data.ownerSession ?? data.sessionId ?? `orchestrator:${process.pid}`;
  const acquired = acquireLease({ root, taskId: id, scope: 'canonical', ownerHost, ownerSession, expectedRecordVersion: current.recordVersion, expectedFence: currentFence(current, 'canonical'), renewBefore: data.renewBefore ?? new Date(Date.parse(nowValue) + 30 * 60_000).toISOString(), expiresAt: data.expiresAt ?? new Date(Date.parse(nowValue) + 60 * 60_000).toISOString(), now: nowValue, leaseId: data.leaseId });
  const record = mutateWithLease({ root, taskId: id, context: { leaseId: acquired.lease.leaseId, fenceToken: acquired.lease.fenceToken, leaseScope: 'canonical', expectedRecordVersion: acquired.record.recordVersion, specGeneration: acquired.record.specGeneration, planGeneration: acquired.record.planGeneration }, requiredScope: 'canonical', now: nowValue, mutate: (value) => ({ ...value, status: transition.to, lastTrace: { event: `status-${event}`, nextOwner: 'orchestrator', nextAction: `continue in ${transition.to}`, at: nowValue } }) });
  return { transition, lease: acquired.lease, record };
}
async function run(argv) {
  const parsed = parse(argv); if (parsed.help) { console.log(HELP); return 0; }
  const { command, options } = parsed; if (!command.length) { console.log(HELP); return 0; }
  let data = payload(options); const root = rootFor(options); let name = command.join('.');
  const aliases = { 'spec.decision': 'spec.record-decision', 'grant.intent': 'grant.record-intent', 'grant.record': 'grant.record-intent', 'external.record': 'external.begin' };
  name = aliases[name] ?? name;
  if (name === 'hook' && !options.data && !options.input) {
    const raw = readFileSync(0, 'utf8').trim(); data = raw ? json(raw, 'hook payload') : {};
  }
  if (UNSUPPORTED.has(name)) throw Object.assign(new Error(`${name} is registered but owned by a later story`), { code: 'UNSUPPORTED_COMMAND', details: { command: name, supported: false } });
  if (name === 'setup') return setupProject({ project: options.project ?? process.cwd(), apply: options.apply });
  if (name === 'verify-setup') return verifySetup({ project: options.project ?? process.cwd() });
  if (name === 'rollback') return rollbackProject({ project: options.project ?? process.cwd(), apply: options.apply });
  if (name === 'migrate-v0.2.dry-run') return dryRunMigration(data);
  if (name === 'migrate-v0.2.apply') return applyMigration({ ...data, destinationRoot: data.destinationRoot ?? root });
  if (name === 'migrate-v0.2.rollback') return rollbackMigration({ ...data, root: data.root ?? root });
  if (name === 'task.start') {
    const started = startTask({ root, taskId: requireTask(options, data), request: options.request ?? data.request, requestedBoundary: options.requested_boundary ?? data.requestedBoundary ?? 'local', mode: options.mode ?? data.mode, ownerHost: options.host ?? data.ownerHost, ownerSession: options.session_id ?? data.ownerSession });
    const repo = data.repo ?? options.project ?? process.cwd();
    publishDiscoveryCandidate({ root, taskId: started.record.taskId, repo, worktree: data.worktree ?? repo });
    return started;
  }
  const now = data.now;
  if (name === 'hook') return handleHostEvent({ root, host: options.host ?? data.host, event: options.event ?? data.event, payload: data, now });
  const id = requireTask(options, data);
  if (name === 'task.status') return getStatus({ record: readTask({ root, taskId: id }), candidateIdentity: data.candidateIdentity, environmentIdentity: data.environmentIdentity, now });
  if (name === 'task.bind') return bindSession({ root, sessionId: options.session_id ?? data.sessionId, taskId: id, journalPath: data.journalPath, repo: data.repo ?? options.project ?? process.cwd(), worktree: data.worktree, ownerHost: data.ownerHost ?? options.host });
  if (name === 'task.handoff') return prepareHandoff({ root, taskId: id, context: context(options, data), to: data.to ?? options.to, repo: data.repo ?? options.project ?? process.cwd(), worktree: data.worktree, nextAction: data.nextAction ?? options.next, candidateIdentity: data.candidateIdentity, now });
  if (name === 'task.accept-handoff') return acceptHandoff({ root, taskId: id, handoffId: data.handoffId ?? options.handoff_id, receiver: data.receiver ?? { host: data.host, sessionId: data.sessionId }, repo: data.repo ?? options.project ?? process.cwd(), worktree: data.worktree ?? data.repo ?? options.project ?? process.cwd(), expectedFence: data.expectedFence, now, renewBefore: data.renewBefore, expiresAt: data.expiresAt });
  if (name === 'task.checkpoint') return checkpointTask({ root, taskId: id, context: context(options, data), host: data.host ?? options.host, sessionId: data.sessionId ?? options.session_id, workspace: data.workspace ?? options.project ?? process.cwd(), worktree: data.worktree, eventId: data.eventId ?? options.event_id, reason: data.reason, now });
  if (name === 'task.resume') return resumeTask({ root, id, data, now });
  if (name === 'task.resume-checkpoint') return resumeFromCheckpoint({ root, taskId: id, checkpointArtifact: data.checkpointArtifact, sessionId: data.sessionId ?? options.session_id, workspace: data.workspace ?? options.project ?? process.cwd(), worktree: data.worktree });
  if (['task.pause', 'task.cancel'].includes(name)) return mutateStatus({ root, id, ctx: context(options, data), event: name.slice(5), facts: name.endsWith('cancel') ? { containmentComplete: data.containmentComplete === true } : {}, now: now ?? new Date().toISOString() });
  if (name === 'task.complete') return completeTask({ root, taskId: id, context: context(options, data), candidateIdentity: data.candidateIdentity, environmentIdentity: data.environmentIdentity, worktree: data.worktree ?? options.project ?? process.cwd(), now });
  if (name === 'task.advance' || name === 'phase.advance') return advancePhase({ root, taskId: id, context: context(options, data), targetPhase: data.targetPhase ?? options.target_phase, facts: data.facts ?? {}, now });
  if (name === 'task.renew' || name === 'lease.renew') return renewLease({ root, taskId: id, context: context(options, data), renewBefore: data.renewBefore, expiresAt: data.expiresAt, now });
  if (name === 'spec.record-decision') return recordDecision({ root, taskId: id, context: context(options, data), decision: data.decision ?? data, now });
  if (name === 'spec.record') return recordSpecification({ root, taskId: id, context: context(options, data), specification: data.specification, candidateIdentity: data.candidateIdentity, now });
  if (name === 'spec.self-check') return recordSelfCheck({ root, taskId: id, context: context(options, data), phase: 'spec', report: data.report, candidateIdentity: data.candidateIdentity, now });
  if (name === 'spec.freeze') return freezeSpec({ root, taskId: id, context: context(options, data), specification: data.specification, reviewRefs: data.reviewRefs, candidateIdentity: data.candidateIdentity, now });
  if (name === 'spec.review') return recordReview({ root, taskId: id, context: context(options, data), phase: 'spec', candidateIdentity: data.candidateIdentity, report: data.report, now });
  if (name === 'plan.freeze') return freezePlan({ root, taskId: id, context: context(options, data), plan: data.plan, storyGraph: data.storyGraph, reviewRefs: data.reviewRefs, candidateIdentity: data.candidateIdentity, now });
  if (name === 'plan.record') return recordPlan({ root, taskId: id, context: context(options, data), plan: data.plan, candidateIdentity: data.candidateIdentity, now });
  if (name === 'plan.self-check') return recordSelfCheck({ root, taskId: id, context: context(options, data), phase: 'plan', report: data.report, candidateIdentity: data.candidateIdentity, now });
  if (name === 'plan.ready-stories') return getReadyStories(readTask({ root, taskId: id }));
  if (name === 'plan.claim') return claimStory({ root, taskId: id, context: context(options, data), storyId: data.storyId ?? options.story_id, worker: data.worker, worktree: data.worktree ?? options.project ?? process.cwd(), renewBefore: data.renewBefore, expiresAt: data.expiresAt, leaseId: data.leaseId, now });
  if (name === 'plan.submit') return submitStoryResult({ root, taskId: id, context: context(options, data), storyId: data.storyId ?? options.story_id, candidateIdentity: data.candidateIdentity, resultArtifacts: data.resultArtifacts, now });
  if (name === 'plan.integrate') return recordStoryReceipt({ root, taskId: id, context: context(options, data), storyId: data.storyId ?? options.story_id, candidateIdentity: data.candidateIdentity, receipt: data.receipt, now });
  if (name === 'plan.refresh-receipts') return refreshStoryReceipts({ root, taskId: id, context: context(options, data), candidateIdentity: data.candidateIdentity, receipts: data.receipts, now });
  if (name === 'plan.review') return recordReview({ root, taskId: id, context: context(options, data), phase: 'plan', candidateIdentity: data.candidateIdentity, report: data.report, now });
  if (name === 'code.self-check') return recordSelfCheck({ root, taskId: id, context: context(options, data), phase: 'code', report: data.report, candidateIdentity: data.candidateIdentity, now });
  if (name === 'code.review') return recordReview({ root, taskId: id, context: context(options, data), phase: 'code', candidateIdentity: data.candidateIdentity, report: data.report, now });
  if (name === 'evidence.record') return recordEvidenceReceipt({ root, taskId: id, context: context(options, data), receipt: data.receipt, now });
  if (name === 'evidence.list') return readTask({ root, taskId: id }).evidence;
  if (name === 'grant.record-intent') return recordAuthorizationIntent({ root, taskId: id, context: context(options, data), ...data });
  if (name === 'grant.issue') return issueExecutionGrant({ root, taskId: id, context: context(options, data), ...data });
  if (name === 'grant.revoke') return revokeGrant({ root, taskId: id, context: context(options, data), ...data });
  if (name === 'external.begin') return recordExternalAttempt({ root, taskId: id, context: context(options, data), ...data });
  if (name === 'external.reconcile') return reconcileExternalAttempt({ root, taskId: id, context: context(options, data), ...data });
  if (name === 'uat.record') return runLocalUat({ root, taskId: id, context: context(options, data), ...data, now });
  if (name === 'release.ready' || name === 'release.verify') return assessReleaseReadiness({ record: readTask({ root, taskId: id }), ...data });
  if (name === 'release.execute' || name === 'release.record') return executeRelease({ root, taskId: id, context: context(options, data), candidateIdentity: data.candidateIdentity, grant: data.grant, targetResource: data.targetResource, environmentId: data.environmentId, artifactDigest: data.artifactDigest, provider: { identity: data.providerIdentity ?? 'cli-provider', synthetic: data.synthetic === true, deploy: () => data.providerOutcome ?? { outcome: 'unknown' }, readback: () => data.providerReadback ?? data.providerOutcome ?? { outcome: 'unknown' } }, now });
  if (name === 'release.production-uat') return recordProductionUat({ root, taskId: id, context: context(options, data), ...data, now });
  if (name === 'release.observation') return recordProductionObservation({ root, taskId: id, context: context(options, data), ...data, now });
  if (name === 'repair') return inspectTaskState({ root, taskId: id });
  throw Object.assign(new Error(`Unknown command: ${name}`), { code: 'UNKNOWN_COMMAND', details: { command: name } });
}
const main = async () => { try { const parsed = parse(process.argv.slice(2)); const result = await run(process.argv.slice(2)); if (parsed.help || !parsed.command?.length) return 0; console.log(resultOf(result, parsed.options.task_id)); return 0; } catch (error) { console.log(errorEnvelope(error, (() => { try { return parse(process.argv.slice(2)).options; } catch { return {}; } })())); return 2; } };
function isMain(entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  }
}
if (isMain()) process.exitCode = await main();
export { run };
