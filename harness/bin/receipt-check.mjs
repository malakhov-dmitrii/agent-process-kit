import { isMain } from './entrypoint.mjs';
// receipt-check.mjs — check whether a commit is local-only, pushed, or deployed.
// CLI: receipt-check.mjs [<repo-dir>=cwd] [--sha <rev>=HEAD] [--json] [--record]
//                        [--live] [--timeout-ms 2500] [--targets <file>]
// Exit 0 on success; exit 2 on usage errors, unknown repo, or unresolvable sha.
// Fail-open: internal errors allow.

import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_TARGETS = join(HARNESS_ROOT, "receipt-targets.json");
const DEFAULT_LOGS = join(HARNESS_ROOT, "logs");

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=2",
};

// ---------- public API ----------

/** Strip protocol, credentials, and .git suffix from a remote URL. */
export function normalizeRemote(url) {
  if (!url) return "";
  let s = url.trim();
  // git@github.com:user/repo.git → github.com/user/repo
  s = s.replace(/^git@([^:]+):/, "$1/");
  // https://user:pass@host/path → host/path
  s = s.replace(/^https?:\/\/(?:[^@]*@)?/, "");
  // remove trailing .git
  s = s.replace(/\.git$/, "");
  return s;
}

/** Load receipt-targets.json; returns {repos:[]} or {repos:[]} on error. */
export function loadTargets(file) {
  try {
    const raw = readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.repos)) return obj;
  } catch { /* fall through */ }
  return { repos: [] };
}

/**
 * checkReceipt({dir, rev, live, timeoutMs, targets, deadline})
 * Returns a result object; never throws.
 * deadline: absolute ms (Date.now()) after which we give up and return null.
 */
