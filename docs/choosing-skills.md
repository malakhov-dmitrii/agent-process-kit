# Choosing skills

Start with the project contract. Add a skill only when its specific workflow changes the task.

| Skill | Use it when |
|---|---|
| [depth-lock](../skills/depth-lock/SKILL.md) | The task is non-trivial, reviews repeat, or neighboring cleanup keeps entering scope |
| [capability-core-adapters](../skills/capability-core-adapters/SKILL.md) | Several entrypoints share behavior, domain truth is unclear, or a large module needs gradual extraction |
| [capability-contract](../skills/capability-contract/SKILL.md) | You need to write ownership, authority, lifecycle, commands, queries, degraded states, and proof requirements |
| [codebase-design](../skills/codebase-design/SKILL.md) | You are choosing an interface, seam, module depth, or test surface |
| [writing-for-agents](../skills/writing-for-agents/SKILL.md) | You are creating or editing agent instructions or skills |

Do not load all five for every task. A normal bug fix may only need the project contract. A feature touching one existing module may need no architecture skill.

## External workflow libraries

[Superpowers](https://github.com/obra/superpowers) provides broader brainstorming, planning, debugging, TDD, worktree, review, and execution workflows. Install it from its upstream project if those workflows fit your environment. This repository does not vendor or auto-enable it.

When two workflow packs cover the same step, choose one owner for that step. Current user instructions and project rules keep precedence over every optional skill.
