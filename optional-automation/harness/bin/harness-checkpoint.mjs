#!/usr/bin/env node
import { isMain } from './entrypoint.mjs';
import { fileURLToPath as processKitFilePath } from 'node:url';

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assertSafePath, getStateRoot } from './task-store.mjs';

const DEFAULT_MANIFEST = processKitFilePath(new URL("../manifest.json", import.meta.url));
const DEFAULT_OUTPUT_ROOT = `${getStateRoot()}/checkpoints`;
const HOSTS = new Set(["claude", "codex", "grok"]);
const REDACTED = "[REDACTED]";
const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key)(?:$|[_-])/i;

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function redactText(text) {
  return text
    .replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b([A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|credential|private[_-]?key)[A-Za-z0-9_.-]*\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/([?&](?:access_token|refresh_token|api_key|token|secret|password|credential)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/(\bhttps?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:phx|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{8,})\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

export function redactSecrets(value, key = "") {
  if (key && SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSecrets(entryValue, entryKey)]),
  );
}

function boundedText(value, label, maxLength, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string${nullable ? " or null" : ""}`);
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  if (value.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  if (value.includes("\0")) throw new Error(`${label} contains a null byte`);
  return redactText(value);
}

function rejectTraversal(value, label) {
  if (value.split(/[\\/]+/).includes("..")) throw new Error(`${label} contains path traversal`);
  return value;
}

function selectAlias(primary, alias, label) {
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new Error(`Conflicting ${label} values`);
  }
  return primary ?? alias;
}

function nonNegativeNumber(value, label, { integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  if (integer && !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function normalizeTimestamp(value) {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("timestamp must be an ISO date string");
  }
  return new Date(value).toISOString();
}

export function normalizeCheckpointInput(raw) {
  const input = requireObject(raw, "checkpoint input");
  const task = input.task === undefined ? {} : requireObject(input.task, "task");
  const counters = requireObject(input.counters, "counters");
  const host = boundedText(input.host, "host", 32).toLowerCase();
  if (!HOSTS.has(host)) throw new Error(`Unsupported host: ${host}`);

  const taskId = rejectTraversal(
    boundedText(selectAlias(input.taskId, task.id, "task id"), "taskId", 128),
    "taskId",
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) {
    throw new Error("taskId may contain only letters, digits, underscores and hyphens");
  }
  const journalPointer = rejectTraversal(
    boundedText(selectAlias(input.journalPointer, task.journal, "journal pointer"), "journalPointer", 4096),
    "journalPointer",
  );
  const lastReceipt = input.lastReceipt === null
    ? null
    : rejectTraversal(boundedText(input.lastReceipt, "lastReceipt", 4096), "lastReceipt");
  if (!Array.isArray(input.remainingSteps)) throw new Error("remainingSteps must be an array");
  if (input.remainingSteps.length > 50) throw new Error("remainingSteps exceeds 50 items");
  const remainingSteps = input.remainingSteps.map((step, index) => boundedText(step, `remainingSteps[${index}]`, 1000));
  const durationAlias = selectAlias(input.durationMinutes, counters.durationMinutes ?? counters.activeMinutes, "duration minutes");

  if (input.force !== undefined && typeof input.force !== "boolean") throw new Error("force must be a boolean");
  return {
    host,
    task: { id: taskId, journal: redactText(journalPointer) },
    goal: boundedText(input.goal, "goal", 2000),
    lastReceipt: lastReceipt === null ? null : redactText(lastReceipt),
    remainingSteps,
    nextSafeAction: boundedText(input.nextSafeAction, "nextSafeAction", 1000),
    counters: {
      toolCalls: nonNegativeNumber(counters.toolCalls, "counters.toolCalls", { integer: true }),
      compactions: nonNegativeNumber(counters.compactions, "counters.compactions", { integer: true }),
    },
    durationMinutes: nonNegativeNumber(durationAlias, "durationMinutes"),
    timestamp: normalizeTimestamp(input.timestamp),
    force: input.force ?? false,
  };
}

function positiveThreshold(value, label, { integer = false } = {}) {
  const normalized = nonNegativeNumber(value, label, { integer });
  if (normalized === 0) throw new Error(`${label} must be greater than zero`);
  return normalized;
}

export function thresholdsFromManifest(manifest) {
  const sessions = requireObject(requireObject(manifest, "manifest").sessions, "manifest.sessions");
  return {
    durationMinutes: positiveThreshold(sessions.checkpointAfterActiveMinutes, "checkpointAfterActiveMinutes"),
    toolCalls: positiveThreshold(sessions.checkpointAfterToolCalls, "checkpointAfterToolCalls", { integer: true }),
    compactions: positiveThreshold(sessions.checkpointAfterCompacts, "checkpointAfterCompacts", { integer: true }),
  };
}

function counterDelta(current, previous) {
  if (previous === undefined || current < previous) return current;
  return current - previous;
}

export function checkpointDecision(current, previous, thresholds, force = false) {
  const previousCounters = previous?.counters;
  const resetDetected = previous !== null && previous !== undefined && (
    current.durationMinutes < previous.durationMinutes
    || current.counters.toolCalls < previousCounters?.toolCalls
    || current.counters.compactions < previousCounters?.compactions
  );
  const deltas = {
    durationMinutes: resetDetected ? current.durationMinutes : counterDelta(current.durationMinutes, previous?.durationMinutes),
    toolCalls: resetDetected ? current.counters.toolCalls : counterDelta(current.counters.toolCalls, previousCounters?.toolCalls),
    compactions: resetDetected ? current.counters.compactions : counterDelta(current.counters.compactions, previousCounters?.compactions),
  };
  const reasons = [];
  if (force) reasons.push("force");
  if (deltas.durationMinutes >= thresholds.durationMinutes) reasons.push("duration");
  if (deltas.toolCalls >= thresholds.toolCalls) reasons.push("tool-calls");
  if (deltas.compactions >= thresholds.compactions) reasons.push("compactions");
  return { write: reasons.length > 0, reasons, deltas };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safePath(root, ...segments) {
  const candidate = path.resolve(root, ...segments);
  if (!isInside(root, candidate)) throw new Error(`Path escapes checkpoint root: ${candidate}`);
  return candidate;
}

async function ensureDirectory(root, name) {
  const lexical = safePath(root, name);
  await mkdir(lexical, { recursive: true, mode: 0o700 });
  const canonical = await realpath(lexical);
  if (!isInside(root, canonical)) throw new Error(`Directory escapes checkpoint root: ${lexical}`);
  return canonical;
}

async function prepareRoot(outputRoot) {
  const absoluteRoot = path.resolve(outputRoot);
  assertSafePath(absoluteRoot, { label: 'checkpoint output root' });
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(absoluteRoot);
  const receiptsDirectory = await ensureDirectory(root, "receipts");
  return { root, receiptsDirectory };
}

async function prepareOutput(outputRoot, host) {
  const { root, receiptsDirectory } = await prepareRoot(outputRoot);
  const hostDirectory = await ensureDirectory(root, host);
  return { root, hostDirectory, receiptsDirectory };
}

async function readRegularFileIfPresent(file) {
  try {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`Refusing non-regular file: ${file}`);
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function parsePrevious(text, host, taskId) {
  if (text === null) return null;
  let checkpoint;
  try {
    checkpoint = JSON.parse(text);
  } catch {
    throw new Error("Existing checkpoint is not valid JSON");
  }
  if (checkpoint?.schemaVersion !== 1 || checkpoint?.host !== host || checkpoint?.task?.id !== taskId) {
    throw new Error("Existing checkpoint identity mismatch");
  }
  nonNegativeNumber(checkpoint.durationMinutes, "existing durationMinutes");
  const counters = requireObject(checkpoint.counters, "existing counters");
  nonNegativeNumber(counters.toolCalls, "existing counters.toolCalls", { integer: true });
  nonNegativeNumber(counters.compactions, "existing counters.compactions", { integer: true });
  return checkpoint;
}

function receiptName(timestamp, host, taskId) {
  const safeTimestamp = timestamp.replace(/[:.]/g, "");
  return `${safeTimestamp}-${host}-${taskId}-${randomUUID()}.json`;
}

export async function writeCheckpoint({ input, manifest, outputRoot = DEFAULT_OUTPUT_ROOT, force = false }) {
  const normalized = normalizeCheckpointInput(redactSecrets(input));
  const thresholds = thresholdsFromManifest(manifest);
  const directories = await prepareOutput(outputRoot, normalized.host);
  const checkpointPath = safePath(directories.hostDirectory, `${normalized.task.id}.json`);
  const previousText = await readRegularFileIfPresent(checkpointPath);
  const previous = parsePrevious(previousText, normalized.host, normalized.task.id);
  const decision = checkpointDecision(normalized, previous, thresholds, force || normalized.force);
  if (!decision.write) {
    return {
      mode: "skipped",
      checkpoint: checkpointPath,
      deltas: decision.deltas,
      thresholds,
    };
  }

  const checkpoint = {
    schemaVersion: 1,
    host: normalized.host,
    task: normalized.task,
    goal: normalized.goal,
    lastReceipt: normalized.lastReceipt,
    remainingSteps: normalized.remainingSteps,
    nextSafeAction: normalized.nextSafeAction,
    counters: normalized.counters,
    durationMinutes: normalized.durationMinutes,
    timestamp: normalized.timestamp,
    triggerReasons: decision.reasons,
  };
  const checkpointText = `${JSON.stringify(checkpoint)}\n`;
  const receiptPath = safePath(
    directories.receiptsDirectory,
    receiptName(normalized.timestamp, normalized.host, normalized.task.id),
  );
  const receipt = {
    schemaVersion: 1,
    operation: "checkpoint-write",
    appliedAt: normalized.timestamp,
    outputRoot: directories.root,
    checkpointPath,
    preHash: previousText === null ? null : hash(previousText),
    postHash: hash(checkpointText),
    previousBase64: previousText === null ? null : Buffer.from(previousText).toString("base64"),
    triggerReasons: decision.reasons,
  };
  await atomicWrite(checkpointPath, checkpointText);
  await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    mode: "written",
    checkpoint: checkpointPath,
    checkpointHash: receipt.postHash,
    receipt: receiptPath,
    reasons: decision.reasons,
    deltas: decision.deltas,
  };
}

async function canonicalReceiptPath(root, receiptPath) {
  const canonical = await realpath(path.resolve(receiptPath));
  if (!isInside(root, canonical)) throw new Error("Rollback receipt is outside checkpoint root");
  const relative = path.relative(root, canonical);
  if (!relative.startsWith(`receipts${path.sep}`)) throw new Error("Rollback receipt is outside the receipts directory");
  return canonical;
}

export async function rollbackCheckpoint({ receiptPath, outputRoot = DEFAULT_OUTPUT_ROOT }) {
  const directories = await prepareRoot(outputRoot);
  const canonicalReceipt = await canonicalReceiptPath(directories.root, receiptPath);
  const receipt = JSON.parse(await readFile(canonicalReceipt, "utf8"));
  if (receipt?.schemaVersion !== 1 || receipt?.operation !== "checkpoint-write") {
    throw new Error("Unsupported rollback receipt");
  }
  if (receipt.outputRoot !== directories.root) throw new Error("Rollback output root mismatch");
  const checkpointPath = path.resolve(receipt.checkpointPath);
  if (!isInside(directories.root, checkpointPath)) throw new Error("Rollback checkpoint path escapes output root");
  const checkpointDirectory = await realpath(path.dirname(checkpointPath));
  if (!isInside(directories.root, checkpointDirectory)) throw new Error("Rollback checkpoint directory escapes output root");
  const current = await readRegularFileIfPresent(checkpointPath);
  if (current === null) throw new Error("Rollback checkpoint is missing");
  if (hash(current) !== receipt.postHash) throw new Error("Rollback refused: checkpoint drifted after write");

  if (receipt.previousBase64 === null) {
    await unlink(checkpointPath);
    return { rollback: "pass", action: "removed", checkpoint: checkpointPath };
  }
  const restored = Buffer.from(receipt.previousBase64, "base64").toString("utf8");
  if (hash(restored) !== receipt.preHash) throw new Error("Rollback payload hash mismatch");
  await atomicWrite(checkpointPath, restored);
  return { rollback: "pass", action: "restored", checkpoint: checkpointPath, restoredHash: receipt.preHash };
}

function parseArgs(argv) {
  const result = {
    force: false,
    rollback: null,
    manifest: process.env.AGENT_HARNESS_MANIFEST ?? DEFAULT_MANIFEST,
    outputRoot: process.env.AGENT_HARNESS_CHECKPOINT_DIR ?? DEFAULT_OUTPUT_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") result.force = true;
    else if (argument === "--rollback") result.rollback = argv[++index];
    else if (argument === "--manifest") result.manifest = argv[++index];
    else if (argument === "--output-dir") result.outputRoot = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.rollback === undefined || result.manifest === undefined || result.outputRoot === undefined) {
    throw new Error("Missing argument value");
  }
  return result;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("JSON checkpoint input is required on stdin");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("stdin is not valid JSON");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rollback) {
    const result = await rollbackCheckpoint({ receiptPath: args.rollback, outputRoot: args.outputRoot });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const [input, manifestText] = await Promise.all([readStdinJson(), readFile(args.manifest, "utf8")]);
  const result = await writeCheckpoint({
    input,
    manifest: JSON.parse(manifestText),
    outputRoot: args.outputRoot,
    force: args.force,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`harness-checkpoint failed: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
