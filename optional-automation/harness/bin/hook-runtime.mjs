#!/usr/bin/env node
import { isMain } from './entrypoint.mjs';

import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_RECEIPT = path.join(os.homedir(), ".config", "agent-harness", "hook-receipts", "events.jsonl");
const DECISION_RANK = { allow: 0, ask: 1, deny: 2 };
const CAPTURE_LIMIT = 64 * 1024;

function normalizeDecision(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["deny", "denied", "block", "blocked"].includes(normalized)) return "deny";
  if (["ask", "prompt", "confirm"].includes(normalized)) return "ask";
  if (["allow", "allowed", "approve", "approved", "pass"].includes(normalized)) return "allow";
  return null;
}

export function resolveSafetyDecision(decisions, fallback = "allow") {
  let resolved = normalizeDecision(fallback) ?? "allow";
  for (const value of decisions ?? []) {
    const decision = normalizeDecision(value);
    if (decision && DECISION_RANK[decision] > DECISION_RANK[resolved]) resolved = decision;
  }
  return resolved;
}

export function extractSafetyDecisions(value) {
  const decisions = [];
  const seen = new Set();
  function visit(current) {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (["decision", "permissionDecision"].includes(key)) {
        const decision = normalizeDecision(item);
        if (decision) decisions.push(decision);
      }
      visit(item);
    }
  }
  visit(value);
  return decisions;
}

function decisionsFromOutput(buffer) {
  const text = buffer.toString("utf8").trim();
  if (!text) return [];
  const parsed = [];
  for (const candidate of [text, ...text.split(/\r?\n/)].slice(0, 100)) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // Ordinary lifecycle hooks may write plain text; that is not a decision.
    }
  }
  return parsed.flatMap(extractSafetyDecisions);
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("hook command is required after --");
  const options = {
    host: null,
    event: null,
    commandId: null,
    failurePolicy: null,
    timeoutMs: null,
    receiptFile: process.env.AGENT_HARNESS_HOOK_RECEIPT_FILE ?? DEFAULT_RECEIPT,
    command: argv[separator + 1],
    commandArgs: argv.slice(separator + 2),
  };
  for (let index = 0; index < separator; index += 1) {
    const flag = argv[index];
    if (flag === "--host") options.host = argv[++index];
    else if (flag === "--event") options.event = argv[++index];
    else if (flag === "--command-id") options.commandId = argv[++index];
    else if (flag === "--failure-policy") options.failurePolicy = argv[++index];
    else if (flag === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (flag === "--receipt-file") options.receiptFile = argv[++index];
    else throw new Error(`unknown option: ${flag}`);
  }
  for (const [name, value] of [["host", options.host], ["event", options.event], ["command id", options.commandId]]) {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new Error(`invalid ${name}`);
  }
  if (!["fail-open", "fail-safe"].includes(options.failurePolicy)) throw new Error("--failure-policy must be fail-open or fail-safe");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3_600_000) {
    throw new Error("--timeout-ms must be an integer from 1 to 3600000");
  }
  return options;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function appendCapped(chunks, size, chunk) {
  if (size >= CAPTURE_LIMIT) return size;
  const remaining = CAPTURE_LIMIT - size;
  chunks.push(chunk.subarray(0, remaining));
  return size + Math.min(chunk.length, remaining);
}

async function appendReceipt(file, row) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

export async function writeHookReceipt(metadata, options = {}) {
  const decision = normalizeDecision(metadata.decision);
  if (!decision) throw new Error("invalid receipt decision");
  if (!Number.isInteger(metadata.elapsedMs) || metadata.elapsedMs < 0) throw new Error("invalid receipt elapsedMs");
  const row = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    host: metadata.host,
    event: metadata.event,
    commandId: metadata.commandId,
    elapsedMs: metadata.elapsedMs,
    ...(metadata.timedOut === true ? { timedOut: true } : { exitCode: metadata.exitCode }),
    decision,
    failurePolicy: metadata.failurePolicy,
  };
  for (const [name, value] of [["host", row.host], ["event", row.event], ["command id", row.commandId]]) {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new Error(`invalid receipt ${name}`);
  }
  if (!["fail-open", "fail-safe"].includes(row.failurePolicy)) throw new Error("invalid receipt failure policy");
  if (!row.timedOut && !Number.isInteger(row.exitCode)) throw new Error("receipt needs exitCode or timedOut");
  const receiptFile = options.receiptFile ?? process.env.AGENT_HARNESS_HOOK_RECEIPT_FILE ?? DEFAULT_RECEIPT;
  await appendReceipt(receiptFile, row);
  return row;
}

export async function runHookCommand(options, input) {
  const started = process.hrtime.bigint();
  const stdoutChunks = [];
  let stdoutSize = 0;
  let timedOut = false;
  let spawnError = false;
  let child;
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      child = spawn(options.command, options.commandArgs, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      spawnError = true;
      finish({ code: 127, signal: null });
      return;
    }
    child.stdout.on("data", (chunk) => {
      stdoutSize = appendCapped(stdoutChunks, stdoutSize, chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", () => {
      spawnError = true;
      finish({ code: 127, signal: null });
    });
    child.on("close", (code, signal) => finish({ code, signal }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 100).unref();
    }, options.timeoutMs);
    timer.unref();
    child.on("close", () => clearTimeout(timer));
  });
  const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const exitCode = timedOut ? 124 : Number.isInteger(result.code) ? result.code : 1;
  const executionFailed = timedOut || spawnError || exitCode !== 0;
  const decisions = decisionsFromOutput(Buffer.concat(stdoutChunks));
  if (exitCode === 2 || (executionFailed && options.failurePolicy === "fail-safe")) decisions.push("deny");
  const decision = resolveSafetyDecision(decisions);
  const metadata = {
    host: options.host,
    event: options.event,
    commandId: options.commandId,
    elapsedMs,
    ...(timedOut ? { timedOut: true } : { exitCode }),
    decision,
    failurePolicy: options.failurePolicy,
  };
  let row = metadata;
  try {
    row = await writeHookReceipt(metadata, { receiptFile: options.receiptFile });
  } catch {
    process.stderr.write("hook-runtime receipt degraded\n");
  }
  if (executionFailed && options.failurePolicy === "fail-safe" && !decisionsFromOutput(Buffer.concat(stdoutChunks)).includes("deny")) {
    process.stdout.write(`${JSON.stringify({ decision: "deny", reason: "Hook execution failed under fail-safe policy" })}\n`);
  }
  return { ...row, wrapperExitCode: executionFailed && options.failurePolicy === "fail-safe" ? 2 : exitCode };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outcome = await runHookCommand(options, await readStdin());
  process.exitCode = outcome.wrapperExitCode;
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`hook-runtime failed: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
