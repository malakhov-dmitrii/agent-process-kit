# Pack routing

`finish-task` remains usable alone. When the full pack is installed, route each branch to its owning skill:

| Condition | Skill |
|---|---|
| Non-trivial scope, repeated reviews or time checkpoints | `depth-lock` |
| Final completion or delivery claim | `verify-delivery` |
| Choosing a module interface, seam or test surface | `codebase-design` |
| Several entrypoints need one product behavior owner | `capability-core-adapters` |
| Authority, source of truth, lifecycle or degraded states need a written contract | `capability-contract` |
| Creating or changing a skill, `AGENTS.md` or `CLAUDE.md` | `writing-for-agents` |

The specialist owns its branch; `finish-task` owns the end-to-end card and acceptance. Do not load every specialist for every task.
