# heavy-slot.sh: a best-effort limit on how many heavy commands run at once on ONE host. It is a
# helper, not a lock service, and each of these can admit one extra job:
#  - a job that is paused for more than a minute after it created its claim and before it wrote
#    its pid (the claim then looks abandoned and another job takes the slot);
#  - a job that is paused for more than RETAIN minutes between reading a slot and creating its
#    claim (a swept claim number can come back);
#  - a wrapper pid that the system reuses (the claim then looks alive for too long, which only
#    delays other jobs);
#  - a command that starts its own session, which leaves the process group the wrapper stops.
SLOT_DIR=${SLOT_DIR:-${TMPDIR:-/tmp}/heavy-slots}
SLOTS=${SLOTS:-2}
RESERVED=${RESERVED:-1}
POLL=${POLL:-5}
GRACE=${GRACE:-10}
RETAIN=${RETAIN:-60}        # minutes a finished claim stays before a later claim may sweep it
START_WAIT=${START_WAIT:-3} # minutes a dead wrapper's claim stays held while its command may still be starting

class=builder
if [ "${1:-}" = "-r" ]; then class=release; shift; fi
if [ "${1:-}" = "--" ]; then shift; fi
if [ "$#" -eq 0 ]; then
  echo "usage: heavy-slot.sh [-r] -- command [args...]" >&2
  exit 64
fi

limit=$SLOTS
if [ "$class" = builder ]; then limit=$((SLOTS - RESERVED)); fi
if [ "$limit" -lt 1 ]; then limit=1; fi
mkdir -p "$SLOT_DIR" || exit 1

# One claim on slot N is the directory slot-N.G. G only grows, so creating slot-N.<latest+1> is the
# single atomic step that makes a job the owner. A claim is never deleted by the job that owns it:
# a finished claim stays as a marker (`released`), and a later claim sweeps only claims that are
# stale and at least RETAIN minutes old. That keeps the common races out. The pauses listed at the
# top are the ones it does not cover.
slot=""       # the claim directory this wrapper owns
child=""      # the command's pid; with a group it is also the process group id
grouped=""    # set when the command leads its own process group
launching=""  # set while the command is being started
early=""      # a signal that arrived while it was being started
pending=""    # set by a signal handler, read by the wait loop
timer=""      # the subshell that escalates to KILL
reaped=""     # set once the command itself has been waited for
exit_code=""  # set when a signal stopped the wrapper

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
group_alive() { [ -n "$1" ] && kill -0 "-$1" 2>/dev/null; }
nap() { sleep "$1" 2>/dev/null || sleep 1; }

latest() { # latest <n>: the highest claim number of slot n, 0 when there is none
  _top=0
  for _d in "$SLOT_DIR/slot-$1."*; do
    [ -d "$_d" ] || continue
    _g=${_d##*.}
    case $_g in '' | *[!0-9]*) continue ;; esac
    if [ "$_g" -gt "$_top" ]; then _top=$_g; fi
  done
  echo "$_top"
}

# A claim is stale when its owner released it, or its wrapper and every process of its command's
# group are gone. Staleness never reverts, which is what makes claiming over it safe.
claim_stale() { # claim_stale <dir>
  [ -e "$1/released" ] && return 0
  _owner=$(cat "$1/pid" 2>/dev/null)
  if [ -z "$_owner" ]; then
    # not recorded yet, or the owner died before it could: give it a minute (see the header)
    [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]
    return
  fi
  alive "$_owner" && return 1
  _pg=$(cat "$1/pgid" 2>/dev/null)
  if [ -n "$_pg" ]; then
    # the command publishes its group id only once the group exists
    group_alive "$_pg" && return 1
    return 0
  fi
  # No group on record and the wrapper is gone: it died before its command published one. The
  # command may still be starting, so the claim keeps the slot until it is START_WAIT minutes old.
  [ -z "$(find "$1" -maxdepth 0 -mmin +"$START_WAIT" 2>/dev/null)" ] && return 1
  return 0
}

sweep() { # sweep <n> <keep>: remove claims of slot n below <keep> that are stale and past RETAIN
  for _d in "$SLOT_DIR/slot-$1."*; do
    [ -d "$_d" ] || continue
    _g=${_d##*.}
    case $_g in '' | *[!0-9]*) continue ;; esac
    [ "$_g" -lt "$2" ] || continue
    claim_stale "$_d" || continue
    [ -n "$(find "$_d" -maxdepth 0 -mmin +"$RETAIN" 2>/dev/null)" ] && rm -rf "$_d"
  done
}

