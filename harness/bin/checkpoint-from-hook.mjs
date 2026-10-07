#!/usr/bin/env node
import { isMain } from './entrypoint.mjs';
import { fileURLToPath as processKitFilePath } from 'node:url';

import { readFile } from "node:fs/promises";
import { spawnSync } from 'node:child_process';
import path from "node:path";

import { writeCheckpoint } from "./harness-checkpoint.mjs";
import {
  acknowledgeRuntimeCheckpoint,
  recordRuntimeEvent,
} from "./checkpoint-runtime-state.mjs";

const DEFAULT_MANIFEST = processKitFilePath(new URL("../manifest.json", import.meta.url));

function parseArgs(argv) {
  const result = {
    host: null,
    event: null,
    manifest: process.env.AGENT_HARNESS_MANIFEST ?? DEFAULT_MANIFEST,
    outputRoot: process.env.AGENT_HARNESS_CHECKPOINT_DIR,
    stateRoot: process.env.AGENT_HARNESS_RUNTIME_STATE_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--host") result.host = argv[++index];
    else if (argv[index] === "--event") result.event = argv[++index];
    else if (argv[index] === "--manifest") result.manifest = argv[++index];
    else if (argv[index] === "--output-dir") result.outputRoot = argv[++index];
    else if (argv[index] === "--state-dir") result.stateRoot = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.host) throw new Error("--host is required");
  return result;
}

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function findActiveTask(cwd, payload = {}, traceRoot) {
  const session = payload.session_id || payload.sessionId || payload.thread_id || payload.threadId || payload.conversation_id;
  const resolver = processKitFilePath(new URL('./resolve-current-task.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [resolver, path.resolve(cwd)], { encoding: 'utf8', timeout: 1000,
    env: { ...process.env, ...(session ? { OPERATOR_TRANSPARENCY_SESSION_ID: String(session) } : {}),
      ...(traceRoot ? { AGENT_TASK_TRACE_ROOT: traceRoot } : {}) } });
  if (run.status !== 0) return null;
  let result;
  try { result = JSON.parse(run.stdout); } catch { return null; }
  if (!['ok', 'legacy'].includes(result.status) || !result.journal_path) return null;
  const text = await readIfPresent(result.journal_path);
  return text === null ? null : { id: result.task_id, journal: result.journal_path, text };
}

function sectionParagraph(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return null;
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("#")) break;
    if (!line && collected.length > 0) break;
    if (line) collected.push(line);
  }
  return collected.join(" ") || null;
}

export function summarizeJournal(task) {
  const remaining = task.text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s*\[\s\]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean)
    .slice(0, 50);
  const goal = sectionParagraph(task.text, "Outcome")
    ?? sectionParagraph(task.text, "Goal")
    ?? task.text.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith("#"))?.trim()
    ?? `Continue ${task.id}`;
  const nextLine = [...task.text.matchAll(
    /^\s*(?:Next move|Next step|Следующий ход|Следующий шаг)\s*:\s*(.+)$/gim,
  )].at(-1)?.[1]?.trim();
  const receiptMatches = [...task.text.matchAll(/\/Users\/[^\s`"']*receipt[^\s`"']*\.json/g)];
  return {
    goal: goal.slice(0, 2000),
    lastReceipt: receiptMatches.at(-1)?.[0] ?? null,
    remainingSteps: remaining,
    nextSafeAction: (nextLine ?? remaining[0] ?? "Open the active task journal and continue from the last verified step").slice(0, 1000),
  };
}

function eventFromPayload(payload) {
  return payload?.hook_event_name
    ?? payload?.hookEventName
    ?? payload?.event_name
    ?? payload?.eventName
    ?? payload?.event;
}

function resolveEvent(explicitEvent, payload) {
  const payloadEvent = eventFromPayload(payload);
  if (explicitEvent && payloadEvent
    && String(explicitEvent).replace(/[^A-Za-z]/g, "").toLowerCase()
      !== String(payloadEvent).replace(/[^A-Za-z]/g, "").toLowerCase()) {
    throw new Error("hook event disagrees with payload");
  }
  return explicitEvent ?? payloadEvent ?? null;
}

export async function checkpointFromHook({ host, event, payload, manifest, outputRoot, stateRoot, now }) {
  const cwd = payload?.cwd ?? payload?.workspaceRoot ?? payload?.workspace_root ?? process.cwd();
  const task = await findActiveTask(cwd, payload);
  if (!task) return { mode: "skipped", reason: "no-active-task" };
  const runtimeEvent = resolveEvent(event, payload);
  if (!runtimeEvent) return { mode: "skipped", reason: "unknown-hook-event" };
  const runtime = await recordRuntimeEvent({
    host,
    taskId: task.id,
    event: runtimeEvent,
    payload,
    ...(stateRoot ? { stateRoot } : {}),
    ...(now ? { now } : {}),
  });
  if (runtime.duplicate) return { mode: "skipped", reason: "duplicate-hook-event" };
  if (!runtime.safeToCheckpoint) {
    return { mode: "skipped", reason: "unsafe-in-flight-tool", inFlight: runtime.inFlight };
  }
  const summary = summarizeJournal(task);
  const result = await writeCheckpoint({
    input: {
      host,
      taskId: task.id,
      journalPointer: task.journal,
      ...summary,
      counters: runtime.counters,
      durationMinutes: runtime.durationMinutes,
      timestamp: runtime.timestamp,
    },
    manifest,
    ...(outputRoot ? { outputRoot } : {}),
    force: runtime.forceCheckpoint,
  });
  if (result.mode === "written" && runtime.forceCheckpoint) {
    await acknowledgeRuntimeCheckpoint({
      host,
      taskId: task.id,
      payload,
      throughCompaction: runtime.counters.compactions,
      ...(stateRoot ? { stateRoot } : {}),
      now: runtime.timestamp,
    });
  }
  return result;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [payload, manifest] = await Promise.all([
    readStdin(),
    readFile(args.manifest, "utf8").then(JSON.parse),
  ]);
  const result = await checkpointFromHook({
    host: args.host,
    event: args.event,
    payload,
    manifest,
    outputRoot: args.outputRoot,
    stateRoot: args.stateRoot,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    // Hook integration is fail-open. The host records the degraded checkpoint.
    process.stderr.write(`checkpoint-from-hook degraded: ${error?.message ?? String(error)}\n`);
    process.exitCode = 0;
  });
}
