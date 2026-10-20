CLAIMS=${CLAIMS:-fu-claims}
AGENT=${AGENT:?set AGENT to a name that identifies you}
ID=${1:?usage: claim.sh <ID>}

# An ID names a directory inside CLAIMS, so it must be a plain file name.
case $ID in
  . | *[!A-Za-z0-9._-]* | *..*)
    echo "claim: an ID is a plain name of letters, digits, dot, dash and underscore, without '..': $ID" >&2
    exit 64
    ;;
esac

mkdir -p "$CLAIMS" || exit 2
if mkdir "$CLAIMS/$ID" 2>/dev/null; then
  if printf 'claimed by %s at %s\n' "$AGENT" "$(date '+%Y-%m-%d %H:%M %Z')" >"$CLAIMS/$ID/status.txt"; then
    echo "claimed $ID"
    exit 0
  fi
  rmdir "$CLAIMS/$ID" 2>/dev/null || rm -rf "$CLAIMS/$ID"
  echo "claim: could not record the owner of $ID, so the claim was removed" >&2
  exit 2
fi
echo "$ID is taken: $(head -n 1 "$CLAIMS/$ID/status.txt" 2>/dev/null)" >&2
exit 1
