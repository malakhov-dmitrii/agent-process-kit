# Contributing

The root of the repository is a zero-install playbook. Keep its quickstart usable without Node.js or npm. Runtime changes belong under `optional-automation/`.

For documentation and skills:

- keep each rule in one source of truth;
- make skill descriptions specific enough to route correctly;
- check every local link;
- preserve upstream licenses and attribution;
- avoid host-specific paths and private operational details.

For optional automation, use Node.js 22 or 24 on Linux or macOS:

```sh
npm --prefix optional-automation ci --ignore-scripts
npm --prefix optional-automation run verify
npm --prefix optional-automation run pack:check
```

Reproduce a runtime bug before fixing it. Test observable behavior plus interruption/retry paths. Tests use temporary state, local Git repositories, synthetic values, and localhost fixtures. They must not invoke paid models or production services.

Before opening a pull request, run `git diff --check`, verify the root starter flow by inspection, and complete the optional automation gate when that subtree changed. Describe user-visible behavior, evidence, documentation changes, and remaining limits.

Do not commit task journals, runtime receipts, credentials, machine configuration, private Git history, or downloaded build artifacts.

## Releases

Releases use the protected `main` commit after CI. Source archives cover the whole playbook. The optional automation tarball is built from `optional-automation/` and distributed as a GitHub Release asset with `SHA256SUMS`. npm-registry publication is a separate decision.
