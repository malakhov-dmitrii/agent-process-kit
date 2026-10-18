# Audit brief

Copy this, fill it in and give it to every lens agent. The wording of the goal comes from the operator's own questions.

```text
# Process audit: <program name and dates>

GOAL. An honest retrospective of how the program ran. The operator wants to know:
- what we did and how we did it;
- what worked and what did not;
- how to parallelise;
- how to set tasks and keep control of them;
- how to verify results at this volume.
Every claim needs evidence: a file path, a log line, a commit, or a transcript quote with its time. No impressions.

SOURCES (read-only)
- Session transcripts: <paths>. They are large. Use grep or jq on user messages, timestamps and tool names. Never print a whole file.
- Orchestration state: <ready, trains and orchestrator logs, ledger, task cards, shared briefs>.
- Reports and handoff notes: <paths>.
- The repository: git log of the mainline since <date>, release notes, the release log.
- Production deploy history: build times and revisions from the release notes.
- Memory and notes: <paths>.
- The test runner: its logs, boot history, out-of-memory kills, scripts and their backups.

KNOWN FACTS TO VERIFY, NOT ASSUME
- Incidents: <host reboot, runner overload, session limits, quota outage, deleted worktree>.
- Process changes: <what was rebuilt, when trains and slots were introduced>.
- Defects found by the owner after release: <list>.
- Agent claims against reality: <workflow claims, abandoned boards, waiting agents that re-fired hooks>.

OUTPUT. Each lens writes <dir>/<lens>.md with:
1. Findings, each with evidence, impact (hours lost or defects shipped, an estimate with the method shown) and root cause.
2. What worked and is worth keeping.
3. Recommendations. Each is a rule, a tool or a gate, says where it lives (an instruction line, a skill, a script, a note) and is ranked by payoff.

CONSTRAINTS. Use <time zone> times. Do not change the repository, production or the runner. Write scratch extracts to a directory that is not committed, and say where they are.
```

## Reading large transcripts

Host transcripts are usually JSONL. These extractions answered most questions in the audited program:

- Operator messages with timestamps: the lines where the type is `user`. Count status pings and speed demands, and find the median gap between them.
- Agent runs: the first and last timestamp of every subagent transcript, plus its model and token counts. The notification usage block gives tool uses and duration.
- Limit and error events: count lines that contain the provider's limit message, and group them by minute.
- Receipts in final reports: the first word of each agent's final message.
- Prompts: the text of every agent launch, to measure how briefs were written (see the quality lens).

Keep the scripts you write in a directory you do not run them from, and keep the extracts. A second reader will want to re-run a count.

## Reading the runner

On the test runner, read the boot list, the kernel's out-of-memory lines, the load history if there is one, and every backup of the runner scripts with its date. The script backups show which limit was changed after which incident.
