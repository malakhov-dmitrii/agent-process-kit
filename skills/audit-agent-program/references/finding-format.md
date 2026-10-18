# Finding format

Every lens uses the same shape, so the findings can be merged.

```text
### F<n>. <one sentence that states the finding>
Evidence: <file path, log line, commit, or a quote with its time. More than one if you have them.>
Impact: <hours lost or defects shipped, as an estimate, with the arithmetic.>
Root cause: <the mechanism in one or two sentences. Write "unverified" when no one checked.>
```

Example, using numbers from the audited program:

```text
### F1. A batch that merged several trains took more than five times as long as a single-train batch
Evidence: orchestrator log lines at 17:20 and 01:41 (8 h 21 m, 19 cards, two trains) against lines at 12:26 and 14:01 (1 h 35 m, one train).
Impact: about 10 hours of captain time across two large batches. Estimate: the two large batches took 17.7 hours, and six to eight one-hour batches would have taken about 7.
Root cause: every extra branch raised the odds of a conflict or a red test, and each one restarted a 10 to 25 minute gate and a UAT run. Trains were cut by area, so they edited the same files.
```

## Estimating impact

| Situation | Method |
|---|---|
| A stall with a start and an end in the log | the difference, direct |
| Work waited on a stall | the gap between the two merge or deploy timestamps |
| Reruns | rerun count x duration of one gate or UAT run, plus the diagnosis |
| Defects | rework agent-hours from the notification durations, plus an estimate for runs with no usage data, and say which part is which |
| Agent-hours | span from first to last timestamp is an upper bound. Builders' spans are close to work. Any agent that waited on a background job has a span much larger than its work |

Write the arithmetic next to every estimate. Mark each stall with the lens that counted it. When two lenses count the same stall, the program total counts it once.

## The stall table

```text
| # | Stall | When | Evidence | Lanes hit | Critical-path cost | How estimated |
```

One row per stall. In the audited program the table totalled about 38 hours of delay over a 114-hour program, with overlaps removed. Separately, the captain sat 11.5 hours idle because the queue was empty. That is starved input, so keep it out of the stall total.

## The recommendation row

```text
| # | Rule, tool or gate | Saves (estimate, from the findings) | Where it lives |
```

Each recommendation is something you can build and then watch fail or pass. "Be more careful" is not a recommendation. Rank rows by the hours or defects saved.
