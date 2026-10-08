# Provenance

Agent Process Kit came from a production-heavy local workflow, then went through two public shapes:

- v0.1 automated task binding, handoffs and completion gates;
- v0.2 separated a zero-install contract from that optional runtime;
- v0.3 reduced the public interface to one portable workflow: `finish-task`.

The v0.3 skill is project-authored. Its scope-lock, module-design, capability and agent-writing references adapt ideas from the MIT-licensed sources listed in [THIRD_PARTY.md](../THIRD_PARTY.md). The competitive brief records the current product patterns used to challenge the redesign; competitor implementation and branding are not copied.

Private sessions, journals, credentials, endpoints, machine profiles and private Git history are excluded. The removed v0.2 runtime remains available through its immutable release and checksums rather than continuing to dominate `main`.

Release checksums establish artifact identity. They do not certify model behavior or the truth of a reported evidence receipt.
