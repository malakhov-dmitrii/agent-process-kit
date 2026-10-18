# A 114-hour multi-agent program: what held and what broke

This is a case study behind four skills of the kit: `run-agent-trains`, `brief-agents`, `design-gates` and `audit-agent-program`, plus the receipt rules in `verify-delivery`. It describes one program, one product owner and one codebase. Treat the numbers as a prior for your own program, not as a benchmark.

## The program

A product owner redesigned the whole interface of a production web app with a fleet of coding agents. Most agents were Claude Code subagents, and a second vendor's agent ran as a fallback and as a reviewer. The work ran 114 hours from the first message to the last release.

- About 125 work items reached production, plus about 33 releases that fixed things the owner found after release.
- The parallelism lens counted 492 subagent runs and about 515 agent-hours. That figure is an upper bound, because a run's span includes every wait. Peak concurrency was 21 agents, and the platform's limit of 20 was hit five times.
- About 60 builders produced 58 work items in under three hours, at a median of 15 minutes each.
- The owner sent 196 messages, 70 of them bare status pings.

Three independent audits (throughput, quality, parallelism) read the transcripts, the orchestration logs, the release notes, the git history and the test runner's journal. Their findings are summarized here. The method is in `audit-agent-program`.

## Where the time went

Building was never the constraint. Everything after the builders was serial and shared: the main branch, one test runner, one release branch, one release agent and one plan budget.

| Measure | Value |
|---|---|
| Median time from "built" to "live", 71 work items from the burst | 24.4 hours |
| of which integration, and shipping (medians, for the 65 items that went through a train) | 8.9 and 12.1 hours |
| Two batches that merged several trains (19 and 30 to 40 items) | 8.4 and 9.3 hours |
| Seven single-train batches that followed | 1 hour 12 minutes on average, 53 minutes median start to live |
| Share of the release agent's batch time spent in stalls | 19 of 32.3 hours, 59% |
| Release agent idle with an empty queue | 11.5 hours |

Stalls, with overlaps removed, added up to about 38 of the 114 hours, 34%:

| Stall | Cost |
|---|---|
| Weekly limit of one provider | 20.5 hours of calendar time, 6 to 12 hours of program delay |
| Laptop out of memory, then a reboot | 6.9 hours of one pipeline |
| Host quiet overnight, probably asleep (unverified) | 5.25 hours |
| Main moved under a batch in flight | about 3.2 hours |
| Session limits ending every agent at once | about 2.7 hours |
| Test runner overloaded, hung or rebooted | about 2.4 hours |
| Gate failures from environment and flaky tests | about 1.9 hours |
| Flaky UAT against a dev server | about 1.8 hours |
| False positives in a new style matrix | about 1.5 hours |

The release agent was one long-lived context. It ran 46 hours over 7,740 turns and re-read 1.29 billion context tokens, which is 16% of the subagent context read in the second session.

## Where the defects came from

The owner or a teammate found 29 defects and plan errors by eye. At least 24 were in production when found. No gate and no code review caught any of them before the owner did.

| Primary cause | Defects |
|---|---|
| Spec or coverage: the card was wrong or missing | 14 |
| Verification looked in the wrong place | 8 |
| The brief left out a rule | 3 |
| Churn in decisions, ownership or promises | 3 |
| A later card broke an earlier one | 1 |
| An agent ignored a rule in its brief | 0 |

Other measurements from the quality audit:

- A sweep of the code after 87 cards found 521 of 898 UI files that no card named. It produced 30 more cards in about 25 minutes.
- Of 47 final reports that began with DELIVERED, 23 said the core proof had not run.
- About 17 of roughly 110 cards had their browser acceptance skipped or replaced, mostly because the test database lacked the data.
- About 22 of roughly 40 reviewed releases had a blocker in round one. The blockers were behavior and money bugs. The reviewer approved three mechanical batches that the owner rejected the next morning as visually wrong.
- Only 7 of 138 agent prompts had explicit done-when criteria.

