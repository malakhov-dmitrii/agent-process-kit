#!/usr/bin/env node
import { isMain } from './entrypoint.mjs';
import { fileURLToPath as processKitFilePath } from 'node:url';
// handoff.mjs: pass the active task to another tool without retyping context.
// Appends a Handoff entry to the task journal (append-only), updates a JSON .agent/CURRENT
// under a hash guard, and prints exactly one line: the resume command.
// ponytail: no <your-task-tracker> note yet (cut in B3); add it when issue notes are wired.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkJournal } from './task-check.mjs';
import { atomicWriteJson, ensureStateRoot, getStateRoot, handoffPath, withLock } from './task-store.mjs';

const TOOLS = ["claude", "codex", "grok"];
const STATUSES = ["handoff", "paused", "blocked"];
const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

export function resumeCommand({ to, repo, worktree = repo, taskId, journalRel, ts, handoffId, stateRoot }) {
  let prompt = `Продолжи задачу ${taskId}: прочитай ${journalRel} раздел "Handoff ${ts}" и продолжай с Next.`;
  if (handoffId) {
    const binder = processKitFilePath(new URL('./task-bind.mjs', import.meta.url));
    prompt += ` Сверь запрос и прими передачу: node ${quote(binder)} --task ${quote(taskId)} --journal ${quote(journalRel)} --repo ${quote(repo)} --worktree ${quote(worktree)} --host ${to} --state-dir ${quote(stateRoot)} --accept-handoff ${quote(handoffId)}. Используй ID новой сессии, не ID отправителя. Если журнал не соответствует запросу, не принимай передачу.`;
  }
  const environment = stateRoot
    ? `env AGENT_PROCESS_STATE_DIR=${quote(stateRoot)} AGENT_TASK_TRACE_ROOT=${quote(stateRoot)} ` : '';
  return `cd ${quote(worktree)} && ${environment}${to} ${quote(prompt)}`;
}

function parseArgs(argv) {
  const out = { status: "handoff", dir: process.cwd(), dryRun: false };
  const names = { "--to": "to", "--next": "next", "--status": "status", "--by": "by", "-C": "dir" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    else if (names[argv[i]]) out[names[argv[i]]] = argv[(i += 1)];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!TOOLS.includes(out.to)) throw new Error("--to claude|codex|grok is required");
  if (!out.next) throw new Error('--next "<one line>" is required');
  if (!STATUSES.includes(out.status)) throw new Error("--status handoff|paused|blocked");
  out.by ||= out.status === "blocked" ? "operator" : out.to;
  return out;
}

function git(repo, ...args) {
  try {
    return execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
  } catch {
    return "";
  }
}

async function receiptLine(repo) {
  try {
    const { checkReceipt, formatReceipt } = await import("./receipt-check.mjs");
    const result = await checkReceipt({ dir: repo, deploy: false, timeoutMs: 2500 });
    return result ? formatReceipt(result) : "n/a";
  } catch {
    return "n/a";
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some((a) => a === "--help" || a === "-h")) { process.stdout.write("usage: handoff.mjs --to claude|codex|grok --next \"<one line>\" [--status handoff|paused|blocked] [--by <who>] [-C <dir>] [--dry-run]\n"); return 0; }
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`handoff: ${error.message}\n`);
    return 2;
  }
  const dir = resolve(args.dir);
  const resolver = process.env.HANDOFF_RESOLVER || processKitFilePath(new URL('./resolve-current-task.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [resolver, dir], { cwd: dir, encoding: "utf8", timeout: 10000 });
  let task = null;
  try { task = JSON.parse(run.stdout); } catch { /* reported below */ }
  if (!task || !["ok", "legacy"].includes(task.status) || !task.journal_path) {
    process.stderr.write(`handoff: no active task for ${dir} (${task?.status || "resolver failed"}: ${task?.reason || task?.error || (run.stderr || "").trim()})\n`);
    return 2;
  }
  const repo = realpathSync(task.repo || git(dir, "rev-parse", "--show-toplevel") || dir);
  const worktree = realpathSync(task.worktree || repo);
  const stateRoot = getStateRoot();
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const from = process.env.HANDOFF_FROM || task.owner_host || "unknown";
  let rel = relative(repo, task.journal_path);
  try { rel = relative(repo, realpathSync(task.journal_path)); } catch { /* keep the resolver path */ }
  const journalRel = rel.startsWith("..") ? task.journal_path : rel;
  const dirty = git(worktree, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).length;
  const handoffId = randomUUID();
  const command = resumeCommand({ to: args.to, repo, worktree, taskId: task.task_id, journalRel, ts, handoffId, stateRoot });
  let acceptance = 'unknown';
  try {
    const result = checkJournal(task.journal_path, task.task_id);
    acceptance = `${result.status}; pending=${result.pending.join(',') || 'none'}; invalid=${result.errors.length}`;
  } catch { /* missing evidence stays unknown */ }
  const entry = [
    "", `## Handoff ${ts} — ${from} → ${args.to}`, "",
    `Handoff-ID: ${handoffId}`, `Task: ${task.task_id}`, `To: ${args.to}`, `Worktree: ${worktree}`,
    'Prepared: recipient has not acknowledged', `Acceptance: ${acceptance}`,
    `Status: ${args.status} (by ${args.by})`,
    `Repo: ${repo} @ ${git(worktree, "rev-parse", "--abbrev-ref", "HEAD") || "?"} ${git(worktree, "rev-parse", "--short=7", "HEAD") || "?"} dirty=${dirty}`,
    `Receipt: ${await receiptLine(worktree)}`,
    `Next: ${args.next}`,
    `Resume: ${command}`, "",
  ].join("\n");

  if (args.dryRun) {
    process.stdout.write(`${entry}\n${command}\n`);
    return 0;
  }
  let journalLock;
  try {
    const stateRoot = ensureStateRoot(getStateRoot());
    withLock(handoffPath(stateRoot, handoffId), () => atomicWriteJson(handoffPath(stateRoot, handoffId), {
      version: 1, handoff_id: handoffId, generation: 1, status: 'prepared', task_id: task.task_id,
      journal_path: task.journal_path, repo, worktree,
      source_session: process.env.OPERATOR_TRANSPARENCY_SESSION_ID || null,
      recipient_host: args.to, next_action: args.next, prepared_at: ts,
    }));
    journalLock = openSync(`${task.journal_path}.handoff.lock`, 'wx', 0o600);
    appendFileSync(task.journal_path, entry);
  } catch (error) {
    process.stderr.write(`handoff: cannot append journal: ${error.message}\n`);
    return 2;
  } finally {
    if (journalLock !== undefined) { closeSync(journalLock); unlinkSync(`${task.journal_path}.handoff.lock`); }
  }
  process.stdout.write(`${command}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
