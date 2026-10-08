# Provenance

Agent Process Kit came from a production-heavy local workflow, then went through these public shapes:

- v0.1 automated task binding, handoffs and completion gates;
- v0.2 separated a zero-install contract from an optional runtime;
- v0.3.0 introduced the portable `finish-task` workflow;
- v0.3.1 restored the independently installable craft pack around that front door;
- v0.4 replaces manual skill invocation with the `orchestrate-task` front door and a dependency-free control plane for durable state, bounded review, UAT and delivery proof.

`orchestrate-task` and `verify-delivery` are project-authored. The craft skills and referenced concepts use the MIT-licensed sources listed in [THIRD_PARTY.md](../THIRD_PARTY.md). The competitive brief records product patterns used to challenge the redesign; competitor implementation and branding are not copied.

Private sessions, journals, credentials, endpoints, machine profiles and private Git history are excluded. The immutable v0.2 release remains the migration source; v0.4 imports only validated task metadata through an offline, receipt-backed cutover.

Release checksums establish artifact identity. They do not certify model behavior or the truth of a reported evidence receipt.
