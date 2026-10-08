# Compatibility

Agent Process Kit v0.4 has two layers:

- seven portable Agent Skills installed into host project directories;
- a dependency-free Node.js 22 runtime and CLI installed from the package.

The skills use one `SKILL.md`, relative references and optional host metadata. The runtime writes only the project-local, hash-owned files reported by its setup receipt.

| Host or path | Level | What is verified |
|---|---|---|
| Vercel `skills` CLI 1.7.1 | install-tested | seven-skill discovery; full-pack and front-door install, update and removal in Codex and Claude layouts |
| OpenAI Codex | contract-target | natural task routing, durable status, pause/resume and delivery contours through the portable skill and CLI contract |
| Claude Code | contract-target | same project install layout and natural task contract; host UAT is a separate release receipt |
| Node.js 22+ | supported runtime | ESM CLI, JSON task records, setup/verify/rollback and lifecycle commands |
| Other Agent Skills hosts | instruction-only | portable Markdown format; host registration and behavior need their own UAT |

The host claim covers installation and the named scenario only. It does not make every model run equivalent.

## Standard setup

Install the pack and initialize the project runtime with:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code && npx @malakhov-dmitrii/agent-process-kit setup --apply
```

The installer copies skills into `.agents/skills/` and `.claude/skills/`. The runtime setup records the exact adapter files and their hashes in `.agent-process-kit/setup-receipt.json`. Use `verify-setup` to read those hashes and `rollback --apply` to remove only unchanged owned files.

Update or remove the project skills with:

```sh
npx skills update --project -y
npx skills remove capability-contract capability-core-adapters codebase-design depth-lock orchestrate-task verify-delivery writing-for-agents -a codex -a claude-code -y
```

## Fallback

In a restricted or offline environment, copy any directory under [`skills/`](../skills) into the matching host skill directory and preserve its supporting files. This installs the instruction layer only; the runtime still requires the package's Node.js CLI. Every distributed skill carries its own `LICENSE` and `NOTICE.md`.
