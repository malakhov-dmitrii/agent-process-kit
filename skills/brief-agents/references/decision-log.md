# Decision log and promise ledger

The owner decides things in chat. Agents read cards. The log is the bridge: a dated list where a decision overrides the specs, mockups and cards that came before it.

## The decision log

Keep it in the repository, next to the rules it changes, so every agent reads it with them.

```text
| Date | Decision | Blast radius | Lives in |
|---|---|---|---|
| 2026-03-02 | Nested shapes are concentric: no square corners inside a round container | every control family and every content card | token file, nesting geometry spec |
| 2026-03-04 | A status icon keeps its conventional color on sent messages | all themes | color token, status-icon test |
| 2026-03-05 | Dashboards live at one route each, twins redirect | all report pages | route test |
```

The rows above use invented dates and examples. The program's log had the date, the decision and where it lives. The blast radius column is the addition that the audit recommends.

Rules:

1. Add the line in the same change as the code. The test or code in the last column proves the decision still holds.
2. State the blast radius in words that a card writer cannot misread: "every control family", "all content cards". A decision written for one screen gets applied to one screen.
3. A decision is never reversed silently. A reversal is a new dated line that names the old one.
4. The log outranks card specs, mockups and older text. Say so at the top of the file and in every brief.
5. Lint the cards against it. Search card text for deprecations of any token the log protects. In the program, a card deliberately deprecated the status-icon color the owner had decided to keep, and the owner found it in production.

## The ownership register

Write down who owns each neighbouring area, and have both people confirm it before any brief changes. One area changed hands four times over four days: first "all of it belongs to a teammate", then "the interface is ours", then "the design is theirs too", then "hands off is removed". Each change rewrote briefs and wasted at least one agent run. Keep the register in the same file or a sibling.

## The promise ledger

Any sentence of the form "later", "in wave N", "after X" becomes a card or a ledger line in the same turn. In the program, a feature was announced as "the wave after the next". No card was created, and the owner asked for it three days later. The agent answered that it had never reached the plan.

A ledger line has an id, the promise in the owner's words, the date, the card that now holds it and its status.

## ETAs

Give an ETA for the next release as a clock time in the owner's local zone. Give a program ETA as a range that names its terms: integration, serial shipping, limits and machine capacity. Thirteen next-release ETAs in the program landed between 48 minutes early and 43 minutes late. Program ETAs missed by 9 to 70 hours, and the longest one assumed that agent-hours scale linearly. Times given in UTC drew a correction from the owner on the second day.

## Failure modes

- Decisions that live in chat. The next fresh agent never saw them.
- A log nobody tests. A line with no test or code in its last column is an opinion.
- A log that grows without pruning. Keep lines that still bind. Move superseded ones to a history section, with the date they were superseded.
