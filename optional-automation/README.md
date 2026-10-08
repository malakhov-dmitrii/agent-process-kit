# Optional automation

This package adds explicit session binding, recoverable handoffs, checklist parsing, checkpoints, and host hook adapters to the [Agent Process Kit](https://github.com/malakhov-dmitrii/agent-process-kit) playbook.

Most users do not need it. Start with the copyable contract and skills at the repository root. Add automation after you have a concrete cross-session failure to solve.

## Requirements

- Node.js 22 or 24
- Git and Bash
- Linux or macOS

There are no runtime dependencies, install scripts, background services, telemetry, or required model calls.

## Verify from source

```sh
cd optional-automation
npm ci --ignore-scripts
npm run verify
npm run pack:check
```

The package exposes the `agent-process-kit` command. The npm registry is not used by this project; versioned tarballs are attached to GitHub Releases.

## Commands

| Command | Purpose |
|---|---|
| `init` | Create a task journal without overwriting existing work |
| `bind` | Select a task for one session after checking journal identity |
| `status` | Resolve the selected task or report a candidate/pending state |
| `check` | Parse recorded acceptance; it does not verify evidence semantics |
| `handoff` | Prepare a canonical transfer that a receiver accepts separately |
| `setup` | Preview project-local integration files; `--apply` writes them |
| `rollback` | Remove unchanged receipt-owned setup files |
| `hook` | Adapt supported host lifecycle events |
| `review` | Optionally run bounded Codex review with an explicit model |

State defaults to `~/.agent-process-kit`. Use global `--state-dir DIR` to isolate an installation or test.

See [CLI reference](docs/cli.md), [architecture and recovery](docs/architecture.md), [setup](docs/setup.md), and [security](SECURITY.md).

## Install a release asset

Download the automation `.tgz` and `SHA256SUMS` from the matching GitHub Release, verify the checksum, then install the local file:

```sh
npm install --global ./malakhov-dmitrii-agent-process-kit-0.2.0.tgz
```

Project setup remains preview-first:

```sh
agent-process-kit setup --project /path/to/project
agent-process-kit setup --project /path/to/project --apply
```

Setup writes only `.agent-process-kit/` inside that project. It does not edit global agent configuration, install hooks, or change permissions. Read the generated files and merge relevant parts manually.

The runtime coordinates cooperating local processes. It is not authentication, sandboxing, a distributed lock, or proof that an `Evidence:` string is true.
