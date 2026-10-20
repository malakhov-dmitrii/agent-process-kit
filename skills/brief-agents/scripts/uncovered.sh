pattern=${1:?usage: uncovered.sh <git-pathspec> <cards-dir> [-b] [exclude-regex]}
cards=${2:?usage: uncovered.sh <git-pathspec> <cards-dir> [-b] [exclude-regex]}
basename_pass=""
if [ "${3:-}" = "-b" ]; then basename_pass=1; shift; fi
exclude=${3:-'\.(test|spec)\.'}

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "uncovered: not inside a git work tree" >&2
  exit 2
}
[ -d "$cards" ] || {
  echo "uncovered: cards directory not found: $cards" >&2
  exit 2
}

all=$(mktemp) && named=$(mktemp) || exit 1
trap 'rm -f "$all" "$named"' EXIT

git ls-files -- "$pattern" | grep -Ev "$exclude" | sort -u >"$all"
grep -rhoE '[A-Za-z0-9_@./-]+/[A-Za-z0-9_@./-]+\.[A-Za-z0-9]+' "$cards" | sort -u >"$named"

total=$(wc -l <"$all" | tr -d ' ')
if [ "$total" -eq 0 ]; then
  echo "uncovered: $pattern matches no tracked files (after the exclude filter), so nothing was checked" >&2
  exit 2
fi
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
