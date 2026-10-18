#!/bin/sh
# Tree-keyed gate receipts. Source this file from the gate script and the deploy script:
#
#   RECEIPT_PATHS="src scripts Dockerfile"
#   . ./gate-receipt.sh
#
# gate script, after a green run on the commit it tested:
#   receipt_write "$(receipt_key "$commit")" "$commit" gate=pass design=pass
# deploy script, before shipping HEAD:
#   receipt_reuse gate=pass design=pass || run_the_gate_again_or_stop
#
# The key is a hash of the git tree ids of RECEIPT_PATHS. List every path that the shipped
# artifact or the gate reads. A change anywhere else, such as docs, leaves the key alone, so
# a docs-only commit keeps its receipt. A change under a listed path gives a new key and
# the old receipt no longer matches.
#
# Receipts live in the shared git dir, so every worktree of the repository sees them.

receipt_key() { # receipt_key [rev]  ->  prints the key
  _rev=${1:-HEAD}
  _parts=""
  for _p in $RECEIPT_PATHS; do
    _id=$(git rev-parse --verify -q "$_rev:$_p") || _id=absent
    _parts="$_parts$_p $_id
"
  done
  printf '%s' "$_parts" | git hash-object --stdin
}

receipt_file() { # receipt_file <key>
  _dir=$(cd "$(git rev-parse --git-common-dir)" && pwd) || return 1
  printf '%s/gate-receipts/%s' "$_dir" "$1"
}

receipt_clean() { # true when nothing under RECEIPT_PATHS differs from HEAD
  # shellcheck disable=SC2086 # RECEIPT_PATHS is a word list
  [ -z "$(git status --porcelain -- $RECEIPT_PATHS)" ]
}

receipt_write() { # receipt_write <key> <commit> [flag=value ...]
  _key=$1
  _commit=$2
  shift 2
  if [ "$(receipt_key "$_commit")" != "$_key" ]; then
    echo "receipt: $_key is not the key of $_commit, nothing written" >&2
    return 1
  fi
  _file=$(receipt_file "$_key") || return 1
  mkdir -p "$(dirname "$_file")" || return 1
  printf '%s commit=%s %s\n' "$(date -u +%FT%TZ)" "$_commit" "$*" >"$_file.tmp.$$" &&
    mv "$_file.tmp.$$" "$_file"
}

receipt_read() { # receipt_read <key>  ->  prints the receipt line
  _file=$(receipt_file "$1") || return 1
  [ -s "$_file" ] && cat "$_file"
}

receipt_has() { # receipt_has <key> <flag=value>
  _line=$(receipt_read "$1") || return 1
  case " $_line " in *" $2 "*) return 0 ;; *) return 1 ;; esac
}

receipt_reuse() { # receipt_reuse <flag=value ...>  ->  0 only when HEAD may ship on a receipt
  receipt_clean || {
    echo "receipt: uncommitted changes under the keyed paths, no reuse" >&2
    return 1
  }
  _key=$(receipt_key HEAD)
  for _flag in "$@"; do
    receipt_has "$_key" "$_flag" || {
      echo "receipt: no receipt for $_key with $_flag" >&2
      return 1
    }
  done
  receipt_read "$_key"
}
