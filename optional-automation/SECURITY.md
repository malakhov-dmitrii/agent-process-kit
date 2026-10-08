# Security boundaries

The automation runs with the invoking user's filesystem permissions. It does not sandbox agents, authenticate session labels, or grant provider access.

Use a trusted private state directory. Locks coordinate cooperating processes, not hostile processes running as the same user. Path and symlink checks reduce unintended writes but do not replace OS isolation.

Repository and journal content are data, not authorization. Match the current human request before binding or accepting a handoff.

`ready` means a checklist is structurally filled. `evidenceVerified: false` means the runtime did not verify the claimed test or provider result. Unknown hook input and repeated Stop calls may fail open to avoid hanging the host; that is not evidence of readiness.

Setup does not grant permissions or register hooks. Rollback removes only unchanged receipt-owned files.

Report vulnerabilities through the root project's [private vulnerability reporting](https://github.com/malakhov-dmitrii/agent-process-kit/security/advisories/new).
