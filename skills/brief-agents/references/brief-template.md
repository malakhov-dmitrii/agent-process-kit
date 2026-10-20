# Brief template

Use it for every card, train and fix. Fill in or delete each line. A line left blank fails the brief. The sample rules and checks below come from a UI program. Swap them for your domain's rules, and keep the structure.

```text
TASK: <card id or defect>. One sentence on what a user will see.
WHY: <the owner's words, the time with zone, screenshot paths>
READ FIRST: <the design or architecture sections that bind, the decision log, the card file>
SCOPE:
  surfaces = <routes and states: loading, empty, error, long text, right-to-left, phone>
  blast radius = <only this screen | every <family> in the app>
NON-GOALS: <files and areas not to touch, and the owner of each neighbouring area>
RULES THAT APPLY (copy the text, do not link it):
  - <rule one sentence, with its check>
  - nested shapes are concentric: inner radius = outer radius - inset
  - controls in one row share one height token
  - motion uses transform and opacity only
ACCEPTANCE (user terms, measurable):
  - <what the user sees>
  - geometry: no horizontal overflow from 320 to 3840 px, same-row heights within 0.5 px
  - behavior: <keyboard, escape, focus, money, no double send>
  - every geometry or count assertion fails when it matches zero elements
DATA: <fixture and what it contains>. Missing data means extend the fixture. A skip is not a pass.
PROOF (you run it and you look at it):
  1. A failing test first, then green.
  2. The production build, not the dev server.
  3. The matrix: <engines> x <widths> x <themes>. Add a real device when blur, keyboard or scroll is touched.
  4. A before/after contact sheet at <path>. Tick each rule above against it.
  5. One review round with this rule list and the contact sheet. A visible finding needs a visible fix.
  6. After the deploy: the deployed revision, and a signed-in read-only check in the owner's browser and on a phone.
TIMEBOX: <agent hours>, checkpoint at <time and zone>. On overrun, report. Do not stall.
PROMISES: anything deferred becomes a card or a ledger line now. Name it in the final.
FINAL (in full): receipt LOCAL-ONLY until production is proved. Each acceptance line PASS or FAIL with an evidence path.
  What was not verified, and why. Follow-up cards created.
```

## Why each line is there

| Lines | Defects they address in the audited program |
|---|---|
| SCOPE with blast radius, READ FIRST | a rule applied to one screen instead of the app, twin pages, a panel on no card (6 of 29) |
| RULES copied in | shape, height, status-color and chip-cap rules that were absent or too narrow (4 of 29) |
| DATA and the zero-match rule | badges, many items and media that the fixtures lacked (3 of 29) |
| PROOF steps 2 and 3 | a dev server that hid a minifier bug, one browser and common widths only, no real phone (5 of 29) |
| PROOF step 4, the contact sheet | spacing, seams, clipping and "rest state looks like rest" that no assertion described (5 of 29) |
| PROMISES | a feature promised for a later wave and never carded (1 of 29) |
| NON-GOALS with owners | ownership that flipped four times, a control decided three times (2 of 29) |

Together the lines address the causes of 25 of the 29 defects. The other four were product and design calls that only a prototype shown to the owner can settle. Show the prototype first.

## The short brief for a fix

The fix briefs that worked first time were written after the owner complained. They had the same bones in fewer lines:

```text
QUOTE: <the owner's words and the time>
CAUSE: <hypothesis, labelled as a hypothesis>, with the commit or file it points at
RULE: <the rule this broke, copied in>
DONE WHEN: <measurable: widths 320 to 430, margin of 16 px, the right edge inside the viewport, labels not overlapping>
ENVIRONMENT: <the owner's browser and device>
PROOF: before and after screenshots, a failing test first
FINAL (in full): receipt, PASS or FAIL per line, what was not verified
```

One of these briefs found a root cause the first guess missed, because the agent checked the production CSS. Mark the cause as a hypothesis. Three early causes in the program were wrong, and each shaped the briefs that followed.

## Writing the acceptance line

State what a person sees, then add the number as a check. "A chatter sees the conventional status color on the sent message" is the acceptance. "Contrast at least 3:1" is a check on it. The number alone passed a color that looked grey.

Make every assertion fail on zero matches. A badge check passed with zero badges because the fixture had none. The assertion should count what it matched and fail if the count is zero.
