# CLI reference

Use `agent-process-kit --help`, or `node bin/agent-process-kit.mjs --help` from source.

## State

Global `--state-dir DIR` overrides inherited root settings for that call. Otherwise the runtime accepts `AGENT_TASK_TRACE_ROOT` as an explicit compatibility override, then `AGENT_PROCESS_STATE_DIR`, then `~/.agent-process-kit`.

Session ID can come from `--session`, `OPERATOR_TRANSPARENCY_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID` or `CLAUDE_SESSION_ID`. Use the current session's unique ID. Labels coordinate work; they do not authenticate users.

| Command | Options |
|---|---|
| `init` | `--task ID`, optional `--project DIR --goal TEXT` |
| `bind` | `--task ID --journal FILE --repo DIR`; optional `--session --host --worktree --replace OLD_TASK --dry-run` |
| `status` | Optional workspace path; JSON result |
| `check` | `--task ID --journal FILE` |
| `handoff` | `--to claude\|codex\|grok --next TEXT`; optional `-C DIR --dry-run` |
| `setup`, `rollback` | Optional `--project DIR --apply`; dry-run by default |
| `review` | `--kind plan\|code --target FILE\|REF --task ID --model MODEL`; optional `-C DIR` |
| `hook` | `--host claude\|codex --event EVENT`; host JSON from stdin |

Accept a transfer with the receiver's own session:

```sh
agent-process-kit bind --task TASK --journal JOURNAL --repo WORKTREE \
  --session RECEIVER_SESSION --host claude --accept-handoff HANDOFF_ID
```

Intentional task replacement requires `--replace OLD_TASK`. Preparing a command is not acknowledgement.

## Exit codes

- `check`: 0 for a recorded checklist that is ready; 2 for incomplete/invalid.
- `bind`, `init`, `setup`, `rollback`, `handoff`: 0 for success/preview; 2 for validation/refusal.
- `status`: 0 for resolved context or candidate; nonzero for broken, missing, pending or ambiguous context.
- Hooks use their host-facing structured decision; process success alone is not verification.

## Optional review

Requires an installed/authorized Codex CLI. Select `--model` or configure `modelRouting.secondOpinion`. The wrapper uses read-only review and JSON output, with two completed rounds per task/kind by default. Model availability and reasoning support depend on the installed CLI/account.

`REVIEW_CODEX_BIN` selects the executable; `REVIEW_STATE_DIR` selects state. Reviews never run during tests or setup. Review feedback does not replace execution evidence.
