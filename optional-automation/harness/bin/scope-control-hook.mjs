#!/usr/bin/env node
import { isMain } from './entrypoint.mjs';
import { fileURLToPath as processKitFilePath } from 'node:url';

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { completionRule } from './stop-receipt-gate.mjs';

const RESOLVER = processKitFilePath(new URL('./resolve-current-task.mjs', import.meta.url));

function section(markdown, heading) {
  const lines = String(markdown || "").split("\n");
  const expected = `## ${heading}`.toLowerCase();
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === expected
  );
  if (start < 0) return null;
  const next = lines
    .slice(start + 1)
    .findIndex((line) => /^##\s+/.test(line));
  const end = next < 0 ? lines.length : start + 1 + next;
  return lines.slice(start + 1, end);
}

function field(lines, name) {
  if (!lines) return "";
  const prefix = `${name}:`.toLowerCase();
  const line = lines.find((candidate) =>
    candidate.trim().toLowerCase().startsWith(prefix)
  );
  return line?.trim().slice(prefix.length).trim() || "";
}

export function extractDepthLock(markdown) {
  const lines = section(markdown, "Depth lock");
  const scopeControl = field(lines, "Scope control");
  return {
    required: scopeControl.toLowerCase() === "required",
    approvedDepth: field(lines, "Approved depth"),
    includedCleanup: field(lines, "Included cleanup"),
    nonGoals: field(lines, "Non-goals"),
    deferredHardening: field(lines, "Deferred hardening"),
    exceptions: field(lines, "Exceptions"),
  };
}

export function extractScopeReceipt(markdown) {
  const lines = section(markdown, "Scope receipt");
  const deviations = field(lines, "Unapproved scope deviations");
  return {
    depthLock: field(lines, "Depth lock"),
    unapprovedScopeDeviations: /^\d+$/.test(deviations)
      ? Number(deviations)
      : null,
    deferredImprovements: field(lines, "Deferred improvements"),
    scopeReview: field(lines, "Scope review"),
  };
}

export function renderDepthContext(lock) {
  if (!lock?.required) return "";
  return [
    "Depth lock active:",
    "Scope control: required",
    `Approved depth: ${lock.approvedDepth}`,
    `Included cleanup: ${lock.includedCleanup}`,
    `Non-goals: ${lock.nonGoals}`,
    `Deferred hardening: ${lock.deferredHardening}`,
    `Exceptions: ${lock.exceptions}`,
    "Before expanding scope, name the blocked requirement and test the simpler workaround first.",
  ].join("\n");
}

export function classifyScopeStop(markdown) {
  const lock = extractDepthLock(markdown);
  if (!lock.required) return { decision: "allow" };
  const receipt = extractScopeReceipt(markdown);
  if (
    receipt.depthLock === "" ||
    receipt.unapprovedScopeDeviations === null ||
    receipt.deferredImprovements === "" ||
    receipt.scopeReview === ""
  ) {
    return {
      decision: "block",
      reason: "Scope control requires a completion receipt",
    };
  }
  if (receipt.unapprovedScopeDeviations !== 0) {
    return {
      decision: "block",
      reason: "Scope control found an unapproved scope deviation",
    };
  }
  if (
    receipt.depthLock !== "respected" ||
    receipt.scopeReview !== "passed"
  ) {
    return {
      decision: "block",
      reason: "Scope control completion receipt is invalid",
    };
  }
  return { decision: "allow" };
}

function parseArgs(argv) {
  const index = argv.indexOf("--event");
  return { event: index >= 0 ? argv[index + 1] : "" };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function resolveJournal(payload) {
  const sessionId =
    payload.session_id ||
    payload.sessionId ||
    payload.thread_id ||
    payload.threadId ||
    payload.conversation_id ||
    "";
  const cwd =
    payload.cwd ||
    payload.workingDirectory ||
    payload.workspace?.cwd ||
    process.cwd();
  const result = spawnSync(process.execPath, [RESOLVER, cwd], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(sessionId
        ? { OPERATOR_TRANSPARENCY_SESSION_ID: String(sessionId) }
        : {}),
    },
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const resolved = JSON.parse(result.stdout);
  if (resolved.status !== "ok" && resolved.status !== "legacy") return null;
  return resolved.journal_path || null;
}

async function main() {
  const { event } = parseArgs(process.argv.slice(2));
  try {
    const payload = JSON.parse((await readStdin()) || "{}");
    // Block once per turn: a Stop re-entered after our own block must pass, or a missing receipt loops forever.
    if (event === "Stop" && (payload.stop_hook_active || payload.stopHookActive)) {
      process.stdout.write("{}\n");
      return;
    }
    if (event === 'Stop') {
      const completion = completionRule(payload.last_assistant_message || payload.lastAssistantMessage || '', payload);
      if (completion.block) {
        process.stdout.write(`${JSON.stringify({ decision: 'block', reason: completion.reason })}\n`);
        return;
      }
    }
    const journalPath = resolveJournal(payload);
    if (!journalPath) {
      process.stdout.write("{}\n");
      return;
    }
    const markdown = readFileSync(journalPath, "utf8");
    if (event === "Stop") {
      process.stdout.write(`${JSON.stringify(classifyScopeStop(markdown))}\n`);
      return;
    }
    if (["SessionStart", "UserPromptSubmit", "PreCompact"].includes(event)) {
      const context = renderDepthContext(extractDepthLock(markdown));
      if (context) process.stdout.write(`${context}\n`);
      else process.stdout.write("{}\n");
      return;
    }
    process.stdout.write("{}\n");
  } catch {
    process.stderr.write("scope-control hook degraded; allowing lifecycle event\n");
    process.stdout.write("{}\n");
  }
}

if (isMain(import.meta.url)) {
  main();
}
