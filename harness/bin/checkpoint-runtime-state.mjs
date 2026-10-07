#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_STATE_ROOT = path.join(os.homedir(), ".config", "agent-harness", "runtime-state");
const HOSTS = new Set(["claude", "codex", "grok"]);

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeNow(now) {
  const value = now ?? new Date().toISOString();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("now must be an ISO date string");
  return new Date(value).toISOString();
}

function normalizeIdentity(host, taskId, payload) {
  const normalizedHost = String(host ?? "").toLowerCase();
  if (!HOSTS.has(normalizedHost)) throw new Error(`unsupported host: ${normalizedHost}`);
  if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)) {
    throw new Error("invalid taskId");
  }
  const sessionId = payload?.session_id
    ?? payload?.sessionId
    ?? payload?.thread_id
    ?? payload?.threadId
    ?? payload?.conversation_id
    ?? payload?.conversationId
    ?? `task:${taskId}:${payload?.cwd ?? payload?.workspaceRoot ?? payload?.workspace_root ?? "unknown"}`;
  return { host: normalizedHost, taskId, sessionHash: sha256(sessionId) };
}

async function ensureDirectory(directory) {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`refusing unsafe directory: ${directory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
  return realpath(directory);
}

async function prepareStatePath(stateRoot, identity) {
  const root = await ensureDirectory(path.resolve(stateRoot));
  const hostDirectory = await ensureDirectory(path.join(root, identity.host));
  if (!isInside(root, hostDirectory)) throw new Error("runtime state directory escapes root");
  const stateFile = path.join(hostDirectory, `${identity.taskId}-${identity.sessionHash}.json`);
  if (!isInside(root, stateFile)) throw new Error("runtime state file escapes root");
  return { root, stateFile };
}

async function readState(file) {
  try {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`refusing unsafe runtime state file: ${file}`);
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file, value) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function withLock(stateFile, operation) {
  const lock = `${stateFile}.lock`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        return await operation();
      } finally {
        await rmdir(lock).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("runtime state lock timeout");
}

function initialState(identity, timestamp) {
  return {
    schemaVersion: 1,
    ...identity,
    sessionStartedAt: timestamp,
    counters: { toolCalls: 0, compactions: 0 },
    inFlightToolIds: [],
    completedToolIds: [],
    completedCompactIds: [],
    pendingPreCompact: false,
    updatedAt: timestamp,
  };
}

function canonicalEvent(value) {
  const normalized = String(value).replace(/[^A-Za-z]/g, "").toLowerCase();
  const events = {
    sessionstart: "SessionStart",
    pretooluse: "PreToolUse",
    posttooluse: "PostToolUse",
    posttoolusefailure: "PostToolUseFailure",
    precompact: "PreCompact",
    userpromptsubmit: "UserPromptSubmit",
    stop: "Stop",
  };
  const event = events[normalized];
  if (!event) throw new Error(`unsupported runtime event: ${value}`);
  return event;
}

function toolEventId(payload) {
  const value = payload?.tool_use_id
    ?? payload?.toolUseId
    ?? payload?.tool_call_id
    ?? payload?.toolCallId
    ?? payload?.call_id
    ?? payload?.callId
    ?? payload?.tool?.id;
  return value === undefined || value === null || value === "" ? null : sha256(value);
}

function compactEventId(payload) {
  const value = payload?.compact_id
    ?? payload?.compactId
    ?? payload?.hook_event_id
    ?? payload?.hookEventId
    ?? payload?.event_id
    ?? payload?.eventId;
  return value === undefined || value === null || value === "" ? null : sha256(value);
}

function appendBounded(values, value, limit = 256) {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function applyToolEvent(state, event, payload) {
  const id = toolEventId(payload);
  if (event === "PreToolUse") {
    if (id && (state.inFlightToolIds.includes(id) || state.completedToolIds.includes(id))) return true;
    appendBounded(state.inFlightToolIds, id ?? `anonymous-${randomUUID()}`);
    return false;
  }
  if (!["PostToolUse", "PostToolUseFailure"].includes(event)) return false;
  if (id && state.completedToolIds.includes(id)) return true;
  if (id) {
    const index = state.inFlightToolIds.indexOf(id);
    if (index >= 0) state.inFlightToolIds.splice(index, 1);
    appendBounded(state.completedToolIds, id);
  } else if (state.inFlightToolIds.length > 0) {
    state.inFlightToolIds.shift();
  }
  state.counters.toolCalls += 1;
  return false;
}

function applyCompactEvent(state, event, payload) {
  if (event !== "PreCompact") return false;
  const id = compactEventId(payload);
  if (id && state.completedCompactIds.includes(id)) return true;
  state.counters.compactions += 1;
  state.pendingPreCompact = true;
  if (id) appendBounded(state.completedCompactIds, id);
  return false;
}

function validateState(state, identity) {
  if (state?.schemaVersion !== 1
    || state.host !== identity.host
    || state.taskId !== identity.taskId
    || state.sessionHash !== identity.sessionHash) {
    throw new Error("runtime state identity mismatch");
  }
  if (Number.isNaN(Date.parse(state.sessionStartedAt))) throw new Error("runtime state start time is invalid");
  if (!Number.isInteger(state.counters?.toolCalls) || state.counters.toolCalls < 0) throw new Error("invalid toolCalls");
  if (!Number.isInteger(state.counters?.compactions) || state.counters.compactions < 0) throw new Error("invalid compactions");
  for (const key of ["inFlightToolIds", "completedToolIds", "completedCompactIds"]) {
    if (!Array.isArray(state[key]) || state[key].some((item) => typeof item !== "string")) {
      throw new Error(`invalid ${key}`);
    }
  }
  if (typeof state.pendingPreCompact !== "boolean") throw new Error("invalid pendingPreCompact");
  return state;
}

export async function recordRuntimeEvent({
  host,
  taskId,
  event,
  payload = {},
  stateRoot = process.env.AGENT_HARNESS_RUNTIME_STATE_DIR ?? DEFAULT_STATE_ROOT,
  now,
}) {
  const normalizedEvent = canonicalEvent(event);
  const timestamp = normalizeNow(now);
  const identity = normalizeIdentity(host, taskId, payload);
  const { stateFile } = await prepareStatePath(stateRoot, identity);
  return withLock(stateFile, async () => {
    const current = await readState(stateFile);
    const state = current === null ? initialState(identity, timestamp) : validateState(current, identity);
    const duplicate = applyToolEvent(state, normalizedEvent, payload)
      || applyCompactEvent(state, normalizedEvent, payload);
    state.updatedAt = timestamp;
    await atomicWrite(stateFile, state);
    return {
      stateFile,
      timestamp,
      counters: { ...state.counters },
      durationMinutes: Math.max(0, (Date.parse(timestamp) - Date.parse(state.sessionStartedAt)) / 60_000),
      inFlight: state.inFlightToolIds.length,
      safeToCheckpoint: state.inFlightToolIds.length === 0,
      forceCheckpoint: state.pendingPreCompact && state.inFlightToolIds.length === 0,
      duplicate,
    };
  });
}

export async function acknowledgeRuntimeCheckpoint({
  host,
  taskId,
  payload = {},
  throughCompaction,
  stateRoot = process.env.AGENT_HARNESS_RUNTIME_STATE_DIR ?? DEFAULT_STATE_ROOT,
  now,
}) {
  if (!Number.isInteger(throughCompaction) || throughCompaction < 0) {
    throw new Error("throughCompaction must be a non-negative integer");
  }
  const timestamp = normalizeNow(now);
  const identity = normalizeIdentity(host, taskId, payload);
  const { stateFile } = await prepareStatePath(stateRoot, identity);
  return withLock(stateFile, async () => {
    const current = await readState(stateFile);
    if (current === null) throw new Error("runtime state is missing");
    const state = validateState(current, identity);
    if (state.counters.compactions <= throughCompaction) state.pendingPreCompact = false;
    state.updatedAt = timestamp;
    await atomicWrite(stateFile, state);
    return { acknowledged: !state.pendingPreCompact, stateFile };
  });
}
