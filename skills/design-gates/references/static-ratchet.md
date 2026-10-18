# Static ratchet

A ratchet is a test that can only get stricter. It counts the patterns you are removing, fails when a count rises, and lets a count fall.

## What goes in it

| Kind | Examples | Rule |
|---|---|---|
| Zero target | hex and rgb colors, palette colors, literal radius classes, literal shadows, border widths, pixel font sizes, `backdrop-filter` in feature code, direct imports of overlay libraries, hand-rolled dialogs | any hit fails |
| Counted debt | text sizes, z-index values, durations, control heights, legacy classes | a count may fall and never rise |
| Allow list | a QR code that must be black on white so it scans | one file, one key, one reason. A stale entry fails |

Scope: feature code. Leave out the primitive layer (it defines the literals) and tests. Apply the same rules to every area. Where a teammate's feature predates the rules, count its old literals as debt that may only fall. Do not exempt the area.

## The script

[`scripts/ratchet.mjs`](../scripts/ratchet.mjs) is dependency-free Node. Copy it with [`scripts/ratchet.config.example.json`](../scripts/ratchet.config.example.json) into the project and edit the rules.

```sh
node scripts/ratchet.mjs --config ratchet.config.json              # the push gate
node scripts/ratchet.mjs --config ratchet.config.json --diff main  # also judges the touched files
node scripts/ratchet.mjs --config ratchet.config.json --write      # record after lowering a count
```

- `--write` lowers recorded counts and records rules it sees for the first time. It refuses to raise a count that is already recorded. The message tells you to remove the new hits.
- `--diff <rev>` fails on a net new hit of a counted rule in any file the change touched, even when the total has headroom. Without it, removing one old literal in file A would hide a new literal in file B.
- Every failure names the rule, the file and line, and the fix. The fix line is the part an agent acts on. Write it as an instruction: "Use a radius role: capsule for controls, section for cards."

## Three small tests beside it

1. Token existence. Collect the custom properties that stylesheets declare, then fail on any reference to a property that nothing declares. A rename left documents and files naming dead tokens, and this test found them.
2. Docs match code. The test reads the design doc and the agent instructions, and fails on a dead token name there. It also checks that the copies of the agent skill stay in sync.
3. Deprecated names. Fail on imports of deprecated primitives and variants, and on direct use of a library that a project primitive wraps.

## Failure modes

- Raising the baseline to pass. Refuse it in the tool, as the script does, and review baseline diffs.
- A regex that only matches the pattern you imagined. Plant one real example of each class (see `prove-gate-red.md`). A rule that cannot fire is the common case.
- Moving a literal to hide it. A scan on the diff nets moved lines out. Review allow-list additions as carefully as code.
- One rule broken, many messages. Fail the first hit with the fix, not a wall of text.