acquire() {
  n=1
  while [ "$n" -le "$limit" ]; do
    g=$(latest "$n")
    if [ "$g" -gt 0 ] && ! claim_stale "$SLOT_DIR/slot-$n.$g"; then
      n=$((n + 1))
      continue
    fi
    dir="$SLOT_DIR/slot-$n.$((g + 1))"
    if mkdir "$dir" 2>/dev/null; then
      slot=$dir
      echo $$ >"$dir/pid"
      echo "$class: $*" >"$dir/cmd"
      sweep "$n" "$((g + 1))"
      return 0
    fi
    # another job took that number first: look at the slot again. Anything else, move on.
    [ -d "$dir" ] || n=$((n + 1))
  done
  return 1
}

# Give the slot back by marking this wrapper's own claim. Nothing outside it is touched.
release() {
  [ -n "$slot" ] || return 0
  { echo released >"$slot/released"; } 2>/dev/null
  slot=""
}

signal_workload() { # signal_workload <NAME>
  if [ -n "$grouped" ]; then
    kill "-$1" "-$child" 2>/dev/null && return 0
    # the group may not exist yet while setsid or perl is still starting
    [ -n "$reaped" ] || kill "-$1" "$child" 2>/dev/null
  else
    [ -n "$reaped" ] || kill "-$1" "$child" 2>/dev/null
  fi
}

on_signal() { # on_signal <NAME> <exit code>
  exit_code=$2
  if [ -n "$child" ]; then
    pending=1
    signal_workload "$1"
    # arm the escalation here, where no other step can run between the signal and the timer
    if [ -z "$timer" ]; then
      (
        sleep "$GRACE"
        signal_workload KILL
      ) &
      timer=$!
    fi
  elif [ -n "$launching" ]; then
    early=$1
  else
    exit "$2"
  fi
}

# Start the command as the leader of its own process group, so a signal or a final sweep reaches
# its descendants too. Job control needs no tool but a tty-less dash cannot do it, so then use
# setsid, then perl. Without any of them only the command itself can be stopped. The command
# publishes its own group id into the claim, from inside the group and before it runs, so a
# wrapper that dies right after starting it still leaves the group on record, and one that could
# not be recorded does not run at all.
launch() {
  set -- sh -c '{ echo $$ >"$1"; } 2>/dev/null || { echo "heavy-slot: cannot record the command group, so the command was not run" >&2; exit 70; }; shift; exec "$@"' heavy-slot "$slot/pgid" "$@"
  if (set -m 2>/dev/null; sleep 5 </dev/null & p=$!; r=1; kill -0 "-$p" 2>/dev/null && r=0; kill "$p" 2>/dev/null; exit "$r") >/dev/null 2>&1; then
    set -m
    "$@" </dev/null &
    child=$!
    set +m
    grouped=1
  elif command -v setsid >/dev/null 2>&1; then
    setsid "$@" </dev/null &
    child=$!
    grouped=1
  elif command -v perl >/dev/null 2>&1; then
    perl -e 'setpgrp(0, 0); exec @ARGV; print STDERR "heavy-slot: $ARGV[0]: $!\n"; exit 127' -- "$@" </dev/null &
    child=$!
    grouped=1
  else
    echo "heavy-slot: no job control, setsid or perl here: only the command itself can be stopped" >&2
    "$@" </dev/null &
    child=$!
  fi
}

# Stop what is left of the command's group: TERM, then KILL after GRACE seconds.
stop_group() {
  [ -n "$grouped" ] && group_alive "$child" || return 0
  [ -n "$exit_code" ] || echo "heavy-slot: stopping processes the command left behind" >&2
  signal_workload TERM
  end=$(($(date +%s) + GRACE))
  while group_alive "$child"; do
    if [ "$(date +%s)" -ge "$end" ]; then signal_workload KILL; fi
    nap 0.1
  done
}

trap release EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

announced=""
until acquire "$@"; do
  if [ -z "$announced" ]; then
    echo "heavy-slot: waiting for a $class slot (limit $limit of $SLOTS)" >&2
    announced=1
  fi
  sleep "$POLL" &
  wait "$!"
done

launching=1
launch "$@"
launching=""
[ -z "$early" ] || on_signal "$early" "$exit_code"

rc=0
while :; do
  pending=""
  wait "$child"
  rc=$?
  [ -n "$pending" ] || break
done
reaped=1

stop_group
if [ -n "$timer" ]; then
  kill "$timer" 2>/dev/null
  wait "$timer" 2>/dev/null
fi
[ -z "$exit_code" ] || rc=$exit_code
exit "$rc"
