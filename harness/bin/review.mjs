#!/usr/bin/env node
import { isMain } from './entrypoint.mjs';
// bin/review.mjs — review wrapper (L2)
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { acquireHarnessctlLock } from "./harnessctl-state.mjs";
import { getStateRoot } from './task-store.mjs';

const HARNESS = path.resolve(fileURLToPath(import.meta.url), "../..");

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

export function buildCodexArgv({ slug, harness, outPath, dir, skipGitRepoCheck = false }) {
  const h = harness ?? HARNESS;
  const argv = [
    "exec",
    "-m", slug,
    "-c", 'model_reasoning_effort="max"',
    "-s", "read-only",
    "--disable", "hooks",
    "--ephemeral",
    "--color", "never",
    "--output-schema", path.join(h, "schemas/review.schema.json"),
    "-o", outPath,
    "-C", dir,
  ];
  if (skipGitRepoCheck) argv.push("--skip-git-repo-check");
  argv.push("-");
  return argv;
}

export function buildPrompt({ round, kind, task, target, dir, notes }) {
  const targetLine = kind === "code"
    ? `Review \`git diff ${target}\` in ${dir}.`
    : `Read the plan at ${target}.`;
  const lines = [
    `You are a read-only reviewer. Round ${round} of 2 for the ${kind} review of task ${task}.`,
    `Target: ${targetLine}`,
    "Defect = only: a duplicate action (send, charge or write), lost data, a stuck state with no recovery,",
    "a security hole, or a broken production path. Name the class first in `why`.",
    "Expansion = anything else (refactor, polish, more tests, adjacent bugs). It never blocks.",
  ];
  if (round >= 2) lines.push("Round 2: report defects only; leave expansions out.");
  lines.push("Do not modify files. Return only the JSON object required by the schema.");
  if (notes) lines.push("", notes);
  return lines.join("\n");
}

/**
 * nextRound(rounds, kind, forceReason?) → {n, refused, reason?}
 * rounds: array of round records; only 'done' rounds count toward cap.
 */
export function nextRound(rounds, kind, forceReason) {
  // readStateFile already turned dead-pid "running" rounds into "abandoned", so this one is live.
  const running = rounds.find((r) => r.status === "running");
  if (running) {
    return { refused: true, reason: `review: ${kind} review of this task is already running (pid ${running.pid}); let it finish` };
  }
  const doneCount = rounds.filter((r) => r.status === "done").length;
  if (doneCount >= 2 && !forceReason) {
    return {
      refused: true,
      reason: `review: ${kind} round ${doneCount + 1} refused; cap is 2 (core.md Review caps). Fix blockers test-first, or pass --force-round "<reason>"`,
    };
  }
  return { n: doneCount + 1, refused: false };
}

/**
 * normalizeReview(raw, round) → {valid, verdict, blockers, droppedExpansions, summary}
 */
export function normalizeReview(raw, round) {
  if (!raw || typeof raw !== "object") return { valid: false, reason: "null or non-object" };
  if (!["APPROVE", "REJECT"].includes(raw.verdict)) return { valid: false, reason: "bad verdict" };
  if (typeof raw.summary !== "string") return { valid: false, reason: "missing summary" };
  if (!Array.isArray(raw.blockers)) return { valid: false, reason: "missing blockers" };

  for (const b of raw.blockers) {
    if (!["defect", "expansion"].includes(b.kind)) return { valid: false, reason: `bad blocker kind: ${b.kind}` };
    if (typeof b.file !== "string") return { valid: false, reason: "blocker missing file" };
    if (typeof b.why !== "string" || b.why.trim() === "") return { valid: false, reason: "blocker empty why" };
  }

  let blockers = [...raw.blockers];
  let droppedExpansions = 0;
  if (round >= 2) {
    droppedExpansions = blockers.filter((b) => b.kind === "expansion").length;
    blockers = blockers.filter((b) => b.kind !== "expansion");
  }

  const hasDefect = blockers.some((b) => b.kind === "defect");
  const verdict = hasDefect ? "REJECT" : "APPROVE";
  return { valid: true, verdict, blockers, droppedExpansions, summary: raw.summary };
}

function processIsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}

/** Read state file; heal dead-pid running rounds in place. Returns null if missing. */
export async function readStateFile(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const state = JSON.parse(text);
  // Heal dead-pid running rounds
  for (const kind of ["plan", "code"]) {
    for (const round of state.rounds?.[kind] ?? []) {
      if (round.status === "running" && round.pid != null && !processIsAlive(round.pid)) {
        round.status = "abandoned";
      }
    }
  }
  return state;
}

