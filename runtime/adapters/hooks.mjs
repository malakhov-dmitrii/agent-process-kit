import { createCandidateIdentity } from '../core/candidate.mjs';
import { canComplete } from '../core/eligibility.mjs';
import { readTask } from '../core/store.mjs';
import { checkpointTask } from './checkpoint.mjs';
import { resolveCurrentTask } from './sessions.mjs';

const COMPLETE = /(?:^|\n)Task complete:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\s|$)/;
const HOSTS = new Set(['codex', 'claude']);
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

function resolutionFor(root, payload) {
  return resolveCurrentTask({
    root,
    sessionId: payload.sessionId,
    workspace: payload.workspace,
    repo: payload.repo ?? payload.workspace,
  });
}

export function handleHostEvent({ root, host, event, payload = {}, now = new Date().toISOString() }) {
  if (!HOSTS.has(host)) throw new TypeError(`Unsupported host ${host}`);
  if (event === 'SubagentStop') return { decision: 'allow', reason: 'subagent-result-does-not-complete-parent' };
  const resolution = resolutionFor(root, payload);
  if (CONTEXT_EVENTS.has(event)) return { decision: 'allow', resolution };
  if (event === 'PreCompact') {
    if (resolution.status !== 'exact') return { decision: 'allow', resolution, checkpoint: null };
    if (!payload.mutationContext) return { decision: 'block', reason: 'checkpoint-context-missing', resolution };
    const saved = checkpointTask({
      root,
      taskId: resolution.taskId,
      context: payload.mutationContext,
      host,
      sessionId: payload.sessionId,
      workspace: payload.workspace,
      worktree: payload.worktree ?? resolution.worktree ?? payload.workspace,
      eventId: payload.eventId,
      reason: 'pre-compact',
      now,
    });
    return { decision: 'allow', resolution, checkpoint: {
      artifactId: saved.artifact.artifactId,
      checkpointGeneration: saved.record.checkpointGeneration,
      idempotent: saved.idempotent,
    } };
  }
  if (event === 'Stop') {
    if (payload.stopHookActive) return { decision: 'allow', reason: 'block-once' };
    const marker = String(payload.lastAssistantMessage ?? '').match(COMPLETE);
    if (!marker) return { decision: 'allow', reason: 'no-overall-completion-marker', resolution };
    if (resolution.status !== 'exact' || marker[1] !== resolution.taskId) {
      return { decision: 'block', reason: 'completion-task-not-exact', resolution };
    }
    const record = readTask({ root, taskId: resolution.taskId });
    const candidateIdentity = createCandidateIdentity({
      repoPath: payload.worktree ?? resolution.worktree ?? payload.workspace,
      taskId: record.taskId,
      specGeneration: record.specGeneration,
      planGeneration: record.planGeneration,
    });
    const verdict = canComplete({ record, candidateIdentity, environmentIdentity: payload.environmentIdentity, now });
    return verdict.eligible
      ? { decision: 'allow', reason: 'completion-eligible', resolution }
      : { decision: 'block', reason: 'completion-ineligible', resolution, blockers: verdict.blockers };
  }
  throw new TypeError(`Unsupported host event ${event}`);
}
