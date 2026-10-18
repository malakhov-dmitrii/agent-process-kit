---
name: brief-agents
description: Use when delegating work to another agent, writing a brief for builders or fixers, planning a large program as cards, or after a defect shows that an agent lacked a rule the owner already held.
---

# Brief agents

A weak executor is rarely the problem. In the audited program, a review classified the 29 defects that the product owner found by eye. 14 came from a wrong or missing spec or card, 8 from verification that looked in the wrong place, 3 from a brief that left out a rule, 3 from changed decisions or ownership, and 1 from a later card breaking an earlier one. None came from an agent ignoring a rule its brief contained. At least 24 of the 29 were live in production when found, and no gate or code review had caught any of them first. Fix the inputs.

## 1. List the surfaces from the code before writing cards

Cards written from specs left out whole screens. After 87 cards, a sweep from seven angles found 521 of 898 UI files that no card named, 51 overlay owners and 34 state components. It produced 30 more cards in about 25 minutes. Run that sweep as step zero, using [coverage inventory](references/coverage-inventory.md).

The step is done when every surface appears in a table with a card or a written reason.

## 2. Keep a decision log and a promise ledger

Owner decisions override specs and mockups, and they must not change silently. Keep one dated line per decision, with its blast radius and the test or code that holds it ([decision log](references/decision-log.md)). Any "later" or "in wave N" becomes a card in the same turn.

The step is done when each decision has a date, a blast radius and a place in code or tests, and no promise lives only in chat.

## 3. Write each brief from the template

Use the [brief template](references/brief-template.md). Copy the rules into the brief instead of linking them. Write acceptance in the user's terms, with measurable checks that fail when they match nothing. Name the data and the proof steps the agent runs and looks at. A line left blank fails the brief.

The step is done when a reader who has seen nothing else can say what done looks like and how the agent will show it.

## 4. Demand an honest final report

The final report starts with LOCAL-ONLY until the work is proved in the real environment. Each acceptance line gets PASS or FAIL with an evidence path, and the report lists what was not verified. Reject a DELIVERED that carries a "not run" line. Among 47 DELIVERED final reports in the audited program, 23 admitted that the core proof had not run.

The step is done when the orchestrator has checked every final against its acceptance lines.

## 5. Classify each escaped defect before fixing it

Give every defect a primary cause using [defect causes](references/defect-causes.md). Fix the input first: add the missing surface to the inventory, the decision to the log, the rule to the template, or a gate that would have failed. Then fix the defect.

The step is done when each defect has a class, a fix to the input and a test that would have caught it.

## 6. Review with the rules in hand

A reviewer that reads diffs finds logic and money bugs and sees no pixels. About 22 of roughly 40 reviewed releases had at least one blocker in round one. The blockers were behavior bugs: a price field that turned "." into zero and made a paid send free, a hotkey that sent the draft of the other pane. The same reviewer approved three mechanical batches that the owner rejected the next morning as visually wrong. Give the reviewer the rule list and a contact sheet of screenshots. A finding that users can see needs a fix that users can see. In one case a reviewer flagged a chip that was dropped from a row. The fix changed the accessible label and left the visible cap in place.

The step is done when the review prompt carries the rules and the screenshots.

## Failure modes

- Rules arrive after the defect. Every rule that would have prevented a defect first entered a brief after the owner found that defect. Before launch, ask the owner for the ten things they would reject on sight, and write them into the briefs.
- A numeric criterion replaces the outcome. A contrast ratio of 3:1 produced a color that looked grey, and a second release followed. Write "a user sees the conventional brand color" and add the ratio as a check.
- A rule applied to one block. "Make block C round" was read literally while the owner meant the whole app. State the blast radius in every rule.
- The test environment is narrower than the owner's. Tests ran in one browser at common widths while the owner used another browser, a shorter window and a wider screen. Widths of 1920 px or more appeared in 2 of 138 briefs. Ask once for the owner's environment and put it in the default matrix.
- A shared brief forbids the proof. A rule that builders must not render left visual proof to integration. See `run-agent-trains`.
- A promise without a card. A style feature announced as "the next wave" never became a card, and the owner asked for it three days later.
- Decision churn. The fate of one control was decided three times, and an area's ownership changed four times. Each change cost agent runs. Log the decision and confirm ownership with both people before changing briefs.
