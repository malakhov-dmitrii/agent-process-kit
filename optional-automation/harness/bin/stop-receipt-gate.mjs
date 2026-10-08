import { isMain } from './entrypoint.mjs';
import { fileURLToPath as processKitFilePath } from 'node:url';
// stop-receipt-gate.mjs — tracked version of ~/.claude/hooks/stop-receipt-gate.mjs
// Adds receiptRule() which validates DELIVERED: sha tokens via receipt-check.
// classify() and its regexes are copied VERBATIM from the live hook — do not edit here.
// Node ESM, stdlib-only, fail-open.

import { readFileSync } from "node:fs";
import { spawnSync } from 'node:child_process';
import { checkReceipt, recordReceipt } from "./receipt-check.mjs";
import { checkJournal } from './task-check.mjs';

const DEPLOY = /\b(deploy(ed)?|live|prod(uction)?)\b|задепло|выкат|катнул|на проде|в проде/i;

// ── copied verbatim from ~/.claude/hooks/stop-receipt-gate.mjs ───────────────

const STATUS = /(DELIVERED|LOCAL-ONLY|NOT-VERIFIED|PARKED|BLOCKED)\s*:/;
const CLAIM = /(^|[^а-яёa-z])(готово|готов |сделал|сделано|done|завершено|завершён|завершил|complete|completed|fixed|доставлено|доставил|ready|всё готово|all set|all done)([^а-яёa-z]|$)|✅/i;
const HONEST = /(не выходит|не получается|не вышло|не удалось|не работает|offline|недоступ|блокер|blocked|можешь проверить|что делаем|какой вариант|нужно решить|жду|ждёт|на проверку|посмотри|подтверди|выбери)/i;
const EVIDENCE = /(https?:\/\/|```|diff --git|\n\+\+\+ |\n--- |[0-9a-f]{7,40}|[\w./-]+\.(ts|tsx|js|mjs|cjs|json|md|py|sh|wav|mp4|m4a|png|sql)|[\w./-]+:\d+|exit code|passed|зелен|PASS\b|commit [0-9a-f]{7}|\d+\s*(файл|символ|строк|files|chars|posts|tests|расхожд)|\d+(\.\d+)?\s?[KMG]B|0\s+(failed|расхожден|ошиб))/i;

export function classify(finalText, hadToolWork) {
  const t = (finalText || "").trim();
  if (!hadToolWork) return { block: false };
  if (STATUS.test(t)) return { block: false };
  if (HONEST.test(t)) return { block: false };
  if (!CLAIM.test(t)) return { block: false };
  if (EVIDENCE.test(t)) return { block: false };
  return {
    block: true,
    reason: "Контракт Р3 (receipt gate): заявлена готовность без пруфа. Выдай статус-токен — DELIVERED: <пруф: diff/тест/скрин/url/commit/file:line> — либо честный NOT-VERIFIED:/LOCAL-ONLY:/PARKED:/BLOCKED:. Не отчитывайся «готово» без доказательства, что реальный поток прогнан.",
  };
}

// An explicit overall-task claim is separate from a partial DELIVERED receipt.
// No fuzzy natural-language classification of arbitrary user-facing prose.
export function completionRule(finalText, input) {
  const visible = String(finalText || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  const claim = visible.match(/(?:^|\n)\s*(?:Task complete|Задача завершена):\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(?:\n|$)/i);
  if (!claim || input.hook_event_name === 'SubagentStop') return { block: false };
  const resolver = processKitFilePath(new URL('./resolve-current-task.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [resolver, input.cwd || process.cwd()], {
    encoding: 'utf8', timeout: 1200,
    env: { ...process.env, OPERATOR_TRANSPARENCY_SESSION_ID: input.session_id || input.sessionId || input.thread_id || input.threadId
      || process.env.OPERATOR_TRANSPARENCY_SESSION_ID || process.env.CODEX_THREAD_ID || '' },
  });
  if (run.error) return { block: false }; // hook I/O is fail-open
  let task;
  try { task = JSON.parse(run.stdout); } catch { return { block: false }; }
  if (task.status !== 'ok' || task.binding_kind !== 'explicit' || task.task_id !== claim[1]) {
    return { block: true, reason: 'task-check: overall completion requires the exact explicitly bound task. Resolve/bind the current request; do not complete a workspace default or another task.' };
  }
  try {
    const result = checkJournal(task.journal_path, task.task_id);
    if (result.status === 'ready') return { block: false };
    return { block: true, reason: `task-check: ${result.status}; pending=${result.pending.join(',') || 'none'}; ${result.errors.join('; ')}. Continue authorized work or report the actual blocker. A passing substep is not overall completion.` };
  } catch { return { block: true, reason: 'task-check: explicit completion claim could not verify the bound journal; report NOT-VERIFIED or repair the task state.' }; }
}

// ── end verbatim copy ─────────────────────────────────────────────────────────

/**
 * receiptRule(finalText, cwd, deadline)
 * Scans DELIVERED: lines for sha-like tokens (7-40 hex chars that are NOT pure decimal
 * ticket numbers and are NOT part of a URL path like /api/build-info).
 * Checks up to 3 shas via checkReceipt. Fail-open on any error.
 * Returns {block:false} or {block:true,reason:...}.
 */
export async function receiptRule(finalText, cwd, deadline, targets) {
  if (!deadline) deadline = Date.now() + 3500;

  const text = (finalText || "").trim();
  // Only examine lines that start with DELIVERED:
  const deliveredLines = text.split("\n").filter(ln => /^\s*DELIVERED\s*:/i.test(ln));
  if (!deliveredLines.length) return { block: false };

  // Extract sha-like tokens: 7-40 hex chars, not all-decimal, not inside a URL path
  const SHA_RE = /(?<![/\w])([0-9a-f]{7,40})(?![0-9a-f])/gi;
  const shas = [];
  for (const ln of deliveredLines) {
    let m;
    SHA_RE.lastIndex = 0;
    while ((m = SHA_RE.exec(ln)) !== null) {
      const tok = m[1];
      // Skip pure decimal (issue numbers, ports) and all-same-char (0000000)
      if (/^\d+$/.test(tok)) continue;
      if (/^(.)\1+$/.test(tok)) continue;
      if (!shas.includes(tok)) shas.push(tok);
      if (shas.length >= 3) break;
    }
    if (shas.length >= 3) break;
  }

  if (!shas.length) return { block: false };

  const claimsDeploy = DEPLOY.test(deliveredLines.join("\n"));
  const checked = [];
  for (const sha of shas) {
    if (deadline - Date.now() < 300) break; // out of time: judge only what was checked
    let result;
    try {
      result = await checkReceipt({ dir: cwd, rev: sha, live: true, deploy: claimsDeploy, deadline, targets });
    } catch {
      continue; // fail-open
    }
    if (!result) continue; // sha from another repo
    try { recordReceipt(result, "stop-gate"); } catch { /* best effort */ }
    if (result.level === "LOCAL-ONLY") {
      return {
        block: true,
        reason: `receipt-check: коммит ${result.sha.slice(0, 7)} только локальный (нет на remote). Замени DELIVERED: на LOCAL-ONLY: или NOT-VERIFIED:.`,
      };
    }
    checked.push(result);
  }

  if (claimsDeploy && checked.length && !checked.some((r) => r.level === "DEPLOYED")) {
    const contours = checked.flatMap((r) => r.deploy || []);
    if (contours.length && !contours.some((d) => d.state === "unknown")) {
      const states = contours.map((d) => `${d.name}=${d.state}${d.live ? "@" + d.live.slice(0, 7) : ""}`).join(", ");
      return {
        block: true,
        reason: `receipt-check: заявлен деплой, но build-info: ${states}, а не ${checked[0].sha.slice(0, 7)}. Замени DELIVERED: на NOT-VERIFIED: или дождись деплоя.`,
      };
    }
  }
  return { block: false };
}

// ── transcript reader (same logic as live hook) ───────────────────────────────

function readFinal(transcriptPath, broad) {
  let lastText = null, hadTool = false;
  const lines = readFileSync(transcriptPath, "utf8").split("\n");
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.type === "assistant" && o.message?.content) {
      for (const c of o.message.content) {
        if (c.type === "text" && c.text?.trim()) lastText = c.text;
        if (c.type === "tool_use" && (broad || /^(Edit|Write|Bash|NotebookEdit)$/.test(c.name || ""))) hadTool = true;
      }
    }
  }
  return { lastText, hadTool };
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function main() {
  const deadline = Date.now() + 3500;
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let inp;
  try { inp = JSON.parse(raw); } catch { return; } // fail-open
  // Block once: a Stop re-entered after our block must pass.
  if (inp.stop_hook_active || inp.stopHookActive) return;
  const broad = inp.hook_event_name === "SubagentStop";
  let final = { lastText: inp.last_assistant_message ?? inp.lastAssistantMessage ?? null, hadTool: false };
  if (inp.transcript_path) {
    try { final = readFinal(inp.transcript_path, broad); } catch { /* preserve the valid hook payload below */ }
  }
  if (!final.lastText) return;

  let verdict = completionRule(final.lastText, inp);
  if (!verdict.block) verdict = classify(final.lastText, final.hadTool);
  if (!verdict.block && STATUS.test(final.lastText.trim())) {
    try {
      verdict = await receiptRule(final.lastText, inp.cwd || process.cwd(), deadline);
    } catch {
      verdict = { block: false };
    }
  }
  // ponytail: no process.exit here; stdout to a pipe is async on macOS and the block JSON could be cut.
  if (verdict.block) process.stdout.write(JSON.stringify({ decision: "block", reason: verdict.reason }));
}

if (isMain(import.meta.url)) {
  main().catch(() => process.exit(0)); // fail-open
}
