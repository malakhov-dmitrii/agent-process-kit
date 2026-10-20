# Tree-keyed gate receipts. Source this file from the gate script and from the deploy script.
#
# RECEIPT_PATHS is a whitespace-separated list of paths relative to the repository root: no
# globs, no spaces in a name. Every function works from the repository root, whatever the
# current directory is.
#
# A gate run is receipt_invalidate ... receipt_write in one script. receipt_invalidate leaves a
# numbered start record for the run, and a receipt stays usable only while no start record has a
# higher number than the run that passed. A red or crashed run therefore blocks reuse, even when
# it overlaps with a run that passed, and no clock is involved.

_receipt_top() {
  git rev-parse --show-toplevel 2>/dev/null || {
    echo "receipt: not inside a git work tree" >&2
    return 1
  }
}

# Print RECEIPT_PATHS one per line, normalised, or fail when it is empty or names a path that is
# not a plain path inside the repository.
_receipt_paths() {
  _words=$(printf '%s\n' "$RECEIPT_PATHS" | tr -s ' \t' '\n' | sed -e '/^$/d')
  if [ -z "$_words" ]; then
    echo "receipt: RECEIPT_PATHS is empty, and a key over no paths would match every commit" >&2
    return 1
  fi
  printf '%s\n' "$_words" | while IFS= read -r _w; do
    _orig=$_w
    while :; do
      case $_w in ./*) _w=${_w#./} ;; *) break ;; esac
    done
    while :; do
      case $_w in */) _w=${_w%/} ;; *) break ;; esac
    done
    [ -n "$_w" ] || _w=.
    case $_w in
      /* | :* | .. | ../* | */.. | */../* | */. | */./* | *//*)
        echo "receipt: RECEIPT_PATHS must name plain paths inside the repository (no '..', no '.' segment, no '//', no leading '/' or ':'), not: $_orig" >&2
        exit 1
        ;;
    esac
    printf '%s\n' "$_w"
  done
}

receipt_key() { # receipt_key [rev]  ->  prints the key; on any problem prints nothing and fails
  _rev=${1:-HEAD}
  _top=$(_receipt_top) || return 1
  _paths=$(_receipt_paths) || return 1
  _commit=$(git -C "$_top" rev-parse --verify -q "$_rev^{commit}") || {
    echo "receipt: not a commit: $_rev" >&2
    return 1
  }
  # Each line is "<mode> <type> <object id> <path>" as `git ls-tree` reports it, so a change of
  # file mode, of type (file, symlink, submodule) or of content gives a new key.
  _parts="receipt-key-2
"
  _found=""
  while IFS= read -r _p; do
    if [ "$_p" = . ]; then
      _tree=$(git -C "$_top" rev-parse --verify -q "$_commit^{tree}") && _entry="040000 tree $_tree"
    else
      _entry=$(git --literal-pathspecs -C "$_top" ls-tree "$_commit" -- "$_p" | cut -f 1)
      case $_entry in
        *"
"*)
          echo "receipt: $_p matches more than one entry at $_rev, so it cannot be keyed as one path" >&2
          return 1
          ;;
      esac
    fi
    if [ -n "$_entry" ]; then _found=1; else _entry=absent; fi
    _parts="$_parts$_entry $_p
"
  done <<EOF
$_paths
EOF
  if [ -z "$_found" ]; then
    echo "receipt: none of RECEIPT_PATHS exists at $_rev" >&2
    return 1
  fi
  printf '%s' "$_parts" | git hash-object --stdin
}

receipt_file() { # receipt_file <key>
  case ${1:-} in
    '' | *[!0-9a-f]*)
      echo "receipt: not a key: ${1:-}" >&2
      return 1
      ;;
  esac
  _top=$(_receipt_top) || return 1
  _common=$(cd "$_top" && cd "$(git rev-parse --git-common-dir)" && pwd) || return 1
  printf '%s/gate-receipts/%s' "$_common" "$1"
}

receipt_clean() { # true when nothing under RECEIPT_PATHS differs from HEAD, untracked files included
  _top=$(_receipt_top) || return 1
  _paths=$(_receipt_paths) || return 1
  while IFS= read -r _p; do
    if [ -n "$(git --literal-pathspecs -C "$_top" status --porcelain --untracked-files=all -- "$_p")" ]; then
      echo "receipt: uncommitted changes under $_p" >&2
      return 1
    fi
  done <<EOF
$_paths
EOF
}

_receipt_store() { # _receipt_store <key> <line>
  _file=$(receipt_file "$1") || return 1
  if mkdir -p "$(dirname "$_file")" && printf '%s\n' "$2" >"$_file.tmp.$$" && mv "$_file.tmp.$$" "$_file"; then
    return 0
  fi
  rm -f "$_file.tmp.$$" 2>/dev/null
  echo "receipt: could not store the receipt for $1" >&2
  return 1
}

receipt_invalidate() { # receipt_invalidate <key> [flag=value ...]  ->  start of a gate run: an earlier pass stops counting
  _key=${1:-}
  [ "$#" -ge 1 ] && shift
  _file=$(receipt_file "$_key") || return 1
  _dir="$_file.d"
  mkdir -p "$_dir" || {
    echo "receipt: could not record the start of a gate run for $_key" >&2
    return 1
  }
  # A start record is a symlink named start.<n>, which carries "<pid> <time> ..." as its text. A
  # link is created whole or not at all, and n only grows, so the order of runs is the order of n.
  _info="$$ $(date -u +%FT%TZ) commit=$(git rev-parse --verify -q HEAD) $*"
  _n=$(_receipt_last "$_dir")
  _tries=0
  while :; do
    _n=$((_n + 1))
    _tries=$((_tries + 1))
    if ln -s "$_info" "$_dir/start.$_n" 2>/dev/null; then
      RECEIPT_RUN=$_n
      return 0
    fi
    if [ ! -L "$_dir/start.$_n" ] || [ "$_tries" -gt 1000 ]; then
      echo "receipt: could not record the start of a gate run for $_key" >&2
      return 1
    fi
  done
}

_receipt_last() { # _receipt_last <dir>: the highest start number, 0 when there is none
  _last=0
  for _s in "$1"/start.*; do
    _num=${_s##*.}
    case $_num in '' | *[!0-9]*) continue ;; esac
    if [ "$_num" -gt "$_last" ]; then _last=$_num; fi
  done
  echo "$_last"
}

receipt_write() { # receipt_write <key> <commit> [flag=value ...]  ->  after a green run on a clean checkout
  _key=${1:-}
  _commit=${2:-}
  [ "$#" -ge 2 ] && shift 2 || shift "$#"
  if [ -z "$_key" ] || [ -z "$_commit" ]; then
    echo "receipt: usage: receipt_write <key> <commit> [flag=value ...]" >&2
    return 1
  fi
  receipt_clean || {
    echo "receipt: the tested tree is not clean, nothing written" >&2
    return 1
  }
  _tested=$(receipt_key "$_commit") || return 1
  _head=$(receipt_key HEAD) || return 1
  if [ "$_tested" != "$_key" ] || [ "$_head" != "$_key" ]; then
    echo "receipt: $_key is not the key of $_commit and of the checked-out HEAD, nothing written" >&2
    return 1
  fi
  _file=$(receipt_file "$_key") || return 1
  _dir="$_file.d"
  # A write without an earlier receipt_invalidate in this shell is a run of its own.
  if [ -z "${RECEIPT_RUN:-}" ] || [ ! -L "$_dir/start.$RECEIPT_RUN" ]; then
    receipt_invalidate "$_key" || return 1
  fi
  _mine=$RECEIPT_RUN
  # Another run of this tree that is still going may still turn out red.
  for _s in "$_dir"/start.*; do
    [ -L "$_s" ] || continue
    [ "$_s" = "$_dir/start.$_mine" ] && continue
    _pid=$(readlink "$_s" | cut -d ' ' -f 1)
    if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
      echo "receipt: another gate run of $_key is still in progress (pid $_pid), nothing written" >&2
      return 1
    fi
  done
  _receipt_store "$_key" "$(date -u +%FT%TZ) commit=$_commit run=$_mine $*" || return 1
  RECEIPT_RUN=""
}

receipt_read() { # receipt_read <key>  ->  prints the receipt line
  _file=$(receipt_file "${1:-}") || return 1
  [ -s "$_file" ] && cat "$_file"
}

receipt_has() { # receipt_has <key> <flag=value>
  _line=$(receipt_read "${1:-}") || return 1
  case " $_line " in *" ${2:-} "*) return 0 ;; *) return 1 ;; esac
}

receipt_reuse() { # receipt_reuse <flag=value ...>  ->  0 only when HEAD may ship on a receipt
  receipt_clean || {
    echo "receipt: no reuse, the keyed paths have uncommitted changes or are not usable" >&2
    return 1
  }
  _key=$(receipt_key HEAD) || return 1
  _line=$(receipt_read "$_key") || {
    echo "receipt: no receipt for $_key" >&2
    return 1
  }
  _file=$(receipt_file "$_key") || return 1
  _dir="$_file.d"
  _run=$(printf '%s\n' "$_line" | sed -n 's/.* run=\([0-9]*\)\( .*\)\{0,1\}$/\1/p')
  if [ -z "$_run" ] || [ ! -L "$_dir/start.$_run" ]; then
    echo "receipt: the receipt for $_key has no run record" >&2
    return 1
  fi
  if [ "$(_receipt_last "$_dir")" -gt "$_run" ]; then
    echo "receipt: a gate run of $_key started after the one that passed, and has not passed since" >&2
    return 1
  fi
  for _flag in "$@"; do
    case " $_line " in
      *" $_flag "*) ;;
      *)
        echo "receipt: no receipt for $_key with $_flag" >&2
        return 1
        ;;
    esac
  done
  printf '%s\n' "$_line"
}
