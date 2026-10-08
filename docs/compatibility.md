# Compatibility

All seven skills use the portable Agent Skills shape: one `SKILL.md`, relative references and optional host metadata. They do not call a host-specific tool by name.

| Host or path | Level | What is verified |
|---|---|---|
| Vercel `skills` CLI 1.7.1 | tested | seven-skill discovery; full-pack and finish-task-only install, update and removal |
| OpenAI Codex CLI 0.159.3 | behavior-tested | clean install; explicit and implicit invocations produced Finish Cards, red regressions, scoped fixes, passing tests and `LOCAL-ONLY` receipts |
| OpenAI Codex CLI 0.159.3 / `verify-delivery` | behavior-tested | standalone skill rejected a false “tests pass / ready to push” claim with current failing test output and no edits |
| Claude Code 2.1.291 | install-tested | clean install layout matched source byte for byte; live behavior run was blocked by the account's weekly limit on 2026-10-08 |
| Direct `SKILL.md` reference | instruction-only | all required content is in portable Markdown and relative files |
| Other Agent Skills hosts | instruction-only | format is portable; host invocation and behavior have not been run here |

Each level covers only the named check. The Codex scenario is one synthetic bugfix, not universal model behavior. Agent behavior still depends on the model, project instructions, tools, permissions and task.

## Install scope

Install the full pack into Codex and Claude Code project layouts:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill '*' -a codex -a claude-code
```

Install only the front door with `--skill finish-task`. Use `-g` for a user-level install. The installer owns its links/copies and lock file; the skills own no runtime state.

Remove the tested project install from both hosts with:

```sh
npx skills remove capability-contract capability-core-adapters codebase-design depth-lock finish-task verify-delivery writing-for-agents -a codex -a claude-code -y
```

## Fallback

Copy any directory under `skills/` into the host's skill folder. Preserve all supporting subdirectories. Remove the copied skill directory to uninstall it.
