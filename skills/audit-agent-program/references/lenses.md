# The three lenses

Give each lens agent the audit brief, the finding format and its own section here. Do not let a lens read the others until reconciliation.

## Throughput and timeline

Question: where did wall-clock time go, and what was the constraint in each period?

Produce:

1. A timeline of phases: window, what was built, what shipped (revision and time).
2. Throughput per day: cards live, fix releases, owner messages and status pings.
3. Cycle time from "built" to "live", in cohorts by release, with n, median and range. Split it into integration time and shipping time.
4. Stage time per batch: start, gate runs, gate green, UAT done, live, production check, start to live, and the stalls inside.
5. The stall table with cost and method.
6. Status pings and ETA accuracy: each promise, the actual time, the error. Separate next-release ETAs from program ETAs.
7. The bottleneck by period, with the number that shows it.

In the audited program the lens showed that the constraint moved. It was planning and foundations on the first day, local compute on the second, provider availability on the third, integration and serial shipping during the burst, and input (new scope and post-release defects) at the end.

## Quality and control

Question: why did defects escape, and how were tasks set?

Produce:

1. The defect table: what, who found it and when, whether it was in production, primary and secondary cause, evidence, and the gate or rule that would have caught it. Use the classes in `brief-agents`: spec or coverage, verification, brief, churn, regression, ignored rule.
2. Class totals and a rework estimate in agent-hours.
3. A scan of every agent prompt. Count the share that refer to a shared brief, state non-goals, copy the owner's rules, require TDD, demand a full final report, state widths, require a production check and state acceptance criteria. In the audited program only 7 of 138 prompts, 5 percent, had explicit done-when criteria, and 71 were under 1,000 characters because they pointed at a shared file.
4. A judged sample of about 14 prompts: clarity, acceptance, rules, proof required, verdict.
5. Agent finals against reality: the receipts used, how many DELIVERED finals admit missing proof, how many ended early, how many were duplicate notices.
6. Measurements: UAT steps skipped for missing data, what the reviewer found by kind (behavior, geometry, test quality, merge drift), and review rounds per release.
7. A brief template that would have prevented the defects, and the share of defects it covers.

## Parallelism and infrastructure

Question: how was the work split, and what did the split cost?

Produce:

1. Agents and wall time by role: count, model, span, agent-hours, output tokens and context tokens.
2. Concurrency over time in 10-minute bins: peak, mean, minutes above ten agents.
3. Release cadence: batch, start to live, content, main merges mid-batch, gate runs.
4. Runner utilization by day, and its limits: memory, out-of-memory kills, load, reboots, and the history of the runner scripts.
5. Limits and stops: session and weekly limits, quota, network drops, with the agents each one ended.
6. How the work was cut: file overlap between trains, hot files, stale bases, discarded lanes.
7. A target architecture for the next program: roles, resource classes for heavy jobs, test-data rules, model and reviewer rules, what to script and what to leave to an agent.

In the audited program the context of the single captain agent was the largest single item: 1.29 billion context tokens, 16 percent of everything the session's agents read. The lens found it by summing context tokens per agent.

## Reconciliation

After all three files exist, one agent reads them together and does the work in steps 4 to 6 of the skill: remove double counts, decide contradictions, rank, and write the one-page report. Keep the lens files as evidence.