export async function checkReceipt({ dir, rev = "HEAD", live = false, deploy: checkDeploy = true, timeoutMs = 2500, targets, deadline } = {}) {
  const start = Date.now();
  if (!deadline) deadline = start + timeoutMs;
  const remaining = () => Math.max(50, deadline - Date.now());

  const cwd = dir || process.cwd();
  const targetsData = targets != null ? targets : loadTargets(DEFAULT_TARGETS);

  function git(...args) {
    const ms = Math.min(remaining(), timeoutMs);
    return execFileSync("git", args, {
      cwd,
      env: GIT_ENV,
      timeout: ms,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8").trim();
  }

  // 1. Find repo root
  let root;
  try { root = git("-C", cwd, "rev-parse", "--show-toplevel"); }
  catch { return null; } // not a repo → caller should exit 2

  // 2. Resolve sha
  let sha;
  try { sha = git("-C", root, "rev-parse", "--verify", `${rev}^{commit}`); }
  catch { return null; } // unresolvable

  const sha7 = sha.slice(0, 7);

  // 3. Repo name from first remote URL
  let repoName = basename(root);
  try {
    const remotes = git("-C", root, "remote", "-v")
      .split("\n")
      .filter(Boolean);
    if (remotes.length) {
      const firstUrl = remotes[0].split(/\s+/)[1];
      if (firstUrl) {
        const normed = normalizeRemote(firstUrl);
        const parts = normed.replace(/^[^/]+\//, "").split("/");
        repoName = parts[parts.length - 1] || repoName;
      }
    }
  } catch { /* use dirname basename */ }

  // 4. Dirty count (only when rev is HEAD)
  let dirty = null;
  if (rev === "HEAD" || rev === "head") {
    try {
      const statusOut = git("-C", root, "status", "--porcelain", "--untracked-files=no");
      dirty = statusOut ? statusOut.split("\n").filter(Boolean).length : 0;
    } catch { /* ignore */ }
  }

  // 5. Find remote refs containing this sha
  let level = "LOCAL-ONLY";
  let ref = null;

  let remoteRefs = [];
  try {
    const out = git("-C", root, "for-each-ref", `--contains=${sha}`,
      "--format=%(refname:short)", "refs/remotes");
    remoteRefs = out.split("\n").filter(s => {
      if (!s.trim()) return false;
      // drop */HEAD and bare <remote> (no slash after remote name)
      if (s.endsWith("/HEAD")) return false;
      const slash = s.indexOf("/");
      return slash > 0; // must have a branch component
    });
  } catch { /* remain LOCAL-ONLY */ }

  // Prefer <remote>/main or <remote>/master
  if (remoteRefs.length) {
    level = "PUSHED";
    ref = remoteRefs.find(r => r.endsWith("/main") || r.endsWith("/master"))
      ?? remoteRefs[0];
  } else if (live && deadline - Date.now() > 300) {
    // Confirm LOCAL-ONLY via ls-remote (at most 2 remotes)
    let remoteList = [];
    try {
      remoteList = git("-C", root, "remote").split("\n").filter(Boolean).slice(0, 2);
    } catch { /* stay LOCAL-ONLY */ }
    for (const remote of remoteList) {
      if (deadline - Date.now() < 300) break;
      try {
        const lsOut = git("-C", root, "ls-remote", "--heads", remote);
        const lines = lsOut.split("\n").filter(Boolean);
        for (const line of lines) {
          const [remoteSha, refname] = line.split("\t");
          if (remoteSha && remoteSha.startsWith(sha.slice(0, 12))) {
            level = "PUSHED";
            ref = `${remote}/${basename(refname)}`;
            break;
          }
        }
        if (level === "PUSHED") break;
      } catch { /* ignore this remote */ }
    }
  }

  // 6. Get all remote URLs for target matching
  let remoteUrls = [];
  try {
    const rv = git("-C", root, "remote", "-v");
    for (const line of rv.split("\n")) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
      if (m) remoteUrls.push({ name: m[1], url: m[2] });
    }
  } catch { /* ignore */ }

  // 7. Deploy check
  let deploy = [];
  let proof = null;

  if (checkDeploy && level === "PUSHED" && targetsData.repos.length) {
    const matchedTarget = targetsData.repos.find(repo => {
      return remoteUrls.some(r => normalizeRemote(r.url) === repo.match
        || normalizeRemote(r.url).includes(repo.match));
    });

    if (matchedTarget) {
      const fetchResults = await Promise.all(matchedTarget.deploy.map(async (contour) => {
        const ms = Math.min(2500, Math.max(100, deadline - Date.now()));
        if (ms < 100) return { name: contour.name, url: contour.url, live: null, state: "unknown" };
        try {
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), ms);
          let resp, json;
          try {
            // The timer covers the body too: a body that stalls after headers must not outlive the deadline.
            resp = await fetch(contour.url, { signal: controller.signal });
            if (resp.ok) json = await resp.json();
          } finally {
            clearTimeout(tid);
          }
          if (!resp.ok) return { name: contour.name, url: contour.url, live: null, state: "unknown" };
          const liveSha = json[contour.field || "commit"];
          if (!liveSha || !/^[0-9a-f]{7,40}$/i.test(liveSha)) {
            return { name: contour.name, url: contour.url, live: null, state: "unknown" };
          }
          const liveSha7 = liveSha.slice(0, 7);
          // Determine state
          let state = "unknown";
          if (sha.startsWith(liveSha) || liveSha.startsWith(sha.slice(0, 7))) {
            state = "live";
          } else {
            // Check if liveSha is in local history (contains / ancestor)
            try {
              git("-C", root, "cat-file", "-e", `${liveSha}^{commit}`);
              // liveSha exists locally
              try {
                git("-C", root, "merge-base", "--is-ancestor", sha, liveSha);
                state = "contains"; // sha is ancestor of live → live contains sha
              } catch {
                state = "behind"; // live exists but sha is not ancestor of it
              }
            } catch {
              state = "behind"; // liveSha not in local objects
            }
          }
          return { name: contour.name, url: contour.url, live: liveSha7, state };
        } catch {
          return { name: contour.name, url: contour.url, live: null, state: "unknown" };
        }
      }));

      deploy = fetchResults;

      // Check if any contour is live or contains
      const best = deploy.find(d => d.state === "live" || d.state === "contains");
      if (best) {
        level = "DEPLOYED";
        proof = best.url;
      }
    }
  }

  return { level, repo: repoName, sha, sha7, ref, dirty, deploy, proof, root };
}

