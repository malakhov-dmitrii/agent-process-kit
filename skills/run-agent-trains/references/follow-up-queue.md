# Follow-up queue

An agent that waits for a slot, a gate, a UAT run or a review should not idle. It takes the next follow-up from a shared queue, does light work on its own branch, and goes back to its main task the moment the wait ends.

## The queue file

```text
| ID    | Item                                                         | Size    |
|-------|--------------------------------------------------------------|---------|
| FU-01 | Seed the test database with realistic data                   | 4-6 h   |
| FU-02 | Move the runner scripts from a worktree into the repository  | 1 h     |
| FU-03 | Stop the gate's dev server when the gate exits               | 0.5 h   |
```

- The top row has the highest payoff.
- Every ID is unique and a plain name of letters, digits, dot, dash and underscore. `claim.sh` refuses anything else, because a claim is a directory named after the ID. If two rows share an ID, the first claim blocks the second row forever. The queue in the audited program had a duplicated ID, so one item could never be claimed.
- Each item states a size, so an agent can tell whether it fits in the wait.

## The rules

1. Claim before you start: `CLAIMS=fu-claims AGENT=<your name> sh scripts/claim.sh FU-03`. The script uses `mkdir`, which is atomic. If it fails, take the next ID.
2. Light work only. A heavy command goes through the same slot queue as everything else.
3. Use a separate branch off fresh main, named after the ID. Never mix follow-up work into your card branch.
4. Never touch files of a batch in flight. Check `git diff --name-only main..<in-flight-branch>` before editing.
5. When your wait ends, return to your main task first. Push the follow-up as a WIP branch and write the state into `fu-claims/<ID>/status.txt`: what is done, what is owed, the branch and sha.
6. When the item is done, append a line to `trains.md` in the train format with `train: fu-<ID>`. The captain batches follow-ups with the next release.
7. Set no deploy and take no release lock.

An investigation is a valid result. One follow-up, a report of slow first-byte times on a login page, ended with measurements showing that the page took 10 to 30 ms on a production build and no 1 to 4 second samples on the public site. The claim directory records the numbers and "no code branch needed", and the next step if it recurs. That closed the item with evidence and cost one agent a wait.

## What it did in the audited program

The first hours produced five claims. One shipped with the next batch. One closed as not reproducible, with measurements. Three stayed as investigation or WIP with the owed step written down, for example a sync fix that was pushed but still needed one run when a slot was free. The idle agents also took the infrastructure items nobody else owned, such as moving runner scripts out of an ephemeral worktree.

## Not exercised yet

- Stale claims. A claim with no status update for several hours blocks its item. The captain can release such a claim with `rm -rf fu-claims/<ID>` after reading the status file. The program never needed it, so the threshold is a guess.
- Ordering by payoff. Agents took the next free row. A captain could reorder the table between batches.
