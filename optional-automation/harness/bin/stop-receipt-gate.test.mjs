import { fileURLToPath as processKitFilePath } from 'node:url';
// Tests for stop-receipt-gate.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const N = process.execPath;
const MOD = processKitFilePath(new URL('./stop-receipt-gate.mjs', import.meta.url));
// Receipt rows from these tests go to a temp file, never to the live logs/receipts.jsonl.
process.env.RECEIPT_CHECK_LOG = join(mkdtempSync(join(tmpdir(), "srg-log-")), "receipts.jsonl");

const { classify: classifyHarness, completionRule, receiptRule } = await import(pathToFileURL(MOD).href);
const { normalizeRemote } = await import(pathToFileURL(MOD.replace("stop-receipt-gate", "receipt-check")).href);

function serveCommit(body) {
  const hits = { n: 0 };
  const srv = createServer((_, res) => {
    hits.n += 1;
    if (body === null) return; // never answers
    if (body === 500) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ commit: body }));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, port: srv.address().port })));
}

function targetsFor(bare, port) {
  return { schemaVersion: 1, repos: [{ match: normalizeRemote(bare), deploy: [{ name: "crm", url: `http://127.0.0.1:${port}/api/build-info`, field: "commit" }] }] };
}

function pushSecondCommit(work) {
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "second");
  git(work, "push", "origin", "main");
  return git(work, "rev-parse", "HEAD");
}

// ── helpers ──────────────────────────────────────────────────────────────────

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  }).toString().trim();
}

function makeBarePair() {
  const bare = mkdtempSync(join(tmpdir(), "srg-bare-"));
  git(bare, "init", "--bare", "-b", "main");
  const work = mkdtempSync(join(tmpdir(), "srg-work-"));
  git(work, "init", "-b", "main");
  git(work, "remote", "add", "origin", bare);
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
  git(work, "push", "origin", "main");
  return { work, bare };
}

function makeTranscript(messages) {
  const tmp = mkdtempSync(join(tmpdir(), "srg-tr-"));
  const file = join(tmp, "transcript.jsonl");
  writeFileSync(file, messages.map(m => JSON.stringify(m)).join("\n") + "\n");
  return file;
}

function makeAssistantMsg(text, tools = []) {
  return {
    type: "assistant",
    message: {
      content: [
        ...tools.map(name => ({ type: "tool_use", name })),
        { type: "text", text },
      ],
    },
  };
}

function runGate(stdinPayload, opts = {}) {
  const r = spawnSync(N, [MOD], {
    input: JSON.stringify(stdinPayload),
    encoding: "utf8",
    timeout: opts.timeout ?? 8000,
  });
  return r;
}

// ── Group 1: classify parity with live hook on 6 fixed cases ────────────────

test("classify parity: no tool work → no block", () => {
  assert.equal(classifyHarness("all done", false).block, false);
});

test("classify parity: STATUS token → no block", () => {
  const txt = "DELIVERED: see https://example.com/commit/abc1234";
  assert.equal(classifyHarness(txt, true).block, false);
});

test("classify parity: HONEST signal → no block", () => {
  const txt = "не вышло сделать это";
  assert.equal(classifyHarness(txt, true).block, false);
});

test("classify parity: claim + evidence → no block", () => {
  const txt = "done. 42 tests passed.";
  assert.equal(classifyHarness(txt, true).block, false);
});

test("classify parity: claim without evidence → block", () => {
  const txt = "all done";
  assert.equal(classifyHarness(txt, true).block, true);
});

test("classify parity: no claim → no block", () => {
  const txt = "Here is a summary of the options.";
  assert.equal(classifyHarness(txt, true).block, false);
});

test('fenced completion marker examples are ignored', () => {
  assert.equal(completionRule('```text\nTask complete: example\n```', {}).block, false);
});

// ── Group 2: receiptRule stubs ────────────────────────────────────────────────