/** Format checkReceipt result as one line. */
export function formatReceipt(result) {
  if (!result) return "";
  const { level, repo, sha7, ref, dirty, deploy, proof } = result;
  let line = `${level} ${repo} ${sha7}`;
  if (level === "LOCAL-ONLY") {
    line += " not on any remote ref";
  } else if (ref) {
    line += ` on ${ref}`;
  }
  for (const d of deploy) {
    line += ` ${d.name}=${d.state}`;
    if (d.live) line += `@${d.live}`;
  }
  if (dirty !== null) line += ` dirty=${dirty}`;
  if (proof) line += ` proof ${proof}`;
  return line;
}

/** Append one row to logs/receipts.jsonl (mode 0600). */
export function recordReceipt(result, source) {
  if (!result) return;
  const row = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    source: source || "cli",
    repo: result.root,
    remote: result.ref ? result.ref.split("/")[0] : null,
    sha: result.sha,
    level: result.level,
    ref: result.ref || null,
    dirty: result.dirty,
    deploy: result.deploy.map(d => ({
      name: d.name,
      url: d.url,
      live: d.live || null,
      state: d.state,
    })),
    proof: result.proof || null,
  };
  try {
    const logFile = process.env.RECEIPT_CHECK_LOG || join(DEFAULT_LOGS, "receipts.jsonl");
    mkdirSync(dirname(logFile), { recursive: true });
    // Open with O_CREAT|O_WRONLY|O_APPEND, mode 0600 = 0o600
    const fd = openSync(logFile, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(row) + "\n");
    } finally {
      closeSync(fd);
    }
  } catch { /* best effort */ }
}

// ---------- CLI ----------

async function main() {
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) { process.stdout.write("usage: receipt-check.mjs [<repo-dir>] [--sha <rev>] [--json] [--record] [--live] [--timeout-ms 2500] [--targets <file>]\n"); return 0; }
  const deadline = Date.now() + 3500;
  const args = process.argv.slice(2);
  let repoDir = null;
  let rev = "HEAD";
  let json = false;
  let record = false;
  let live = false;
  let timeoutMs = 2500;
  let targetsFile = DEFAULT_TARGETS;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--sha") { rev = args[++i]; }
    else if (a === "--json") { json = true; }
    else if (a === "--record") { record = true; }
    else if (a === "--live") { live = true; }
    else if (a === "--timeout-ms") { timeoutMs = parseInt(args[++i], 10) || 2500; }
    else if (a === "--targets") { targetsFile = args[++i]; }
    else if (!a.startsWith("--")) { repoDir = a; }
    else {
      process.stderr.write(`receipt-check: unknown flag ${a}\n`);
      process.exit(2);
    }
  }

  const dir = repoDir || process.cwd();
  const targets = loadTargets(targetsFile);

  let result;
  try {
    result = await checkReceipt({ dir, rev, live, timeoutMs, targets, deadline });
  } catch {
    result = null;
  }

  if (!result) {
    // Determine why: not a repo or unresolvable sha
    try {
      execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"],
        { env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], timeout: 2000 });
    } catch {
      process.stderr.write(`receipt-check: ${dir} is not a git repository\n`);
      process.exit(2);
    }
    process.stderr.write(`receipt-check: cannot resolve ${rev}\n`);
    process.exit(2);
  }

  if (record) {
    recordReceipt(result, "cli");
  }

  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(formatReceipt(result) + "\n");
  }
}

if (isMain(import.meta.url)) {
  main().catch(() => process.exit(2));
}
