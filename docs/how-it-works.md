# How the process works

The default kit is documentation. It changes how an agent approaches a task without adding a daemon, state store, package, or hook.

```text
request
  → inspect the real project
  → agree on scope and observable acceptance
  → plan and review within a cap
  → reproduce or test first
  → implement the smallest coherent change
  → run the real user path
  → update documentation
  → report the verified delivery stage
```

The journal keeps the task stable across a long session. It records decisions and evidence without trying to save private chain-of-thought. The project rules remain the authority for commands, architecture, release, and safety.

## Where humans decide

Ask before changing product direction, architecture, a public contract, persistent data, permissions, or external commitments. Show disputed UX as a concrete screen or small prototype before investing in the full implementation.

Routine choices inside the agreed scope stay autonomous. A successful test or prerequisite is a reason to continue to the remaining acceptance criteria.

## Why tests and reviews are separate

Tests show that selected behavior ran. Review checks whether the change belongs in the right place and preserves the intended contract. Neither proves deployment or production behavior. Keep local, pushed, deployed, and production-verified states distinct.

Reviews have a cap because another full review can always find another improvement. After the first round, focus on blockers. Put adjacent cleanup into follow-ups unless the user expands the task.

## Documentation placement

- Root project instructions contain durable rules and pointers.
- Module docs contain ownership, contracts, known constraints, and checks.
- The task journal contains temporary execution state.
- Release records contain what actually reached an environment.

Update the owning document when behavior or ownership changes. A changed file hash is only a prompt to inspect documentation; it cannot decide whether the text is still correct.

## Optional automation

The [optional runtime](../optional-automation/README.md) adds explicit cross-session binding, recoverable handoffs, checklist parsing, checkpoints, and hooks. It exists for multi-agent setups that have already experienced those failures. The playbook does not require it.
