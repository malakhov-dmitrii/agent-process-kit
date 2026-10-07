#!/usr/bin/env bash
# Operator Transparency context reminder for Claude Code.
# Emits the active task journal pointer on SessionStart/PreCompact.

set -euo pipefail

HOOK_INPUT="$(cat 2>/dev/null || true)"
HOOK_SESSION_ID="$(
  printf '%s' "$HOOK_INPUT" \
    | node -e 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{try{const v=JSON.parse(raw||"{}");console.log(v.session_id||v.sessionId||v.conversation_id||"")}catch{}})' \
    2>/dev/null || true
)"
HOOK_CWD="$(
  printf '%s' "$HOOK_INPUT" \
    | node -e 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{try{const v=JSON.parse(raw||"{}");console.log(v.cwd||v.workspace?.cwd||"")}catch{}})' \
    2>/dev/null || true
)"

if [[ -n "$HOOK_SESSION_ID" ]]; then
  export OPERATOR_TRANSPARENCY_SESSION_ID="$HOOK_SESSION_ID"
fi

RESOLVE_CWD="${HOOK_CWD:-$PWD}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RESOLVER="${AGENT_TASK_RESOLVER:-$SCRIPT_DIR/../bin/resolve-current-task.mjs}"
RESULT="$(node "$RESOLVER" "$RESOLVE_CWD" 2>/dev/null || true)"

if [[ -z "$RESULT" ]]; then
  exit 0
fi

STATUS="$(printf '%s' "$RESULT" | node -e 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(raw).status||"")}catch{}})' 2>/dev/null || true)"
JOURNAL="$(printf '%s' "$RESULT" | node -e 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(raw).journal_path||"")}catch{}})' 2>/dev/null || true)"

case "$STATUS" in
  ok|legacy)
    echo "Operator Transparency: active journal $JOURNAL"
    echo "For 'дай статус' / 'ну что там' / non-trivial work reports, read this journal before answering."
    ;;
  ambiguous)
    echo "Operator Transparency: multiple active task journals found. Ask which task before status."
    ;;
  candidate)
    echo "Operator Transparency: candidate journal $JOURNAL; not bound to this chat. Match it to the latest user request before using task-bind.mjs. A new request must not resume this candidate automatically."
    ;;
  binding-mismatch|broken-binding)
    echo "Operator Transparency: session binding needs repair ($STATUS). Do not substitute another task. Match the current request and explicitly rebind."
    ;;
  missing|broken-pointer)
    echo "Operator Transparency: no active task journal resolved. Match the current request; do not reconstruct verified status from memory."
    ;;
esac

exit 0