/** Atomic write of state file (mode 0600). */
export async function writeStateFile(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) { process.stdout.write("usage: review.mjs --kind plan|code --target <file|git-range> [--task <id>] [-C <dir>] [--model <slug>] [--notes <file>] [--force-round \"<reason>\"] [--timeout-min 40]\n"); return 0; }
  let kind, target, taskId, dir = process.cwd(), model, notesFile, forceReason, timeoutMin = 40;

  const envHarness = process.env.REVIEW_HARNESS ?? HARNESS;
  const stateDir = process.env.REVIEW_STATE_DIR ?? path.join(getStateRoot(), 'reviews');
  const codexBin = process.env.REVIEW_CODEX_BIN ?? "codex";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--kind") kind = args[++i];
    else if (args[i] === "--target") target = args[++i];
    else if (args[i] === "--task") taskId = args[++i];
    else if (args[i] === "-C") dir = path.resolve(args[++i]);
    else if (args[i] === "--model") model = args[++i];
    else if (args[i] === "--notes") notesFile = args[++i];
    else if (args[i] === "--force-round") forceReason = args[++i];
    else if (args[i] === "--timeout-min") timeoutMin = parseInt(args[++i], 10);
  }

  if (!kind || !["plan", "code"].includes(kind)) {
    process.stderr.write("review: --kind plan|code is required\n");
    process.exit(2);
  }
  if (!target) {
    process.stderr.write("review: --target is required\n");
    process.exit(2);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId || '')) {
    process.stderr.write("review: no active task (fix: pass --task <id>)\n");
    process.exit(2);
  }

  // Resolve model from manifest
  if (!model) {
    try {
      const manifest = JSON.parse(await readFile(path.join(envHarness, "manifest.json"), "utf8"));
      model = manifest.modelRouting?.secondOpinion;
    } catch {
      model = null;
    }
  }
  if (!model) {
    process.stderr.write('review: pass --model explicitly or configure modelRouting.secondOpinion; no paid model is selected automatically\n');
    process.exit(2);
  }

  // Preflight: check model exists in codex catalog with max reasoning
  const debugResult = spawnSync(codexBin, ["debug", "models"], { encoding: "utf8", timeout: 30_000 });
  if (debugResult.status === 0) {
    let catalog;
    try { catalog = JSON.parse(debugResult.stdout); } catch { catalog = null; }
    // `codex debug models` prints {"models":[{"slug","supported_reasoning_levels":[{"effort"}]}]}
    const list = Array.isArray(catalog) ? catalog : catalog?.models;
    if (Array.isArray(list)) {
      const entry = list.find((m) => (m.slug ?? m.id) === model);
      if (!entry) {
        process.stderr.write(`review: model ${model} missing from codex catalog (fix: update manifest.modelRouting.secondOpinion)\n`);
        process.exit(3);
      }
      if (!(entry.supported_reasoning_levels ?? []).map((l) => l?.effort ?? l).includes("max")) {
        process.stderr.write(`review: model ${model} does not support reasoning level max\n`);
        process.exit(3);
      }
    }
  }

  const stateFile = path.join(stateDir, `${taskId}.json`);
  const lockFile = path.join(stateDir, `${taskId}.lock`);

  await mkdir(stateDir, { recursive: true });

  // Acquire lock for state read-modify-write
  let release;
  try {
    release = await acquireHarnessctlLock(lockFile, `review:${taskId}`);
  } catch (e) {
    if (e.message.startsWith("Malformed harnessctl lock")) {
      // harnessctl creates the file (wx) before writing JSON — a crash between
      // those two steps leaves an empty/truncated lock that blocks recovery forever.
      // If the lock is older than 30 s it is safe to retire; if younger, another
      // writer is mid-flight.
      let mtimeMs = Infinity;
      try { mtimeMs = (await stat(lockFile)).mtimeMs; } catch { /* gone */ }
      const ageMs = Date.now() - mtimeMs;
      if (ageMs > 30_000) {
        const aside = `${lockFile}.malformed.${process.pid}.${Date.now()}`;
        try { await rename(lockFile, aside); } catch { /* best-effort */ }
        try {
          release = await acquireHarnessctlLock(lockFile, `review:${taskId}`);
        } catch (e2) {
          process.stderr.write(`review: ${e2.message.includes("live owner") ? `another review of ${taskId} is running (${e2.message})` : e2.message}\n`);
          process.exit(2);
        }
      } else {
        process.stderr.write(`review: lock for ${taskId} is being written by another process, retry\n`);
        process.exit(2);
      }
    } else {
      process.stderr.write(`review: ${e.message.includes("live owner") ? `another review of ${taskId} is running (${e.message})` : e.message}\n`);
      process.exit(2);
    }
  }

  let state;
  try {
    state = await readStateFile(stateFile) ?? { schemaVersion: 1, task: taskId, rounds: { plan: [], code: [] } };
  } catch (e) {
    await release();
    process.stderr.write(`review: failed to read state: ${e.message}\n`);
    process.exit(3);
  }

  const rounds = state.rounds[kind] ?? [];
  const { n, refused, reason } = nextRound(rounds, kind, forceReason);

  if (refused) {
    await release();
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }

  if (forceReason) process.stderr.write(`review: force-round reason: ${forceReason}\n`);

  const notes = notesFile ? await readFile(notesFile, "utf8").catch(() => null) : null;
  const outDir = path.join(stateDir, taskId);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${kind}-r${n}-${process.pid}.json`); // one file per attempt

  if (!state.rounds[kind]) state.rounds[kind] = [];
  state.rounds[kind].push({
    n, at: new Date().toISOString(),
    engine: "codex", model,
    status: "running", pid: process.pid,
    verdict: null, defects: 0, expansions: 0,
    out: outPath, forced: forceReason ?? null,
  });
  await writeStateFile(stateFile, state);
  await release(); // Lock released after reservation — not held during model run

  // Detect if dir is a git repo
  const isGitRepo = spawnSync("git", ["-C", dir, "rev-parse", "--git-dir"], { encoding: "utf8" }).status === 0;
  const prompt = buildPrompt({ round: n, kind, task: taskId, target, dir, notes });

  async function runCodex() {
    const argv = buildCodexArgv({ slug: model, harness: envHarness, outPath, dir, skipGitRepoCheck: !isGitRepo });
    return new Promise((resolve) => {
      const child = spawn(codexBin, argv, {
        timeout: timeoutMin * 60 * 1000,
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin.write(prompt);
      child.stdin.end();
      child.on("close", (code) => resolve(code ?? -1));
      child.on("error", (e) => { process.stderr.write(`review: codex error: ${e.message}\n`); resolve(-1); });
    });
  }

  async function readOutput() {
    try { return JSON.parse(await readFile(outPath, "utf8")); } catch { return null; }
  }

  // Only output written by a successful run of this attempt counts.
  async function attempt() {
    await rm(outPath, { force: true });
    const code = await runCodex();
    if (code !== 0) return { rawOutput: null, norm: { valid: false, reason: `engine exit ${code}` } };
    const raw = await readOutput();
    return { rawOutput: raw, norm: raw ? normalizeReview(raw, n) : { valid: false, reason: "empty output" } };
  }
  let { rawOutput, norm } = await attempt();

  // Auto-relaunch once on invalid/empty
  if (!norm.valid) {
    process.stderr.write(`review: invalid output (${norm.reason}), relaunching once\n`);
    ({ rawOutput, norm } = await attempt());
  }

  // Update round status only while holding the lock; never overwrite someone else's read-modify-write.
  let releaseFinal = null;
  const waitUntil = Date.now() + Number(process.env.REVIEW_LOCK_WAIT_MS ?? 10_000);
  while (!releaseFinal && Date.now() < waitUntil) {
    try { releaseFinal = await acquireHarnessctlLock(lockFile, `review:${taskId}`); }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!releaseFinal) process.stderr.write(`review: state not updated (lock busy); the result is in ${outPath}\n`);
  const reloaded = releaseFinal ? await readStateFile(stateFile) : null;
  const roundRec = reloaded?.rounds[kind]?.find((r) => r.n === n && r.pid === process.pid);
  if (roundRec) {
    roundRec.status = norm.valid ? "done" : "failed";
    if (norm.valid) {
      roundRec.verdict = norm.verdict;
      roundRec.defects = norm.blockers.filter((b) => b.kind === "defect").length;
      roundRec.expansions = (rawOutput?.blockers ?? []).filter((b) => b.kind === "expansion").length;
    }
    await writeStateFile(stateFile, reloaded);
  }
  if (releaseFinal) await releaseFinal();

  if (!norm.valid) {
    process.stderr.write(`review: model output invalid after relaunch: ${norm.reason}\n`);
    process.exit(3);
  }

  // Print compact result
  process.stdout.write(`REVIEW ${kind} r${n}/2 codex ${model} (task ${taskId})\n`);
  for (const b of norm.blockers) {
    process.stdout.write(`${b.kind} ${b.file}${b.line != null ? `:${b.line}` : ""} ${b.why}\n`);
  }
  if (norm.droppedExpansions) process.stdout.write(`(dropped ${norm.droppedExpansions} expansion(s) in round 2)\n`);
  process.stdout.write(`VERDICT: ${norm.verdict}\n`);
  process.exit(norm.verdict === "APPROVE" ? 0 : 1);
}

if (isMain(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`review: fatal: ${e.message}\n`); process.exit(3); });
}
