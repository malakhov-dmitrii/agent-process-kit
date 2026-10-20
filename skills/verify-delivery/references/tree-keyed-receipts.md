# Tree-keyed receipts

A gate receipt says that the full gate passed on exactly this code. It is worth having because the gate is slow, and a deploy of the same code should not run it twice.

## The rules

Supported: plain repositories without submodules. Anything unusual is refused rather than guessed. The library refuses a repository with a submodule or a `.gitmodules` file, `core.fileMode=false`, `core.symlinks=false`, any assume-unchanged or skip-worktree entry anywhere, and a symlink at or above a keyed path. Each of these makes git report a change differently or not at all, and a receipt must never vouch for code it did not see.

1. The key is a hash of what `git ls-tree` reports for every path that the shipped artifact or the gate reads: source, scripts, the build file, the files the docs tests read. Each entry carries the mode, the type and the object id, so a chmod or a change of file type gives a new key, and so does a change of content. List the paths conservatively. A path you forget makes the receipt vouch for code it never tested.
   A keyed path that is a symlink, or that lies below one, is refused: the key cannot say what is read through it, so key the real paths instead. The working tree is checked on disk, so a symlink that appears after the receipt was written is caught too, and a symlink that is an ancestor of the path in the commit being keyed is refused for the same reason. The list must not be empty. Its paths are relative to the repository root, spelled plainly (no `..`, no `.` segment, no `//`), without globs or spaces, and at least one of them must exist at the revision. Otherwise `receipt_key` prints nothing and fails, because a key over no paths would match every commit.
2. Only the gate script writes a receipt. It writes after a green run, for the commit it tested, only on a clean checkout, and only when the key equals the key of that commit and of the checked-out HEAD.
3. Receipts live in the shared git directory, so every worktree of the repository sees them.
4. The deploy script reuses a receipt only when four things hold: the whole repository is clean (`git status --porcelain --untracked-files=all` is empty and exits 0, checked from the repository root whatever the current directory is; it is not limited to the keyed paths, because a path-limited status lets a new untracked file or symlink above a keyed path go unseen), a receipt exists for the key of `HEAD`, no later red run has invalidated it, and it carries every flag the deploy requires, such as `gate=pass design=pass`. Otherwise the deploy runs the gate again or stops. Files that git ignores are outside both the key and the check, so a gate must not read them from a keyed path, and a gate that writes untracked build output outside an ignored directory leaves the repository unclean for its own `receipt_write`.
5. A change outside the keyed paths leaves the key alone. A docs-only commit keeps its receipt. A change under a keyed path gives a new key, and the old receipt stops matching.
6. Skipping the gate is explicit. A tests-only or docs-only delta after a green gate may ship with a skip variable, and the release note records the reason.
7. A red run takes the old pass away. The gate calls `receipt_invalidate` for the key before it runs and stops when that call fails, because a receipt that cannot be invalidated could still be reused after a red run. The call leaves a numbered start record for the run. A receipt is usable only while no start record has a higher number than the run that passed, so a red or crashed rerun leaves no earlier green receipt usable, and so does a red run that overlaps with a passing one and started after it. The new receipt is written only after a green run, and `receipt_write` refuses while another run of the same tree is still alive, because that run may yet turn out red. Call `receipt_invalidate` and `receipt_write` from one script, since the run number lives in the shell between them.

## The script

[`scripts/gate-receipt.sh`](../scripts/gate-receipt.sh) is a POSIX shell library. Source it from the gate and from the deploy script.

```sh
RECEIPT_PATHS="src scripts Dockerfile"
. ./gate-receipt.sh

# gate script, on a clean checkout of $commit
key=$(receipt_key "$commit") || exit 1
receipt_invalidate "$key" || exit 1  # an earlier pass for this tree stops counting now; if this fails, do not run the gate
run_the_gate || exit 1               # red: the invalidation stands
receipt_write "$key" "$commit" gate=pass design=pass

# deploy script, before shipping HEAD
receipt_reuse gate=pass design=pass || { echo "no matching receipt, run the gate"; exit 1; }
```

`receipt_write` refuses an empty key, a repository that is not clean, and a key that is not the key of both the commit and the checked-out HEAD. `receipt_reuse` prints the receipt line and refuses a repository that is not clean, a missing receipt, an invalidated receipt or a missing flag. A key is a hex object id and nothing else, so it can never name a path outside the receipt directory.

The runtime's candidate fingerprint gives task evidence the same property. This script applies the rule to a project's own gate and deploy scripts.

## What it bought

With a reused receipt, deploys took 2 to 14 minutes in the audited program, 2 minutes in the best case. Agents had earlier waited 45 minutes on a remembered "35 to 45 minute build" that measured about 2 minutes to build and about 7 to deploy. Measure your pipeline, and do not wait on a number from memory.

## Read the environment, in both directions

- A push is not a deploy. In one day seven pushes left production on the previous build while every gate was green, because nothing told the platform about them. Read the revision from the environment.
- A deploy script that exits 1 on its own timer does not prove the deploy failed. The scripts polled on a clock that was shorter than a slow build, and four times in two days the commit landed after the script reported failure. Check the platform's deployment list. A build in progress means wait.
- Do not wrap a deploy script in an outer timeout equal to its own. Do not pipe it into `tail`, because the pipe reports the exit code of `tail`, and a real failure reads as success.

## Final reports

Use one leading receipt: DELIVERED, LOCAL-ONLY, NOT-VERIFIED, PARKED or BLOCKED.

- DELIVERED needs evidence from the system that owns the claim. A "not run" line for proof inside the requested boundary turns it into LOCAL-ONLY or NOT-VERIFIED. A stage outside the boundary is listed as not requested.
- When the requested boundary includes production, builders and integrators report LOCAL-ONLY until the production proof exists.
- Across 199 final notifications in the audited program, 47 began with DELIVERED, 9 with LOCAL-ONLY, 4 with NOT-VERIFIED, 4 with PARKED and 1 with BLOCKED. 124 had no receipt and 10 were empty. Of the 47 DELIVERED finals, 23 admitted that the core proof had not run.

## A stop-hook receipt gate

A hook that runs when an agent stops can enforce the vocabulary. This kit does not install one. Register it through your host's hook mechanism. A useful gate does the following:

1. It looks only at final messages written after tool work.
2. It blocks a message that claims completion ("done", "ready", a check mark) and carries neither a receipt token nor evidence. Evidence means a URL, a code block, a commit id, a file path with a line, test counts or an exit code.
3. For a DELIVERED line with a commit id, it checks that the commit is on the remote. If the line claims a deploy, it checks that the environment reports that commit.
4. It blocks once with a message that says what to add, and never loops.
5. It fails open on any error or timeout.
6. It ignores stop events from agents that are only waiting.

Prove it the way you prove any gate: feed it messages and read the verdicts.

| Final message | Verdict |
|---|---|
| "Done." | block: claim without a receipt or evidence |
| "DELIVERED: fixed, 14 files, tests pass, commit 3f9a1c2 on origin" | allow, then check the commit |
| "DELIVERED: deployed 3f9a1c2" while the environment reports another commit | block |
| "LOCAL-ONLY: tests pass locally, not pushed" | allow |
| "Still waiting on the gate" from a waiting agent | allow, no notice |

The gate enforces a useful receipt. It does not prove the claim, and a path or a number can satisfy its patterns. It does not replace tests.
