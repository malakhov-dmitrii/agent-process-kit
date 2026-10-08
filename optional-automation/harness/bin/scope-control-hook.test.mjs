import { fileURLToPath as processKitFilePath } from 'node:url';
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyScopeStop,
  extractDepthLock,
  extractScopeReceipt,
  renderDepthContext,
} from "./scope-control-hook.mjs";

const requiredJournal = `# Task
Task-ID: loop-guard-task

## Depth lock

Scope control: required
Approved depth: smallest maintainable patch
Included cleanup: none
Non-goals: adjacent refactors
Deferred hardening: observability expansion
Exceptions: unmet approved DoD, security, data integrity, or correctness only

## Step 1

Unrelated step text.
`;

const validReceipt = `
## Scope receipt

Depth lock: respected
Unapproved scope deviations: 0
Deferred improvements: none
Scope review: passed
`;

test("extracts the complete required depth lock", () => {
  const lock = extractDepthLock(requiredJournal);
  assert.equal(lock.required, true);
  assert.equal(lock.approvedDepth, "smallest maintainable patch");
  assert.equal(lock.includedCleanup, "none");
  assert.equal(lock.nonGoals, "adjacent refactors");
  assert.equal(lock.deferredHardening, "observability expansion");
});

test("renders only the active depth lock", () => {
  const context = renderDepthContext(extractDepthLock(requiredJournal));
  assert.match(context, /^Depth lock active:/);
  assert.match(context, /Approved depth: smallest maintainable patch/);
  assert.doesNotMatch(context, /Unrelated step text/);
});

test("blocks Stop when required scope control has no receipt", () => {
  assert.deepEqual(classifyScopeStop(requiredJournal), {
    decision: "block",
    reason: "Scope control requires a completion receipt",
  });
});

test("allows Stop with a valid scope receipt", () => {
  assert.deepEqual(classifyScopeStop(requiredJournal + validReceipt), {
    decision: "allow",
  });
});

test("blocks Stop when the receipt reports a deviation", () => {
  const journal = requiredJournal + validReceipt.replace(
    "Unapproved scope deviations: 0",
    "Unapproved scope deviations: 1"
  );
  assert.deepEqual(classifyScopeStop(journal), {
    decision: "block",
    reason: "Scope control found an unapproved scope deviation",
  });
});

test("allows Stop for an unscoped journal", () => {
  assert.deepEqual(classifyScopeStop("# Small task\n"), {
    decision: "allow",
  });
});

test("extracts a valid receipt", () => {
  assert.deepEqual(extractScopeReceipt(validReceipt), {
    depthLock: "respected",
    unapprovedScopeDeviations: 0,
    deferredImprovements: "none",
    scopeReview: "passed",
  });
});

test("Stop allows a re-entered stop even when the scope receipt is missing", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "scope-loop-"));
  try {
    spawnSync("git", ["init", "-q", repo]);
    mkdirSync(join(repo, ".agent", "tasks"), { recursive: true });
    writeFileSync(join(repo, ".agent", "CURRENT"), "loop-guard-task\n");
    writeFileSync(join(repo, ".agent", "tasks", "loop-guard-task.md"), requiredJournal);
    const env = { ...process.env, CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_SESSION_ID: "", OPERATOR_TRANSPARENCY_SESSION_ID: "" };
    const run = (payload) => spawnSync(process.execPath, [processKitFilePath(new URL("./scope-control-hook.mjs", import.meta.url)), "--event", "Stop"], {
      input: JSON.stringify({ cwd: repo, ...payload }), encoding: "utf8", env, cwd: repo,
    }).stdout.trim();
    assert.match(run({}), /"decision":"block"/);
    assert.equal(run({ stop_hook_active: true }), "{}");
    assert.equal(run({ stopHookActive: true }), "{}");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
