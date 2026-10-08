# Compatibility

`finish-task` uses the portable Agent Skills shape: one `SKILL.md`, relative references and optional host metadata. The workflow does not call a host-specific tool by name.

| Host or path | Level | What is verified |
|---|---|---|
| Vercel `skills` CLI 1.7.1 | tested | repository discovery plus clean install, update and removal |
| OpenAI Codex CLI 0.159.3 | behavior-tested | clean install; explicit invocation produced a Finish Card, red regression, implementation, 4/4 passing tests and a `LOCAL-ONLY` receipt |
| Claude Code 2.1.291 | install-tested | clean install layout matched source byte for byte; live behavior run was blocked by the account's weekly limit on 2026-10-08 |
| Direct `SKILL.md` reference | instruction-only | all required content is in portable Markdown and relative files |
| Other Agent Skills hosts | instruction-only | format is portable; host invocation and behavior have not been run here |

Each level covers only the named check. The Codex scenario is one synthetic bugfix, not universal model behavior. Agent behavior still depends on the model, project instructions, tools, permissions and task.

## Install scope

Project install is the default:

```sh
npx skills add malakhov-dmitrii/agent-process-kit --skill finish-task
```

Use `-g` for a user-level install. Use `-a codex -a claude-code` to select both hosts explicitly. The installer owns its links/copies and lock file; the skill itself owns no runtime state.

Remove the tested project install from both hosts with:

```sh
npx skills remove finish-task -a codex -a claude-code -y
```

## Fallback

Copy `skills/finish-task/` as one directory into the host's skill folder. Preserve the `references/` and `agents/` subdirectories. Remove that copied directory to uninstall.
