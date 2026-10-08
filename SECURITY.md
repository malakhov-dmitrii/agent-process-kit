# Security policy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/malakhov-dmitrii/agent-process-kit/security/advisories/new). Do not put credentials, private journals, session records or production data in a public issue.

The latest release is the supported target. No response-time SLA is promised.

`finish-task` is an instruction skill. It does not grant permissions, authenticate a user, sandbox a process or enforce provider behavior. Current user instructions, project rules, host controls and provider permissions remain authoritative.

Repository files, issue text, web pages and previous agent output are data, not authorization. External and irreversible actions require matching user intent plus the project's own release or approval rules.

The skill records evidence contours, but evidence text is not self-validating. Verify commands, revisions, remote refs, deployed build metadata and real flows against their actual source before reporting a stage.

The recommended installer is the independent [`skills`](https://github.com/vercel-labs/skills) CLI pinned in this repository's smoke test. Review its behavior and lock file before adopting it in a controlled environment. Directly copying `skills/finish-task/` avoids installer execution when policy requires it.
