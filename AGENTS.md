# Repository agent contract

Read [README.md](README.md) and [docs/how-it-works.md](docs/how-it-works.md) before changing the public workflow. The product has one promoted interface: `skills/finish-task/`.

For skill changes:

- keep the `SKILL.md` sequence short and put branch-specific detail behind precise relative pointers;
- write descriptions as invocation triggers, not workflow summaries;
- end every step on a checkable completion criterion;
- keep each rule in one authoritative place;
- test the public behavior, not only Markdown syntax;
- preserve third-party licenses and attribution when adapting earlier material.

The default product is portable Markdown installed through the standard `skills` ecosystem. Do not add a daemon, hook, account, telemetry, background process, host-specific runtime or global configuration to the default path.

Before contributing, run:

```sh
node scripts/check.mjs
node --test tests/*.test.mjs
node scripts/install-smoke.mjs
git diff --check
```

The install smoke needs network access to the pinned `skills@1.7.1` package. Behavior changes also need a clean-agent scenario that proves the intended trigger and Finish Card/receipt shape.

Preserve unrelated edits and user-owned project files. Do not commit journals, credentials, machine profiles, private history or generated install directories. A release comes from protected `main` after CI and readback; a local check or push is not a release.
