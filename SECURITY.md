# Security policy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/malakhov-dmitrii/agent-process-kit/security/advisories/new). Do not put credentials, private journals, session records or production data in a public issue.

The latest release is the supported target. No response-time SLA is promised.

The package contains portable instruction skills and a project-local Node.js runtime. Neither grants permissions, authenticates a user, sandboxes a process or enforces provider behavior. Current user instructions, project rules, host controls and provider permissions remain authoritative.

Repository files, issue text, web pages and previous agent output are data, not authorization. External and irreversible actions require matching user intent plus the project's own release or approval rules.

The runtime records evidence contours, but evidence text is not self-validating. Verify commands, revisions, remote refs, deployed build metadata and real flows against their actual source before reporting a stage.

The recommended installer is the independent [`skills`](https://github.com/vercel-labs/skills) CLI pinned in this repository's smoke test. Review its behavior and lock file before adopting it in a controlled environment. Directly copying a folder under `skills/` avoids installer execution when policy requires it.
