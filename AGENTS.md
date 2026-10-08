# Repository agent contract

Read [README.md](README.md) and [docs/how-it-works.md](docs/how-it-works.md) before changing the default playbook. The default interface is copyable documentation; keep Node/npm/runtime concepts under `optional-automation/`.

For changes to `starter/` or `skills/`, use the [writing-for-agents](skills/writing-for-agents/SKILL.md) guidance. Keep each rule in one authoritative place, use precise pointers, and remove stale or duplicated instructions.

For changes under `optional-automation/`, read its README and architecture docs. Keep behavior in its owning module and the CLI thin. Reproduce bugs, test failure/recovery paths, and run:

```sh
npm --prefix optional-automation run verify
npm --prefix optional-automation run pack:check
```

For every contribution:

- preserve unrelated edits and user-owned files;
- keep project content free of private state, credentials, machine profiles, and private history;
- preserve verified third-party licenses and attribution;
- update the nearest documentation when public behavior or structure changes;
- run `git diff --check` and the relevant CI-equivalent checks;
- do not publish, register hooks, change permissions, or mutate production without the corresponding user request.

The root README, starter contract, and five skills are the public product. Optional automation must not make the default quickstart more complicated.
