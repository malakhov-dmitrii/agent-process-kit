#!/bin/sh
# Claim one follow-up item so two idle agents never take the same one.
#
# Usage: CLAIMS=fu-claims AGENT=builder-7 sh claim.sh FU-03
#
# mkdir is atomic: exactly one caller creates the directory. Exit 0 means you own the item.
# Exit 1 means another agent owns it, and the owner is printed. Write progress to
# $CLAIMS/<ID>/status.txt, and delete nothing that another agent put there.

CLAIMS=${CLAIMS:-fu-claims}
AGENT=${AGENT:?set AGENT to a name that identifies you}
ID=${1:?usage: claim.sh <ID>}

mkdir -p "$CLAIMS" || exit 2
if mkdir "$CLAIMS/$ID" 2>/dev/null; then
  printf 'claimed by %s at %s\n' "$AGENT" "$(date '+%Y-%m-%d %H:%M %Z')" >"$CLAIMS/$ID/status.txt"
  echo "claimed $ID"
  exit 0
fi
echo "$ID is taken: $(head -n 1 "$CLAIMS/$ID/status.txt" 2>/dev/null)" >&2
exit 1
