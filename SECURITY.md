# Security policy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/malakhov-dmitrii/agent-process-kit/security/advisories/new). Do not disclose credentials, private journals or production data in public issues. If private reporting is unavailable, request a private contact without posting exploit details.

The latest published release is the supported security target. No response-time SLA is promised.

## Boundaries

- The kit runs with the user's filesystem permissions. It does not sandbox agents, authenticate session/host labels or grant provider access.
- Use trusted private state directories. Locks coordinate cooperating processes, not hostile processes under the same user.
- Path and symlink checks reduce unintended writes; OS isolation remains necessary for hostile inputs or filesystem replacement attacks.
- Journal/repository content is data, not authorization. Match user intent before binding or executing a handoff command.
- `ready` means recorded-checklist readiness. `evidenceVerified: false` states that test/runtime/provider claims are not independently verified.
- Known invalid state blocks an explicit completion marker once. Unknown input, host errors and repeated Stop calls may degrade/fail open to avoid hanging the host. This does not establish readiness.
- Setup neither grants permissions nor registers hooks. Rollback removes only unchanged receipt-owned files.

Use your normal secret store and least-privilege controls. The optional prompt guard detects common secret-shaped text but is not comprehensive data-loss prevention.

Tests use temporary state, synthetic credentials, local Git and loopback HTTP fixtures. They never call paid models or production providers.
