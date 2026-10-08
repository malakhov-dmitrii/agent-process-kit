# Contributing

Agent Process Kit is a seven-skill pack with one front door, `orchestrate-task`, plus a dependency-free runtime. A contribution should keep the pack coherent, the front door obvious and every standalone skill independently installable.

## Content rules

- Keep `SKILL.md` procedural and compact. Put specialized branches in `references/`.
- Write the frontmatter description as trigger conditions.
- Give each step a checkable completion criterion.
- Keep install commands identical in English and Russian docs.
- Preserve upstream licenses and source links for adapted material.
- Ship `LICENSE` and `NOTICE.md` inside every skill folder.
- Do not add host-specific behavior to the portable workflow.

## Verification

```sh
node scripts/check.mjs
node --test tests/*.test.mjs
node scripts/install-smoke.mjs
git diff --check
```

The install smoke uses pinned `skills@1.7.1` to install, update and remove the full pack and front door in clean `.agents` and `.claude` project layouts. It also checks the published runtime/setup files.

A workflow change also needs a clean-agent scenario with a realistic repository task. Record whether the run proved discovery, natural-task routing, durable task/artifact creation, implementation behavior, verification or final receipt shape. Do not claim that one model run proves all hosts.

## Pull requests

Describe the user-visible change, the failure or friction it addresses, current evidence, documentation changes and remaining limits. Keep unrelated cleanup out of the branch.

## Releases

Releases use the exact protected `main` commit after post-merge CI. Publish a source archive, a runtime/package archive and checksums. Download the assets again and verify them before closing the release task.
