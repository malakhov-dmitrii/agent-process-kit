# Contributing

Agent Process Kit is one promoted skill, `finish-task`. A contribution should make that first path clearer, more reliable or better evidenced before it adds another public concept.

## Content rules

- Keep `SKILL.md` procedural and compact. Put specialized branches in `references/`.
- Write the frontmatter description as trigger conditions.
- Give each step a checkable completion criterion.
- Keep install commands identical in English and Russian docs.
- Preserve upstream licenses and source links for adapted material.
- Do not add host-specific behavior to the portable workflow.

## Verification

```sh
node scripts/check.mjs
node --test tests/*.test.mjs
node scripts/install-smoke.mjs
git diff --check
```

The install smoke uses pinned `skills@1.7.1` to install, update and remove the public skill in a clean project for Codex and Claude Code layouts.

A workflow change also needs a clean-agent scenario with a realistic repository task. Record whether the run proved discovery, Finish Card creation, implementation behavior, verification or final receipt shape. Do not claim that one model run proves all hosts.

## Pull requests

Describe the user-visible change, the failure or friction it addresses, current evidence, documentation changes and remaining limits. Keep unrelated cleanup out of the branch.

## Releases

Releases use the exact protected `main` commit after post-merge CI. Publish a source archive, a `finish-task.skill` archive and checksums. Download the assets again and verify them before closing the release task.
