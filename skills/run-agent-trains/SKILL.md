---
name: run-agent-trains
description: Use when many coding agents work in parallel on one repository and their branches must reach production, especially when finished work piles up unreleased, batches slow down as they grow, hotfixes move main under a release, heavy test jobs overload a machine, agents sit idle, or session limits stop the program.
---

# Run agent trains

Building in parallel is cheap. Integration, the release lock and the shared test machine are slow. Size the fan-out to what one release captain can ship in about an hour.

In the audited program, about 60 builders finished 58 work items in under three hours. The median item then took 24 hours to reach production, because items shipped in batches of 19 and of 30 to 40. After every batch held one train, the median batch took 53 minutes from start to live. The [case study](https://github.com/malakhov-dmitrii/agent-process-kit/blob/main/docs/multi-agent-program.md) has the numbers and their limits.

## Roles

| Role | How many | Model tier | Does | Does not |
|---|---|---|---|---|
| Builder | as many as the machine can feed | cheaper | one card in about an hour: code, targeted tests, a pushed branch, one line in `ready.md` | push main, deploy |
| Train integrator | one per train | cheaper, stronger when a train has more than two conflicts | merges a train's branches onto one integration branch, runs the checks, gets one review, pushes, writes one line in `trains.md` | push main, deploy |
| Release captain | one | strongest, or a script plus a short agent per batch | holds the release lock, takes one train, gates once, runs UAT once, deploys, checks production, writes the release note | merge two trains into one release |

An integration train here is a batch of branches merged together. It is not the `full-train` mode of `orchestrate-task`, which is a size class for one task.

## 1. Fix the shape before launching builders

Write the roles, the queue files, the batch cap, the freeze rule and the heavy-job rule into one shared brief that every agent reads. Land foundation decisions first: tokens, shared primitives, and a map of hot files that only an integrator edits. Tag that commit as release 0 and branch every builder from it. In the audited program the builders branched before a program-wide shape rule had landed, and the conflicts and rework cost an estimated 4 to 6 hours.

The step is done when every brief points at the same shared file and every builder's base is the tagged commit.

## 2. Hand work off through the ready queue

A builder appends one line to `ready.md` when its branch is pushed. The format is in [queue formats](references/queue-formats.md). The builder works on its own branch, uses a WIP commit instead of `git stash` (all worktrees of a repository share one stash), and frees its resources when it pushes. Its final report says LOCAL-ONLY or NOT-VERIFIED until the proof the card needs has run in the environment it must reach.

Do not ban builders from rendering or browser checks. The ban moved the visual proof to integration, where the first run of one train had 45 of 76 browser tests red. Let builders run their own heavy checks through the slot queue at the lowest priority.

The step is done when each ready line names a branch, a sha, a base, the surfaces touched and the risks.

## 3. Cut trains by file ownership

A train is the set of ready branches from one area, merged in dependency order onto one integration branch. The integrator runs the checks on the merged tree and asks for one review round, blockers only. A card that cannot be made green in about 30 minutes is reverted from the train with a note, and the train moves on. The integrator pushes the branch, appends one line to `trains.md` and stops. It never pushes main.

Cut trains by the files they edit. Five trains cut by product area all edited the same five shared files, and every merge restarted the gate. Keep a list of hot files and let one integrator apply changes to them.

The step is done when a train has one green branch and one `trains.md` line that lists cards in, cards out with reasons, and proofs.

## 4. Run the release captain as a serial loop

Follow the captain checklist in [queue formats](references/queue-formats.md). The cap is about six cards or sixty minutes of captain time per batch. Never merge several trains into one release. A train whose UAT fails ships without the failing cards, which go back to a builder. If a deploy that already contains your commit is running, ride it instead of starting a second build. Append a timestamped line to the orchestrator log at every step. The retrospective and the stall watchdog both read that log.

The step is done when the deployed revision matches the batch and the log has a line for every step.

## 5. Freeze main while a batch is in flight

While the captain holds the release lock, only a P0 (production broken for users) may push to main. Everything else waits for the next batch. State the rule in the shared brief and enforce it with a pre-push hook that refuses a non-P0 push while the lock exists. In the audited program one batch was rebuilt three times because hotfixes kept moving main, at a cost of about three hours. A freeze written as prose afterwards held for most later batches and failed for some, because other sessions never read it. The hook is a recommendation that has not been exercised yet.

The step is done when a planted non-P0 push during an open batch is refused.

## 6. Limit heavy jobs, not agents

Worktrees and lanes are cheap. Whole-project type checks, full test suites, builds and browser runs are not. Run every heavy command through the slot script in [heavy slots](references/heavy-slots.md), keep one slot free for the release class, and leave light work unlimited.

The step is done when ten agents can start heavy commands at once and the machine's memory stays flat.

## 7. Give waiting agents follow-ups

An agent that waits for a slot, a gate or a review takes the next item from the follow-up queue instead of idling. The claim protocol is in [follow-up queue](references/follow-up-queue.md).

The step is done when a claim directory exists for every follow-up in progress and no two agents hold one item.

## 8. Watch for stalls and limits

Keep the host awake, alarm on a quiet orchestrator log, put a deadline on every background wait, and plan for session limits with model tiers and a second reviewer. Details and scripts are in [stalls and limits](references/stalls-and-limits.md).

The step is done when a planted quiet log produces one alert.

## Failure modes

- Several trains in one release. Two batches merged several trains (19 and 30 to 40 cards). They took 8.4 and 9.3 hours. The seven single-train batches after them averaged 1 hour 12 minutes. Merge drift and a long UAT made every red restart the "main moved" race.
- One immortal captain agent. One captain ran 46 hours over 7,740 turns and re-read 1.29 billion context tokens, 16% of everything the session's agents read. Prefer a script loop that starts a short agent per batch and hands over through the orchestrator log. This is a recommendation, not something the program ran.
- A ledger that drifts. A status ledger said "built" for work that git showed as merged. When the logs and git disagree, git wins.
- Program-wide ETAs. Next-release ETAs given as a clock time landed between 48 minutes early and 43 minutes late (13 cases). Program ETAs that left out integration, serial shipping, limits and runner capacity were late by 9 to 70 hours. Give a program ETA as a range that names those four terms.
- Notification noise. Waiting agents re-fired the stop hook and sent duplicate notices, 58 of 199 final notifications across both sessions. Deduplicate by agent id and content hash.
