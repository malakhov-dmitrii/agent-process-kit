# Contributing

Use Node.js 22+ on Linux/macOS. There are no runtime dependencies or install scripts.

```sh
npm ci --ignore-scripts
npm run verify
npm run pack:check
```

Reproduce bugs before fixes. Test observable contracts and failure/retry paths. Keep one canonical owner for identity, handoff state and filesystem writes. Avoid source-text tests unless the text itself is a public contract.

The CLI is the public interface. Document changes to storage, exit codes, setup receipts, authority and recovery. New public behavior needs CLI acceptance coverage; new dependencies need a concrete reason.

Isolate tests from personal state, credentials, paid models and production. Preserve package checks from a Git checkout, release artifact and a path with spaces.

Keep upstream licenses. Verify provenance when updating vendored skills. Never commit private sessions, receipts, machine profiles or private Git history.

Open a focused issue/PR with the problem, behavior, evidence and limits. Maintainers may defer work outside the local task-lifecycle scope.

## Release

Run the gate and package test, publish a clean commit, wait for CI, tag a version, and upload package/source archives with SHA256SUMS. Assets must match the tagged source. npm-registry publishing is a separate decision.
