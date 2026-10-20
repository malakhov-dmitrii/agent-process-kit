# Defect causes

Classify every defect that escapes before anyone fixes it. The class says which input to repair.

## The classes

| Class | Meaning | Fix the input with |
|---|---|---|
| Spec or coverage | The card was wrong, or no card covered the surface | the coverage inventory, a blast radius on every decision |
| Verification | The checks looked in the wrong place: another browser, the dev server, no data, no wide screen, no real device | the proof matrix, a realistic fixture, a real device |
| Brief | The rule existed but the brief left it out or stated it too narrowly | the template with copied rules |
| Churn | A decision, owner or promise changed, or an estimate or claim was wrong | the decision log, the ownership register, the promise ledger |
| Regression | A later card or release broke an earlier one | an invariant test for the earlier behavior |
| Ignored rule | The agent had the rule in its brief and broke it | a gate that fails, because prose did not hold |

Record a primary class and, if it applies, a secondary one. The primary class is the one whose fix would have prevented the defect alone.

## The audited program

29 defects were found by the owner or a teammate by eye. Counting primary classes only:

| Class | Defects |
|---|---|
| Spec or coverage | 14 |
| Verification | 8 |
| Brief | 3 |
| Churn | 3 |
| Regression | 1 |
| Ignored rule | 0 |

Counting secondary causes as well, verification gaps were involved in 15 defects and regressions in 4. The review found no case of an agent breaking a rule its brief contained. Rules were missing, too narrow or added late.

At least 24 of the 29 were in production when found. The gates and the code reviews of the time caught none of them first. Each class that recurred then got a gate: shape nesting, wide-screen layout, same-row heights and badge anti-vacuity checks. These stopped those classes from returning (see `design-gates`).

This is one program with one owner, classified by one reviewer from transcripts and release notes. Use the numbers as a prior. Your table will differ.

## The record

Keep one table per program:

```text
| # | Defect | Found by, when | In prod? | Primary / secondary | Evidence | Gate or rule that would have caught it |
```

Fill "Gate or rule that would have caught it" with something you can build. "Be more careful" is not an entry. A defect with no such entry is a product or design call. Settle those with a prototype the owner sees before any code.

## Procedure

1. Read the defect and its first report. Quote the owner's words.
2. Reproduce it, or state that it cannot be reproduced.
3. Find the commit and the card that introduced it.
4. Ask which input was wrong: the surface list, the decision, the brief, the check or the order of changes.
5. Write the class, the evidence and the missing gate.
6. Repair the input, then the code, in that order.

## Failure modes

- Blaming the agent. In this program that was never the cause. A rule violation that does appear should get a gate, because the next agent will break the same prose rule.
- Labelling hypotheses as causes. Three early causes were wrong when stated (a browser, a pointer event, a release date). They were labelled as hypotheses, which was right, and they still steered the next briefs. Test a cause before you brief on it.
- Counting only the owner's finds. Teammates and users find defects too. Count them, with the source.
