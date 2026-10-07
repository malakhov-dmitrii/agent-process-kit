# Setup and host integration

Lifecycle commands run directly from source or an installed release tarball. Global host configuration is optional.

```sh
agent-process-kit setup --project /path/to/project
agent-process-kit setup --project /path/to/project --apply
```

The first call previews files. The second creates `.agent-process-kit/` with instructions, hook examples and a rollback receipt. It refuses an existing destination and does not edit AGENTS.md, global settings, permissions or credentials. Consider ignoring this generated machine-local folder in project Git.

Merge relevant rules into existing instructions, preserving operator sections and stricter project policies. Do not activate every optional skill by default.

## Hooks

Generated JSON is an example, not an installed configuration. Merge it into the supported configuration of your host version, preserving existing hooks and permission controls. Use absolute executable paths and the normal host trust mechanism.

| Event | Adapter |
|---|---|
| SessionStart / UserPromptSubmit / PreCompact context | `agent-process-kit hook --host HOST --event EVENT` |
| Claude Stop / SubagentStop | `agent-process-kit hook --host claude --event EVENT` |
| Codex Stop | `agent-process-kit hook --host codex --event Stop` |

Context adapters report the journal pointer. Stop adapters inspect explicit `Task complete: ID`. The raw `harness/bin/checkpoint-from-hook.mjs` helper can be registered separately for compatible lifecycle payloads.

Payloads need the actual session ID, workspace and event/final-message fields. Verify registration in a fresh host process using both pending and ready cases. A passing CLI test does not prove that the host runs a hook.

Use bounded timeouts. `harness/bin/hook-runtime.mjs` offers timeout and receipt wrapping. Unknown hook failures can be fail-open; the independent `check` command remains available. See [security](../SECURITY.md).

## Rollback

```sh
agent-process-kit rollback --project /path/to/project
agent-process-kit rollback --project /path/to/project --apply
```

Only unchanged receipt-owned files are removed. Edited files cause refusal before deletion; foreign files remain. Prepared receipts support recovery of partial setup. Manually registered host hooks must be removed deliberately through the host configuration.

## Skills

`skills/` holds architecture/process guidance. `vendor/superpowers-6.4.1/skills/` is an optional source snapshot with its license. Explicit paths work without a skill loader.

Capability skills refer to project-owned architecture/tooling docs. Map these roles onto your real documentation instead of creating empty files for suggested paths. Current user scope, permissions and project rules outrank imported workflow defaults.
