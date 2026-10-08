# Agent Process Kit: Codex project wiring

This project owns the portable runtime adapter at `.agent-process-kit/runtime/host-adapter.mjs`.
Configure the host to send `SessionStart`, `UserPromptSubmit`, `PreCompact`, and `Stop` events to that adapter.

The adapter resolves the exact session binding before checkpoint or completion work. A candidate is discovery data only.
Use `agent-process-kit task status --state-dir <state>` for durable status and continuation after a new chat or compaction.

Host limit: this setup records project instructions only. It does not edit global Codex configuration or claim that native hooks are registered.
