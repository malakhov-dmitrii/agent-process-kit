# Tree-keyed receipts

A gate receipt says that the full gate passed on exactly this code. It is worth having because the gate is slow, and a deploy of the same code should not run it twice.

## The rules

1. The key is a hash of the git tree ids of every path that the shipped artifact or the gate reads: source, scripts, the build file, the files the docs tests read. List the paths conservatively. A path you forget makes the receipt vouch for code it never tested.
2. Only the gate script writes a receipt. It writes after a green run, for the commit it tested, and only when the key equals that commit's key.
3. Receipts live in the shared git directory, so every worktree of the repository sees them.
4. The deploy script reuses a receipt only when three things hold: the keyed paths are clean in the working tree, a receipt exists for the key of `HEAD`, and it carries every flag the deploy requires, such as `gate=pass design=pass`. Otherwise the deploy runs the gate again or stops.
5. A change outside the keyed paths leaves the key alone. A docs-only commit keeps its receipt. A change under a keyed path gives a new key, and the old receipt stops matching.
6. Skipping the gate is explicit. A tests-only or docs-only delta after a green gate may ship with a skip variable, and the release note records the reason.

## The script

[`scripts/gate-receipt.sh`](../scripts/gate-receipt.sh) is a POSIX shell library. Source it from the gate and from the deploy script.

```sh
RECEIPT_PATHS="src scripts Dockerfile"
. ./gate-receipt.sh

# gate script, after a green run on $commit
receipt_write "$(receipt_key "$commit")" "$commit" gate=pass design=pass

# deploy script, before shipping HEAD
receipt_reuse gate=pass design=pass || { echo "no matching receipt, run the gate"; exit 1; }
```

`receipt_write` refuses a key that is not the key of the commit. `receipt_reuse` prints the receipt line and refuses a dirty tree, a missing receipt or a missing flag.

The runtime's candidate fingerprint gives task evidence the same property. This script applies the rule to a project's own gate and deploy scripts.

## What it bought

With a reused receipt, deploys took 2 to 14 minutes in the audited program, 2 minutes in the best case. Agents had earlier waited 45 minutes on a remembered "35 to 45 minute build" that measured about 2 minutes to build and about 7 to deploy. Measure your pipeline, and do not wait on a number from memory.

## Read the environment, in both directions

- A push is not a deploy. In one day seven pushes left production on the previous build while every gate was green, because nothing told the platform about them. Read the revision from the environment.
- A deploy script that exits 1 on its own timer does not prove the deploy failed. The scripts polled on a clock that was shorter than a slow build, and four times in two days the commit landed after the script reported failure. Check the platform's deployment list. A build in progress means wait.
- Do not wrap a deploy script in an outer timeout equal to its own. Do not pipe it into `tail`, because the pipe reports the exit code of `tail`, and a real failure reads as success.

## Final reports

Use one leading receipt: DELIVERED, LOCAL-ONLY, NOT-VERIFIED, PARKED or BLOCKED.

- DELIVERED needs evidence from the system that owns the claim. A "not run" line next to it turns it into LOCAL-ONLY or NOT-VERIFIED.
- Builders and integrators report LOCAL-ONLY until the production proof exists.
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
