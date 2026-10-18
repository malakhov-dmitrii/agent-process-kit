---
name: audit-agent-program
description: Use when a multi-agent program or long autonomous run has ended, stalled or missed its estimates and you need an evidence-based retrospective of where the time went, why defects escaped and how the work was split.
---

# Audit an agent program

Audit with three independent lenses: throughput, quality and parallelism. Each lens reads the same evidence and answers one question. Their findings overlap on purpose, and agreement between lenses is the signal.

In the audited program, the throughput lens and the parallelism lens both ranked oversized batches and one serial release path first. The quality lens traced the defects to specs and briefs. No single lens showed both.

## 1. Fix the question and the sources

Write the audit brief ([audit brief](references/audit-brief.md)). It states the goal in the operator's terms, lists the sources, names the facts to verify instead of assume, and fixes the time zone and the output files. The audit is read-only. It changes no repository, production system or runner.

The step is done when the brief names every source and every lens file.

## 2. Run the lenses in parallel

Start one agent per lens, each writing its own file: `throughput.md`, `quality.md`, `parallelism.md`. Each lens has its own questions, tables and methods in [lenses](references/lenses.md). The agents do not read each other's files until step 4.

The step is done when each file holds findings, what worked, and ranked recommendations.

## 3. Check every finding

A finding has three parts: evidence, impact and root cause ([finding format](references/finding-format.md)). The evidence is a file path, a log line, a commit, or a quote with its time. The impact is hours lost or defects shipped, as an estimate with the arithmetic shown. Delete a finding that has no evidence. Mark a cause that nobody verified as unverified.

The step is done when no finding lacks evidence, and every estimate shows how it was made.

## 4. Reconcile the lenses

Remove time that two lenses counted. Treat agent-hour spans as upper bounds, because a span includes waiting. Where two lenses disagree, state the conflict and decide it. In the audited program one lens said builders must not run heavy jobs, and another said builders must look at their own screenshots. The decision was that builders run heavy checks through the slot queue at the lowest priority.

The step is done when the program-wide total names which rows overlap, and each contradiction has a decision.

## 5. Rank the recommendations and build the first ones

Each recommendation is a rule, a tool or a gate. It says where it lives: a line in the project instructions, a skill, a script or a note. Rank by payoff. Build the top few, and for each one show it working or failing on purpose.

The step is done when the top recommendations exist as files in the right places and each has been exercised.

## 6. Report to the operator in one page

The report leads with the headline numbers, then where the time went, where the defects came from, what to keep and what to change. The operator should not need the three lens files. Link them for the evidence.

The step is done when the page names the next three changes and who makes them.

## Failure modes

- Findings without evidence. A retrospective full of plausible causes helps nobody. Delete them.
- Span hours read as work hours. A transcript's first-to-last timestamp includes every wait and every limit stop. Builders' spans are close to real work. Everything else is an upper bound.
- An unverified cause stated as fact. A five-hour stop with no agent active was probably host sleep. The sleep history had rotated out, so the audit says "unverified".
- Double counting. Several stalls appear in two lenses. The program total counted each stall once, and its rows are marked where they overlap.
- Trusting the ledger. The status ledger lagged the repository. Read git for what is merged, and use the ledger for intent.
- Taking agent claims at face value. 23 of 47 DELIVERED finals said the core proof had not run. Check the claim against the log.
- No timestamps. The audit was possible because the captain wrote a timestamped line at every step. Without that log, the throughput lens has nothing to measure.
- A report that ends the work. A ranked list nobody builds is shelfware. Build the top items in the same session.
