#!/bin/sh
# Alert once when the orchestrator log has gone quiet while a batch is open.
#
# Usage: LOG=orchestrator-log.md OPEN=batch.open MAX_MIN=30 NOTIFY='your-notify-command' sh watchdog.sh
#
#   LOG      the file the captain appends to on every step
#   OPEN     a marker file that exists while a batch is in flight (touch it at batch start)
#   MAX_MIN  minutes of silence that count as a stall (default 30)
#   NOTIFY   a command that receives the message as its last argument, for example a chat
#            or push-notification sender. If unset, the message goes to stdout.
#
# Run it every few minutes from cron or launchd. It alerts once per stall and clears
# itself when the log changes again.

LOG=${LOG:?set LOG to the orchestrator log}
OPEN=${OPEN:?set OPEN to the batch-in-flight marker}
MAX_MIN=${MAX_MIN:-30}
marker="$LOG.stall-alerted"

if [ ! -e "$OPEN" ]; then
  rm -f "$marker"
  exit 0
fi

stale=""
if [ ! -e "$LOG" ]; then
  stale="the log $LOG does not exist"
elif [ -n "$(find "$LOG" -maxdepth 0 -mmin +"$MAX_MIN" 2>/dev/null)" ]; then
  stale="no new line in $LOG for more than $MAX_MIN minutes"
fi

if [ -z "$stale" ]; then
  rm -f "$marker"
  exit 0
fi

[ -e "$marker" ] && exit 0
message="watchdog: a batch is open and $stale"
if [ -n "${NOTIFY:-}" ]; then
  sh -c "$NOTIFY \"\$1\"" watchdog "$message" && : >"$marker"
else
  echo "$message"
  : >"$marker"
fi