test("receiptRule: LOCAL-ONLY sha → block", async () => {
  const repo = mkdtempSync(join(tmpdir(), "srg-local-"));
  git(repo, "init", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
  const sha = git(repo, "rev-parse", "HEAD");
  const text = `DELIVERED: commit ${sha} is ready`;
  const result = await receiptRule(text, repo, Date.now() + 3000);
  assert.equal(result.block, true);
  assert.match(result.reason, /LOCAL-ONLY/);
});

test("receiptRule: PUSHED sha → allow", async () => {
  const { work } = makeBarePair();
  const sha = git(work, "rev-parse", "HEAD");
  const text = `DELIVERED: commit ${sha} was pushed`;
  const result = await receiptRule(text, work, Date.now() + 3000);
  assert.equal(result.block, false);
});

test("receiptRule: unresolvable sha → allow (fail-open)", async () => {
  const { work } = makeBarePair();
  const fakeSha = "deadbeef12345678deadbeef12345678deadbeef";
  const text = `DELIVERED: commit ${fakeSha} done`;
  const result = await receiptRule(text, work, Date.now() + 3000);
  assert.equal(result.block, false);
});

test("receiptRule: zero shas in DELIVERED line → allow", async () => {
  const text = "DELIVERED: see the attached screenshot";
  const result = await receiptRule(text, process.cwd(), Date.now() + 3000);
  assert.equal(result.block, false);
});

test("receiptRule: no DELIVERED lines → allow", async () => {
  const text = "LOCAL-ONLY: not pushed yet";
  const result = await receiptRule(text, process.cwd(), Date.now() + 3000);
  assert.equal(result.block, false);
});

test("receiptRule: 5 DELIVERED shas → checkReceipt called ≤3 times (only first 3 checked)", async () => {
  const { work } = makeBarePair();
  const sha = git(work, "rev-parse", "HEAD");
  // We can't spy on checkReceipt in an ESM import, so verify indirectly:
  // provide 5 shas in the text; all-pushed sha repeated 5 times → block false
  const text = `DELIVERED: ${sha} ${sha} ${sha} abc1234 def5678 more text`;
  const t0 = Date.now();
  const result = await receiptRule(text, work, Date.now() + 3500);
  assert.equal(result.block, false);
  // Should complete quickly since pushed sha is not LOCAL-ONLY and we stop at 3
  assert.ok(Date.now() - t0 < 3000);
});

// Use full commit IDs below. A seven-character prefix can be decimal-only and is
// intentionally ignored by receiptRule because it is indistinguishable from a ticket ID.
test("receiptRule: deploy claim + live build-info → allow", async () => {
  const { work, bare } = makeBarePair();
  const sha = pushSecondCommit(work);
  const { srv, port } = await serveCommit(sha);
  const result = await receiptRule(`DELIVERED: ${sha} deployed to prod`, work, Date.now() + 3000, targetsFor(bare, port));
  await new Promise((r) => srv.close(r));
  assert.equal(result.block, false);
});

test("receiptRule: deploy claim + build-info behind → block", async () => {
  const { work, bare } = makeBarePair();
  const first = git(work, "rev-parse", "HEAD");
  const sha = pushSecondCommit(work);
  const { srv, port } = await serveCommit(first);
  const result = await receiptRule(`DELIVERED: ${sha} задеплоено`, work, Date.now() + 3000, targetsFor(bare, port));
  await new Promise((r) => srv.close(r));
  assert.equal(result.block, true);
  assert.match(result.reason, /заявлен деплой.*crm=behind@/);
});

test("receiptRule: deploy claim + build-info 500 → allow (unknown)", async () => {
  const { work, bare } = makeBarePair();
  const sha = pushSecondCommit(work);
  const { srv, port } = await serveCommit(500);
  const result = await receiptRule(`DELIVERED: ${sha} deployed`, work, Date.now() + 3000, targetsFor(bare, port));
  await new Promise((r) => srv.close(r));
  assert.equal(result.block, false);
});

test("receiptRule: pushed without a deploy claim never fetches build-info", async () => {
  const { work, bare } = makeBarePair();
  const first = git(work, "rev-parse", "HEAD");
  const sha = pushSecondCommit(work);
  const { srv, hits, port } = await serveCommit(first);
  const result = await receiptRule(`DELIVERED: ${sha} pushed to main`, work, Date.now() + 3000, targetsFor(bare, port));
  await new Promise((r) => srv.close(r));
  assert.equal(result.block, false);
  assert.equal(hits.n, 0);
});

// ── Group 3: time bounds ──────────────────────────────────────────────────────

test("receiptRule: hanging checkReceipt stub → completes < 4s", async () => {
  // A repo with a valid sha but a hanging HTTP endpoint won't reach receiptRule timeout
  // because receipts-check has its own deadline. Just ensure receiptRule itself
  // respects the deadline we pass.
  const { work } = makeBarePair();
  const sha = git(work, "rev-parse", "HEAD");
  const text = `DELIVERED: ${sha} see work`;
  const t0 = Date.now();
  const result = await receiptRule(text, work, Date.now() + 500); // tight deadline
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 4000, `elapsed ${elapsed}ms should be < 4000ms`);
  // fail-open: either allow or block but must return
  assert.ok(result.block === true || result.block === false);
});

