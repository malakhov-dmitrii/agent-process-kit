# Architecture decisions

Load this reference only when the task changes product ownership, a public contract, durable data, authority, lifecycle, multiple entrypoints or a reusable module interface.

## Put the seam in the right place

A **module** hides implementation behind an **interface**. A useful interface is deep: callers get substantial behavior while learning few concepts. Put a **seam** where behavior must vary or where an external system meets product rules. Keep adapters thin and keep one owner for each durable rule.

Before adding an abstraction, state:

- which callers need it now;
- what complexity disappears behind its interface;
- which source of truth and authority own the behavior;
- how stale, missing, contradictory and failed states behave;
- which test crosses the same interface as real callers.

One adapter is often a hypothetical seam. Two real adapters or one hard external boundary justify it.

## Cross-entrypoint capability

When web, API, bot, job, MCP or script entrypoints share behavior, define:

- product-language capability name;
- source of truth and actors with authority;
- lifecycle states and events;
- commands and queries;
- deployable or asynchronous contracts;
- platform dependencies;
- reconciliation and recovery;
- proof required at each entrypoint.

Do not copy business rules into entrypoints. Reuse or extract one command/query path and keep provider SDK, persistence and transport code at the edge.

