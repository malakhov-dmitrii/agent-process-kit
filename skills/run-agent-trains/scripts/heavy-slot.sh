#!/bin/sh
# Run one heavy command inside a limited number of slots.
#
# Usage: SLOT_DIR=/var/tmp/slots SLOTS=3 RESERVED=1 sh heavy-slot.sh [-r] -- command [args...]
#
#   SLOTS     how many heavy commands may run at once on this machine (default 2)
#   RESERVED  slots kept free for release-class callers (default 1)
#   -r        release class: may use every slot. Other callers may use SLOTS-RESERVED,
#             so a queue of builders cannot starve the release captain.
#   POLL      seconds between attempts while waiting (default 5)
#
# A slot is a directory created with mkdir, which is atomic. A slot whose owner pid is
# gone is reclaimed. Reclaiming is best effort: in a rare race two jobs can share a slot
# for one run. The slots live on one machine; use one SLOT_DIR per machine.

SLOT_DIR=${SLOT_DIR:-${TMPDIR:-/tmp}/heavy-slots}
SLOTS=${SLOTS:-2}
RESERVED=${RESERVED:-1}
POLL=${POLL:-5}

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

slot=""

reclaim() { # reclaim <dir> <dead-pid>
  moved="$1.dead.$$"
  mv "$1" "$moved" 2>/dev/null || return 0
  if [ "$(cat "$moved/pid" 2>/dev/null)" = "$2" ]; then
    rm -rf "$moved"
  else
    mv "$moved" "$1" 2>/dev/null || rm -rf "$moved"
  fi
}

acquire() {
  n=1
  while [ "$n" -le "$limit" ]; do
    dir="$SLOT_DIR/slot-$n"
    if mkdir "$dir" 2>/dev/null; then
      echo $$ >"$dir/pid"
      echo "$class: $*" >"$dir/cmd"
      slot=$dir
      return 0
    fi
    pid=$(cat "$dir/pid" 2>/dev/null)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      reclaim "$dir" "$pid"
      continue
    fi
    # The owner died between mkdir and writing its pid: reclaim after a minute.
    if [ -z "$pid" ] && [ -n "$(find "$dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      reclaim "$dir" ""
      continue
    fi
    n=$((n + 1))
  done
  return 1
}

announced=""
until acquire "$@"; do
  if [ -z "$announced" ]; then
    echo "heavy-slot: waiting for a $class slot (limit $limit of $SLOTS)" >&2
    announced=1
  fi
  sleep "$POLL"
done

# Run the command in the background and wait, so a TERM or INT reaches it and the slot is
# freed only after the command has stopped.
"$@" <&0 &
child=$!
trap 'kill "$child" 2>/dev/null' INT TERM
wait "$child"
rc=$?
wait "$child" 2>/dev/null
rm -rf "$slot"
exit "$rc"
