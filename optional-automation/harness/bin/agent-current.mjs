#!/usr/bin/env node
// agent-current.mjs — parse .agent/CURRENT (plain id or JSON object)
// Exports: parseAgentCurrent(text), VERBS

export const VERBS = new Set(['active', 'paused', 'blocked', 'handoff', 'done']);

/**
 * parseAgentCurrent(text)
 * Returns: { format: "plain"|"json"|"invalid", top: object|null, parked: object[], warnings: string[] }
 *
 * top always has: { task_id, status, ... rest of JSON fields }
 * status: one of VERBS, or "unknown" (for missing/invalid)
 */
export function parseAgentCurrent(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return { format: 'invalid', top: null, parked: [], warnings: ['empty input'] };

  // Check if it looks like JSON
  if (!t.startsWith('{')) {
    // Plain task id
    const task_id = t.split('\n')[0].trim();
    if (!task_id) return { format: 'invalid', top: null, parked: [], warnings: ['empty input'] };
    return {
      format: 'plain',
      top: { task_id, status: 'unknown' },
      parked: [],
      warnings: [],
    };
  }

  // JSON branch
  let obj;
  try {
    obj = JSON.parse(t);
  } catch (e) {
    return { format: 'invalid', top: null, parked: [], warnings: [`invalid JSON: ${e.message}`] };
  }

  if (!obj || typeof obj !== 'object') {
    return { format: 'invalid', top: null, parked: [], warnings: ['JSON root is not an object'] };
  }

  const warnings = [];
  const parked = Array.isArray(obj.parked) ? obj.parked.map(p => normalizeEntry(p, warnings)) : [];
  const top = normalizeEntry(obj, warnings);

  return { format: 'json', top, parked, warnings };
}

function normalizeEntry(obj, warnings) {
  const entry = { ...obj };
  delete entry.parked; // don't recurse parked inside parked

  if (!entry.task_id) {
    warnings.push('entry missing task_id');
  }

  if (entry.status === undefined || entry.status === null) {
    entry.status = 'unknown';
  } else if (!VERBS.has(entry.status)) {
    warnings.push(`unknown status: "${entry.status}"`);
    entry.status = 'unknown';
  }

  if ((obj.status === 'blocked' || obj.status === 'handoff') && !obj.by) {
    warnings.push(`"${obj.status}" requires "by" field`);
  }

  return entry;
}
