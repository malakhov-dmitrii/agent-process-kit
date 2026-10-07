# Agent Process Kit

[![CI](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/malakhov-dmitrii/agent-process-kit/actions/workflows/ci.yml)
[Русский](README.ru.md) · [CLI](docs/cli.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md)

Explicit task context, recoverable handoffs, and honest checklist gates for coding agents.

The kit addresses three recurring failures: a new session resumes the wrong task, a handoff loses unfinished work, or a successful substep is presented as a finished task. It supplies local tools and a documented workflow. There are no runtime dependencies, background service, telemetry, or required model subscription.

## Quickstart

Requires **Node.js 22+, Git and Bash** on Linux or macOS. CI covers Node 22 and 24 on both systems. Windows is not supported in this release.

```sh
git clone https://github.com/malakhov-dmitrii/agent-process-kit.git
cd agent-process-kit
npm ci --ignore-scripts
npm run verify
node bin/agent-process-kit.mjs init --task demo --goal "Verify a user-visible change"
node bin/agent-process-kit.mjs check --task demo --journal .agent/tasks/demo.md
```

The last command exits **2** while criteria are pending. Replace template criteria with the actual agreed scope before implementation.

For an installed CLI, download the `.tgz` and `SHA256SUMS` from [Releases](https://github.com/malakhov-dmitrii/agent-process-kit/releases), verify its checksum, then run `npm install --global ./malakhov-dmitrii-agent-process-kit-0.1.0.tgz`. npm-registry publication is not required.

## Commands

| Command | Contract |
|---|---|
| `init` | Create a journal without overwriting work |
| `bind` | Associate a session with a matching task and journal |
| `status` | Resolve context; report candidates and pending handoffs |
| `check` | Validate recorded acceptance and evidence/decision fields |
| `handoff` | Prepare a transfer that a receiver accepts separately |
| `setup` | Preview project integration; write only with `--apply` |
| `rollback` | Remove unchanged setup-owned files; preserve user changes |
| `hook` | Run context/completion adapters for a compatible host |
| `review` | Optional bounded Codex review with an explicit model |

Global `--state-dir DIR` isolates state. The default is `~/.agent-process-kit`.

```sh
agent-process-kit bind --task demo --journal .agent/tasks/demo.md \
  --repo . --session YOUR_SESSION_ID --host codex
agent-process-kit status .
agent-process-kit handoff --to claude --next "Finish criterion A2" -C .
```

Use the current session's identity, supplied by the host or explicitly. Repository defaults are discovery data, not a new chat's intent. Handoff prints a resume command; it does not launch or message another agent.

## Recorded acceptance

```markdown
Task-ID: demo

## Acceptance
- [x] A1: Reproduced the regression | Evidence: test log and tested revision
- [ ] A2: Verify the real user flow
- [-] A3: Mobile scope excluded | Decision: operator decision reference
```

`check` returns `ready` when the recorded checklist is filled correctly. Its output includes **`evidenceVerified: false`**: `Evidence: PASS` does not prove that a test ran or a deployment succeeded. The agent and reviewer must inspect actual evidence.

## Workflow and integration

Agree on the outcome and delivery boundary, inspect the implementation, plan, reproduce or test first, implement, run the user flow, review, update documentation, and verify the agreed delivery stage. Significant UX choices should be shown as a concrete screen or small prototype before broad implementation. See [workflow](docs/workflow.md).

`setup --project .` previews a dedicated folder with instructions and hook examples. `--apply` creates it and a rollback receipt. **Setup does not edit global configuration, register hooks or change permissions.** Follow [setup](docs/setup.md).

The kit coordinates cooperating local processes. It is not authentication, a sandbox, a distributed execution lock or a business-correctness verifier. Hook limitations are described in [SECURITY.md](SECURITY.md).

## Included sources

The package contains lifecycle tools and tests, five architecture/process skills, and an optional Superpowers 6.4.1 skill snapshot. Libraries are not activated automatically. [Third-party notices](THIRD_PARTY.md) preserve upstream licenses. Private histories, credentials, production targets and private Git history are excluded; see [provenance](docs/provenance.md).

```sh
npm run verify
npm run pack:check
```

Package checks cover the global CLI symlink and an installed path with spaces. Tests use temporary state and localhost fixtures, never paid models. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).
