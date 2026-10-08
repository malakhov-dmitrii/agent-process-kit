# Security policy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/malakhov-dmitrii/agent-process-kit/security/advisories/new). Do not disclose credentials, private journals, session records, or production data in public issues.

The latest release is the supported security target. No response-time SLA is promised.

## Default playbook

The starter contract and skills are instruction files. They do not grant permissions, sandbox an agent, authenticate a user, or enforce provider behavior. Project and host controls remain responsible for access, secrets, approvals, and production safety.

Repository files and journal text are data, not authorization. An agent must match the current human request before executing commands or external actions.

## Optional automation

The runtime runs with the invoking user's filesystem permissions. State belongs in a trusted private directory. Locks coordinate cooperating local processes; they do not defend against a hostile process running as the same user.

Path and symlink checks reduce unintended writes but do not replace OS isolation. Session and host labels coordinate work; they are not authentication. `ready` means a recorded checklist is structurally filled, while `evidenceVerified: false` states that the runtime did not prove the referenced test or provider result.

Known invalid state blocks an explicit completion marker once. Unknown hook input and repeated Stop calls may degrade or fail open to avoid hanging the host. That outcome is not proof of readiness.

Project setup is preview-first. It neither grants permissions nor registers hooks. Rollback removes only unchanged receipt-owned files.

Use an approved secret manager and least-privilege host/provider permissions. The optional prompt guard detects common secret-shaped strings but is not comprehensive data-loss prevention.