## What held

Each item names the skill that carries it.

- Light builders and one serial release lock (`run-agent-trains`). Builders built fast and never held the release.
- One train per release (`run-agent-trains`). Batch time fell from 8 to 9 hours to about an hour.
- A freeze on main while a batch is in flight (`run-agent-trains`). A prose rule, written after a batch was rebuilt three times, cut rebuilds in most later batches.
- Heavy-job slots (`run-agent-trains`). After they covered every heavy command, the runner's journal showed no more out-of-memory kills. Before, it had 37.
- Gate once, reuse the receipt (`verify-delivery`). Deploys took 2 to 14 minutes with a reused receipt.
- Prototype before code (`brief-agents`). Defects found at the prototype stage cost a conversation, not a release.
- A defect becomes a geometry test (`design-gates`). The nesting, wide-screen, same-row height and anti-vacuity checks stopped their classes from returning.
- A reviewer for logic and money (`brief-agents`). It caught real bugs, such as a paid send that became free.
- The coverage sweep (`brief-agents`). It should have been step zero.
- Follow-ups for idle agents (`run-agent-trains`). Five claims in the first hours, one shipped, one closed with measurements.
- A timestamped log at every step (`run-agent-trains`, `audit-agent-program`). The audit exists because of it.

## What did not hold, and what is unproven

- Forbidding builders to render moved the visual proof to integration. The first run of one train had 45 of 76 browser tests red.
- A 12-hour orchestration ran as a background fork of an interactive session and died when the session was restarted. A job of that length belongs in a script, outside an interactive session. This is a recommendation.
- A second vendor's agent was a good reviewer and a good fallback for mechanical batches on a frozen base, and a poor per-card implementer. Its cloud mode failed twice, once because the CLI was logged into an account without the project's environment.
- Moving builders to a cheaper model tier did not prevent the second session limit. The cap bound across models.
- The style matrix's first run was 150 of 150 red. The cause was false positives, and two audit rounds cost about 1.5 hours.

Recommended after the audit and not yet exercised in the program: a keep-awake wrapper and a stale-log watchdog, a pre-push hook that enforces the main freeze, a memory-aware scheduler with priorities, a release agent that is a script plus a short agent per batch, the fixture-missing outcome, and a hook that rejects unproven DELIVERED reports. The skills mark each of these.

## From lesson to skill

| Lesson | Where it lives |
|---|---|
| Many light builders, integration trains, one release captain, a batch cap, a main freeze | `run-agent-trains` |
| Limit heavy jobs, not agents | `run-agent-trains`, [heavy slots](../skills/run-agent-trains/references/heavy-slots.md) |
| Idle agents take follow-ups | `run-agent-trains`, [follow-up queue](../skills/run-agent-trains/references/follow-up-queue.md) |
| Keep-awake, stale-log alarm, limits, tiering, a second reviewer | `run-agent-trains`, [stalls and limits](../skills/run-agent-trains/references/stalls-and-limits.md) |
| Receipts keyed to the exact tree, honest DELIVERED, a stop-hook gate | `verify-delivery`, [tree-keyed receipts](../skills/verify-delivery/references/tree-keyed-receipts.md) |
| Static and visual design gates, proven red | `design-gates` |
| Spec quality, the brief template, coverage inventory, decision log | `brief-agents` |
| A three-lens retrospective | `audit-agent-program` |

## How the numbers were made, and their limits

Agents parsed two session transcripts, the subagent transcripts, three orchestration logs, 47 release notes, the git history and the runner's journal. Counts come from those files. Impact figures are estimates, and each audit file shows its arithmetic. Agent-hour spans are upper bounds. One cause, the overnight stop, is marked unverified. The parallelism lens parsed 492 subagent transcripts and the throughput lens read 295 of them, so a few counts differ by lens.

This is one program with one owner. The defect classes come from one reviewer reading transcripts and release notes. Models, limits and tools change. The audit files and the transcripts are not published.
