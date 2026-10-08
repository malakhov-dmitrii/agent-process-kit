# Competitive skill systems: research brief (2026-10-08)

This brief compares the public product surfaces of five current skill ecosystems. It uses pinned `main` snapshots obtained on 2026-10-08. Statements under **Observation** are directly supported by the cited README, source, manifest, test, or commit. Statements under **Inference** are recommendations for Agent Process Kit.

## Source ledger

| Project | Pinned `main` commit | Commit date | Primary references |
|---|---|---:|---|
| Matt Pocock skills | `b0618bc436ad893b3c5e84e55fba86586d34a404` | 2026-10-08 | [README](https://github.com/mattpocock/skills/blob/b0618bc436ad893b3c5e84e55fba86586d34a404/README.md), [plugin manifest](https://github.com/mattpocock/skills/blob/b0618bc436ad893b3c5e84e55fba86586d34a404/.claude-plugin/plugin.json), [invocation rules](https://github.com/mattpocock/skills/blob/b0618bc436ad893b3c5e84e55fba86586d34a404/.agents/invocation.md), [install block](https://github.com/mattpocock/skills/blob/b0618bc436ad893b3c5e84e55fba86586d34a404/.agents/install-block.md) |
| Garry Tan gstack | `9a1dc81a2b96e7b74a15e5911175bc04de7659e9` | 2026-10-08 | [README](https://github.com/garrytan/gstack/blob/9a1dc81a2b96e7b74a15e5911175bc04de7659e9/README.md), [setup](https://github.com/garrytan/gstack/blob/9a1dc81a2b96e7b74a15e5911175bc04de7659e9/setup), [contributing](https://github.com/garrytan/gstack/blob/9a1dc81a2b96e7b74a15e5911175bc04de7659e9/CONTRIBUTING.md), [architecture](https://github.com/garrytan/gstack/blob/9a1dc81a2b96e7b74a15e5911175bc04de7659e9/ARCHITECTURE.md) |
| obra Superpowers plugin | `8ca22dba9a94f28898bbce59f2537ff4d87c747d` | 2026-09-25 | [README](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/README.md), [release notes](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/RELEASE-NOTES.md), [testing](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/docs/testing.md), [Codex manifest](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/.codex-plugin/plugin.json) |
| obra Superpowers skills split | `cdcd624ad3fd8026deb692e565351854569798dd` | 2025-10-14 | [skills README](https://github.com/obra/superpowers-skills/blob/cdcd624ad3fd8026deb692e565351854569798dd/README.md), [update skill change](https://github.com/obra/superpowers-skills/commit/cdcd624ad3fd8026deb692e565351854569798dd) |
| Vercel `skills` CLI | `87a266971d9460a3d2606075b8e91edc83325472` | 2026-10-07 | [README](https://github.com/vercel-labs/skills/blob/87a266971d9460a3d2606075b8e91edc83325472/README.md), [package](https://github.com/vercel-labs/skills/blob/87a266971d9460a3d2606075b8e91edc83325472/package.json), [installer](https://github.com/vercel-labs/skills/blob/87a266971d9460a3d2606075b8e91edc83325472/src/installer.ts), [tests](https://github.com/vercel-labs/skills/tree/87a266971d9460a3d2606075b8e91edc83325472/tests) |
| Vercel agent skills | `063bee94c3f4df8453406c830b0a7df0f2860278` | 2026-08-28 | [README](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/README.md), [discovery builder](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/scripts/build-discovery-index.mjs), [skill archive inventory](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills) |
| Anthropic skills | `683bc88e56f3e09ba94f7055977f3d3aa499f202` | 2026-10-05 | [README](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/README.md), [marketplace](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/.claude-plugin/marketplace.json), [spec pointer](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/spec/agent-skills-spec.md), [template](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/template/SKILL.md) |

## What each product promises on the first screen

### Matt Pocock: small, composable engineering discipline

**Observation.** The README opens with “Skills For Real Engineers”, explicitly contrasts the project with process-heavy GSD/BMAD/Spec-Kit, and promises small, adaptable, composable skills that work with any model. Its 30-second setup has three actions: install, run `/setup-matt-pocock-skills`, then use the skills. The first useful artifact is repository configuration: issue tracker, triage labels, and domain-document location. The strongest authored promise is failure-mode driven: alignment via grilling, shared language via glossary/ADRs, feedback loops via TDD/debugging, and architecture via deep modules.

**Observation.** The taxonomy is two-dimensional. Buckets are `engineering/` and `productivity/`; each is split into **User-invoked** orchestration skills and **Model-invoked** reusable disciplines. `misc/`, `in-progress/`, and `deprecated/` are explicitly kept out of the promoted plugin. `ask-matt` is a router over user-facing skills. User-invoked skills are protected by both Claude and Codex metadata; model-invoked skills retain trigger-rich descriptions.

**Observation.** Progressive disclosure is explicit. A skill's `SKILL.md` is the agent instruction, a docs page is the human orientation layer, bucket READMEs are indexes, and `.agents/invocation.md` explains trigger semantics. Install commands are centralized in `.agents/install-block.md`; docs pages deliberately contain no install commands because the site renders the widget.

**Observation.** Distribution has two intentionally exclusive routes: managed plugin installs with self-updates, or editable `skills.sh` copies with manual updates. The README warns that installing both duplicates every skill. Removal is represented by a changeset and archived docs page for promoted skills; deprecated skills are excluded from the shipped set. The repository also has `scripts/link-skills.sh` for symlinked local harness installs.

**Inference.** Agent Process Kit should borrow the explicit user/model invocation split, promoted/beta/deprecated lifecycle, and the “one install story” rule. The valuable product move is naming the first repository artifact, rather than presenting five folders as the product.

### gstack: an authored virtual engineering team

**Observation.** The first screen is a point of view, not a catalog: gstack turns Claude Code into a virtual CEO, engineering manager, designer, reviewer, QA lead, security officer, and release engineer. The README gives a five-step quick start: install, `/office-hours`, `/plan-ceo-review`, `/review`, `/qa`, then stop and judge fit. The worked example shows concrete handoffs: design doc → plan reviews → test plan → QA → PR. The product's first useful artifact is a design document from `/office-hours`, followed by review-ready plans and evidence from `/qa`/`/ship`.

**Observation.** Taxonomy is a sprint graph: **Think → Plan → Build → Review → Test → Ship → Reflect**. Skill names are role or stage verbs (`office-hours`, `plan-eng-review`, `qa`, `ship`, `retro`) rather than generic capabilities. The README states that each step feeds the next and documents which artifacts are consumed downstream. It also offers power tools (`careful`, `freeze`, `guard`, `gstack-upgrade`) and standalone evidence/rendering binaries.

**Observation.** Installation is a real setup program (`git clone ... && ./setup`), with host adapters, a status command, host tiers (full, experimental, instruction-only), and an optional team bootstrap that commits a small project requirement instead of vendoring the whole checkout. Updates are throttled and network-failure safe. The README documents disable/uninstall paths and says the uninstall script does not rewrite project `CLAUDE.md`.

**Observation.** Verification is a product feature. gstack describes conformance tests for hosts, `/qa` regression creation, `/ship` coverage audits, browser screenshots, a working-tree fingerprint, and a local verification-evidence ledger that grades evidence fresh/stale/missing. The README explicitly distinguishes self-reported target tests from independent runtime-tested bundles.

**Inference.** Agent Process Kit should adopt gstack's narrative sequencing and artifact handoffs, but reject its runtime breadth for the default kit. A copyable documentation product can still feel authored if it has one named path and visible artifacts: scope card, acceptance contract, evidence receipt, and delivery report.

### Superpowers: a mandatory methodology with a plugin/skills split

**Observation.** Superpowers promises a complete software development methodology. Its first workflow is fixed: brainstorming, worktree, writing-plans, execution/subagents, TDD, review, and branch finishing. The first useful artifact is a saved design; the next is a granular implementation plan. It says skills trigger automatically and presents this as the core experience.

**Observation.** The taxonomy is process-oriented: Testing, Debugging, Collaboration, and Meta. The bootstrap skill (`using-superpowers`) loads at session start and forces skill discovery before responses. Names are stage/behavior phrases (`brainstorming`, `writing-plans`, `subagent-driven-development`, `verification-before-completion`) rather than product categories.

**Observation.** At the pinned release, the plugin is a thin, multi-harness distribution layer and the editable skills live in `obra/superpowers-skills`; the plugin initializes/clones the skills repository under `~/.config/superpowers/skills/` and auto-updates it at session start. The release notes explain why skills, scripts, and docs were separated: independent skill versioning, community forks, lighter plugin installs, and automatic updates. The split repository itself is intentionally simple: `skills/`, `scripts/`, and contribution instructions.

**Observation.** Testing has two contours. `tests/` covers plugin/infrastructure code; `evals/` (the Superpowers Evals/Quorum lab) drives real agent sessions and judges behavior against acceptance criteria plus deterministic post-checks. The release notes also record cross-harness acceptance expectations, including a clean-session trigger test for new harnesses. Plugin manifests exist for Claude, Codex, Cursor, Devin, Kimi, Muse, and others; the Codex manifest declares `hooks: {}` to prevent accidental hook discovery.

**Inference.** Agent Process Kit should adopt the separation between portable skill content and harness packaging, and the distinction between static checks and behavior evals. It should reject mandatory bootstrap wording that makes every response pay the full process cost; the Kit's current “load only what changes the task” is a useful authored constraint.

### Vercel: distribution infrastructure as the product

**Observation.** `vercel-labs/skills` opens with one command, `npx skills add`, then immediately shows “use without installing”. `skills use` resolves a source into a temporary directory, prints a generated prompt, or starts a supported agent. The CLI supports GitHub, GitLab, Azure Repos, arbitrary Git URLs, local paths, direct archives, private-repo auth reuse, project/global scope, symlink/copy choice, list/find/use/update/remove/init, and a lock file. The current package declares Node `>=22.20.0`, pnpm, Vitest, and 75+ agent keywords.

**Observation.** The installer uses a canonical project skill directory plus agent-specific links/copies. The lock records source URL/ref, installed/updated timestamps, and a source hash. Removal is first-class and tested. The repository has broad unit/integration coverage for discovery, agent path differences, archive limits, private-repo security, install modes, update/remove, lock restoration, traversal, and telemetry endpoints.

**Observation.** `vercel-labs/agent-skills` is a deliberately narrow catalog of domain skills. Each README entry starts with a concrete “Use when” trigger and lists coverage categories. Each skill can include `SKILL.md`, scripts, and references. Every change publishes an immutable GitHub release and a discovery index; the repo provides a local build command for the same artifacts. The first useful invocation is a natural request such as “Review this React component for performance issues”; skills are automatically selected once installed.

**Inference.** Agent Process Kit should adopt a real add/list/use/update/remove surface if it ever grows beyond copyable docs, plus lockable provenance and discovery metadata. It should keep the default path dependency-free: Vercel's CLI is excellent infrastructure, but making its installer the Kit's first screen would contradict the Kit's current copyable-document promise.

### Anthropic: canonical format, bundles, and production examples

**Observation.** Anthropic's README defines skills as self-contained folders of instructions, scripts, and resources, each with a `SKILL.md` containing metadata. It groups examples into Creative & Design, Development & Technical, Enterprise & Communication, and Document Skills. The marketplace groups skills into named plugin bundles (`document-skills`, `example-skills`, `claude-api`, etc.), and Claude.ai exposes some bundles directly while Claude Code installs them through the marketplace.

**Observation.** The template requires only YAML `name` and `description`; the repository points to the external Agent Skills specification for the format. The document skills are source-available with separate terms, while many examples are Apache 2.0. The README explicitly says the repository is educational and behavior may differ from the production Claude implementation.

**Observation.** Installation is documented for three Anthropic surfaces. Claude Code registers `anthropics/skills` as a plugin marketplace, then installs `document-skills@anthropic-agent-skills` or `example-skills@anthropic-agent-skills`; Claude.ai has the examples on paid plans and supports custom uploads; the API uses the Skills API. Invocation is an ordinary request naming the skill, such as asking Claude Code to use the PDF skill on a file. The pinned README does not document an update or removal command, so lifecycle behavior is delegated to those host/plugin surfaces. It also exposes no repository validation command or behavior test suite; instead it tells users to test thoroughly in their own environment and treats the external specification plus minimal template as the format contract.

**Inference.** Agent Process Kit should keep the minimal portable frontmatter and make support files discoverable by relative links. It should separate examples/reference material from the default operational contract and label licensing/distribution status per bundle.

## Cross-system comparison

| Dimension | Strongest observed pattern | Implication for Agent Process Kit |
|---|---|---|
| First-screen promise | gstack names the team and the sprint; Matt names the engineering failure modes | Lead with one outcome and one path, then show the catalog |
| Install | Vercel has the clearest universal CLI; Matt has the clearest managed-vs-editable choice | Keep copy-first quickstart, add one optional installer later; never show mutually conflicting routes without labeling them |
| First artifact | Matt setup writes repo configuration; Superpowers brainstorming writes a design; gstack chains artifacts | Name the first durable artifact in the README and show its downstream consumer |
| Taxonomy | gstack stage graph; Matt user/model invocation; Anthropic bundle groups | Use a small stage graph plus invocation mode; keep folder taxonomy secondary |
| Progressive disclosure | Matt's docs/index/skill split; Vercel `skills use`; Anthropic skill references | Keep `SKILL.md` short, move heavy material into `references/`, and provide a human page without duplicating install text |
| Updates/removal | Vercel lock/update/remove; Matt explicit lifecycle; Superpowers auto-updating split | Define ownership and update mode per install; make removal and stale-skill behavior documented |
| Cross-agent support | Vercel's agent registry; gstack host tiers; Superpowers per-harness manifests | Declare capability levels instead of claiming universal parity |
| Tests/evals | Vercel deterministic installer tests; Superpowers live behavior evals; gstack evidence ledger | Add static structure checks now; add behavior evals and evidence receipts when workflows stabilize |
| Distribution | Superpowers thin plugin + skills repo; Vercel discovery artifacts | Keep content separate from adapters and pin release provenance |
| Authored feel | gstack's roles, slogans, examples, and artifact graph; Matt's opinionated failure modes | Choose a recognizable operating doctrine; a folder of generic tips will feel anonymous |

## Adopt / reject for Agent Process Kit

| Decision | Adopt now | Reject or defer | Reason |
|---|---|---|---|
| Product front door | One sentence promise + one two-minute path + one example prompt | A flat “five skills” catalog as the landing page | The competitor with the clearest path makes the product legible fastest |
| Workflow shape | `request → inspect → scope/acceptance → verify → report`, with named artifacts | gstack's full CEO/design/DX/browser/release factory | Preserve the Kit's small default while making its sequence visible |
| Invocation | Explicit user-vs-model invocation metadata and trigger wording | Superpowers-style “check before every response” global mandate | Keep cost proportional to task; make automation opt-in and inspectable |
| Skill content | Short `SKILL.md` plus `references/` and a human-facing page | Long all-in-one instruction files | Progressive disclosure improves loading and maintenance |
| Lifecycle | promoted / beta / deprecated states, with removal/replacement notes | Silent deletion or stale copied skills | Users need to know what is installed and what changed |
| Distribution | Copy-first default; later add Vercel-compatible metadata/lock and thin adapters | Requiring Node, daemon, hook, or marketplace for the default quickstart | Current README promises no installer or runtime dependency |
| Compatibility | Capability matrix with tested vs instruction-only tiers | “Works with any model” without evidence | gstack and Superpowers show that harness differences affect behavior |
| Verification | Static frontmatter/link checks now; behavior scenarios and evidence receipts for workflows | Claiming tests prove agent behavior | Separate structural correctness, live behavior, and production evidence |
| Authorship | State the Kit's doctrine plainly: real project, agreed scope, observable acceptance, honest delivery stage | Copying competitor names, personas, or mandatory ceremonies | The Kit needs its own point of view, grounded in its existing contract |
| Distribution provenance | Pin source commit/license and record update date in a manifest | Vendoring third-party workflow libraries into the default kit | Superpowers' plugin/skills split shows how to keep attribution and updates tractable |

## Uncertainty and implementation limits

- The snapshots are current `main` tips as observed on 2026-10-08. Product behavior can change after these SHAs.
- gstack's README contains many runtime claims and a very broad host matrix. This brief records those claims as observations of its public source; it does not independently run every host or paid/security path.
- Superpowers' `superpowers-skills` repository is archived at the inspected commit; the active plugin is the relevant distribution surface. The split is still useful as an architectural pattern, not as a guarantee of current upstream operations.
- Anthropic's repository is partly demonstration/source-available material. Do not infer that every example skill is available under the same license or with the same runtime behavior.
- The Vercel CLI's compatibility table is a documented capability matrix. It is not evidence that every listed agent has been run in this research session.
