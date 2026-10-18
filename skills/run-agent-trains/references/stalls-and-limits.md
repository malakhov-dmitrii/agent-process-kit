# Stalls and limits

Four things stopped the audited program for hours: a host that went quiet, background waits nobody was watching, session and weekly limits, and noise from waiting agents. Each has a cheap guard. Only some guards were run in the program, and each section says which.

## Keep the host awake

Between 02:03 and 07:18 on one night, the captain's last tool call was pending, no subagent was active from 03:00 to 06:59, and no API or limit error was logged. The next event was the owner's status ping. The host's sleep history had rotated out, so host sleep is the likely cause but was never verified. The stop cost about 5 hours 15 minutes on the critical path.

Wrap the orchestrator in a keep-awake command for as long as it lives:

```sh
caffeinate -dimsu -w "$ORCHESTRATOR_PID" &        # macOS
systemd-inhibit --what=idle:sleep --why="orchestrator" sleep infinity &   # Linux, kill it when done
```

Recommended after the audit, not yet run in the program.

## Alarm on a quiet log

[`scripts/watchdog.sh`](../scripts/watchdog.sh) alerts once when the captain's log has not changed for `MAX_MIN` minutes while a batch is open. It needs a `batch.open` marker that the captain creates at batch start and removes at the end.

```sh
*/5 * * * * LOG=$HOME/scratch/orchestrator-log.md OPEN=$HOME/scratch/batch.open MAX_MIN=30 NOTIFY='send-chat-message' sh /path/to/watchdog.sh
```

`NOTIFY` receives the message as its last argument. The alert repeats only after the log has moved and gone quiet again. Add a second check of the same shape for the test runner: probe it, and alert after two failed probes in a row.

Recommended after the audit. The script is tested here with a planted quiet log and has not run in a real program yet.

## Put a deadline on every background wait

The captain sat for 5.2 hours on a background gate command because it waited for a completion notice and nothing else. Wait on the condition with a limit:

```sh
deadline=$(( $(date +%s) + 1800 ))
until [ -f "$DONE_FILE" ] || [ "$(date +%s)" -ge "$deadline" ]; do sleep 20; done
[ -f "$DONE_FILE" ] || { echo "timed out waiting for $DONE_FILE" >&2; exit 75; }
```

A timeout is information. Log it, look at the job, and decide.

## Plan for session and weekly limits

What happened:

- A weekly limit on one provider stopped every agent of that provider for 20.5 calendar hours (about 12.6 working hours). A second vendor's agent kept the program moving and shipped 23 cards in 5 releases in that time.
- A session limit ended 29 agents at once, including all five trains and the captain. The captain was idle for 2.4 hours.
- After the owner moved builders to the cheaper tier, a second session limit still ended 15 agents, cheaper-tier agents among them. The session cap bound across models.
- A network drop ended 3 agents. One reviewer's quota ran out in the middle of a release, and a substitute reviewer approved about 20 minutes later.

What to do:

1. Tier the models. Builders and integrators run on the cheaper tier. The captain, P0 fixes and reviews run on the strongest. This only helps when the cheaper tier has its own headroom, so check before you launch.
2. Budget the session, not the model. The audit recommends about 10 live agents at once. Twenty-one concurrent agents plus one long-lived captain drained a session in about three hours.
3. Keep every agent's context small. Do not run the captain as one long-lived agent. See the failure modes in the skill.
4. Keep a second reviewer ready, from a different provider if you can. Use it when the first is out of quota. Record the substitution in the release note. Do not loop on a failed reviewer.
5. Give a second provider mechanical batches on a frozen base. It was a good reviewer, a good fallback implementer for mechanical sweeps, and a poor per-card implementer in iterative fix loops. Never run its sweep in parallel with trains that edit the same files. One such sweep conflicted in 138 files and was discarded.
6. Make every agent resumable. Each agent keeps a resume brief and updates it at each step. A fresh agent can then continue without a nudge. In the program, 25 agents that ended early each needed a new resume agent, briefed by hand with 2.6 to 4.3 thousand characters.

```text
RESUME <card-id or agent name>
Goal: <one sentence>
Last receipt: <what is finished, with sha or log line>
Remaining: <numbered steps>
Next safe action: <one command or step>
Do not repeat: <steps already done>
```

## Waiting agents and the stop hook

A stop hook that checks final reports fires again each time a waiting agent says "still waiting". In the audited program 54 subagents produced 164 echo replies, and 58 of 199 final notifications were duplicates while 48 more said "waiting on background work". Each one cost the main session a turn. Deduplicate notices by agent id and content hash, and do not treat a waiting agent as finished.

## Scratch must survive

Keep reports, screenshots, logs and saved logins in a durable directory outside the repository and outside the temp folder. Commit work in small steps, so a crash loses minutes.
