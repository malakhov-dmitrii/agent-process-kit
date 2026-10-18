#!/bin/sh
# List tracked source files that no card or spec names. Run it from the repository root.
#
# Usage: sh uncovered.sh <git-pathspec> <cards-dir> [-b] [exclude-regex]
#   sh uncovered.sh 'src/*.tsx' cards/            files whose full path no card names
#   sh uncovered.sh 'src/*.tsx' cards/ -b         also drop files whose basename a card mentions
#
# The exclude regex defaults to test and spec files. The list goes to stdout and the counts
# to stderr. The list is a worklist, not a verdict: open a few files before you write cards.

pattern=${1:?usage: uncovered.sh <git-pathspec> <cards-dir> [-b] [exclude-regex]}
cards=${2:?usage: uncovered.sh <git-pathspec> <cards-dir> [-b] [exclude-regex]}
basename_pass=""
if [ "${3:-}" = "-b" ]; then basename_pass=1; shift; fi
exclude=${3:-'\.(test|spec)\.'}

all=$(mktemp) && named=$(mktemp) || exit 1
trap 'rm -f "$all" "$named"' EXIT

git ls-files -- "$pattern" | grep -Ev "$exclude" | sort -u >"$all"
grep -rhoE '[A-Za-z0-9_@./-]+/[A-Za-z0-9_@./-]+\.[A-Za-z0-9]+' "$cards" | sort -u >"$named"

total=$(wc -l <"$all" | tr -d ' ')
result=$(comm -23 "$all" "$named")
if [ -n "$basename_pass" ]; then
  result=$(printf '%s\n' "$result" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    grep -rqF -- "$(basename "$file")" "$cards" || printf '%s\n' "$file"
  done)
fi
[ -n "$result" ] && printf '%s\n' "$result"
count=0
[ -n "$result" ] && count=$(printf '%s\n' "$result" | wc -l | tr -d ' ')
echo "uncovered: $count of $total files" >&2