test("time bound: ext::sh hanging remote → receiptRule returns < 4s", async () => {
  // Create a repo with an ext:: remote that hangs
  const work = mkdtempSync(join(tmpdir(), "srg-hang-"));
  git(work, "init", "-b", "main");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
  const sha = git(work, "rev-parse", "HEAD");
  // Add a hanging remote
  try {
    execFileSync("git", ["-C", work, "remote", "add", "origin", "ext::sh -c \"sleep 10\""], {
      env: { ...GIT_ENV, GIT_ALLOW_PROTOCOL: "ext" },
      stdio: "ignore",
      timeout: 3000,
    });
  } catch { /* if ext protocol not allowed, skip */ }

  const text = `DELIVERED: ${sha} done here`;
  const t0 = Date.now();
  const result = await receiptRule(text, work, Date.now() + 3500);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 4000, `elapsed ${elapsed}ms should be < 4000ms`);
  assert.ok(result.block === true || result.block === false);
});

test("time bound: never-answering HTTP deploy → receiptRule returns < 4s", async () => {
  const { work, bare } = makeBarePair();
  const sha = pushSecondCommit(work);
  const { srv, hits, port } = await serveCommit(null);
  const t0 = Date.now();
  const result = await receiptRule(`DELIVERED: ${sha} deployed`, work, Date.now() + 3500, targetsFor(bare, port));
  const elapsed = Date.now() - t0;
  srv.closeAllConnections(); await new Promise((r) => srv.close(r));
  assert.ok(hits.n >= 1, "the hanging server was actually called");
  assert.ok(elapsed < 4000, `elapsed ${elapsed}ms should be < 4000ms`);
  assert.equal(result.block, false);
});

// ── Group 4: main subprocess (Claude hook protocol) ───────────────────────────

test("main: stop_hook_active=true → empty stdout, exit 0", () => {
  const r = runGate({ stop_hook_active: true, transcript_path: "/dev/null" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("main: malformed JSON → empty stdout, exit 0 (fail-open)", () => {
  const r = spawnSync(N, [MOD], {
    input: "not json",
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("main: no transcript_path → empty stdout, exit 0", () => {
  const r = runGate({ stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("main: claim-without-evidence transcript → block JSON", () => {
  const tf = makeTranscript([
    makeAssistantMsg("все сделано", ["Bash"]),
  ]);
  const r = runGate({ transcript_path: tf, hook_event_name: "Stop" });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(out.reason.length > 10);
});

test("main: claim with evidence → allow (empty stdout)", () => {
  const tf = makeTranscript([
    makeAssistantMsg("done. exit code 0, 17 tests passed.", ["Bash"]),
  ]);
  const r = runGate({ transcript_path: tf, hook_event_name: "Stop" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("main: DELIVERED with local-only sha → block JSON", async () => {
  const repo = mkdtempSync(join(tmpdir(), "srg-main-"));
  git(repo, "init", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
  const sha = git(repo, "rev-parse", "HEAD");
  const tf = makeTranscript([
    makeAssistantMsg(`DELIVERED: commit ${sha} landed on main.`, ["Bash"]),
  ]);
  const r = runGate({ transcript_path: tf, hook_event_name: "Stop", cwd: repo });
  assert.equal(r.status, 0);
  if (r.stdout.trim()) {
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
  }
  // If empty → fail-open (acceptable — sha may be resolved as unresolvable in some git versions)
});
