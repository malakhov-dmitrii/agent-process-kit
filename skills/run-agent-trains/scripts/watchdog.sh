LOG=${LOG:?set LOG to the orchestrator log}
OPEN=${OPEN:?set OPEN to the batch-in-flight marker}
MAX_MIN=${MAX_MIN:-30}
marker="$LOG.stall-alerted" # a directory: creating it is the atomic claim to announce this stall

clear_marker() { rmdir "$marker" 2>/dev/null || rm -f "$marker"; }

if [ ! -e "$OPEN" ]; then
  clear_marker
  exit 0
fi

stale=""
if [ ! -e "$LOG" ]; then
  stale="the log $LOG does not exist"
elif [ -n "$(find "$LOG" -maxdepth 0 -mmin +"$MAX_MIN" 2>/dev/null)" ]; then
  stale="no new line in $LOG for more than $MAX_MIN minutes"
fi

if [ -z "$stale" ]; then
  clear_marker
  exit 0
fi

# Claim the alert before sending it, so two overlapping runs cannot both send. A failed send gives
# the claim back and the next run tries again.
mkdir "$marker" 2>/dev/null || exit 0
message="watchdog: a batch is open and $stale"
if [ -n "${NOTIFY:-}" ]; then
  sh -c "$NOTIFY \"\$1\"" watchdog "$message" || {
    rmdir "$marker"
    exit 1
  }
else
  echo "$message"
fi
