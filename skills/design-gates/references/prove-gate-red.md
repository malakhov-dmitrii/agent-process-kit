# Prove a gate red

A gate that is green on a clean tree tells you nothing about whether it can fail. Show it failing, then show it passing, before you trust it.

## Procedure

1. List the rule classes the gate claims to cover. One row per class: a literal color, a literal radius, a forbidden import, an unregistered surface, a non-concentric nest, a same-row height mismatch, a zero-match assertion.
2. Create a throwaway branch or worktree off the commit that holds the gate. Never plant on a branch you will ship.
3. For one class, plant one violation. Keep it small and realistic: a hex color in a feature file, a literal `rounded-lg` class, an import of a banned overlay library, a spec that renders a screen the registry lacks.
4. Run only that gate. Save the full output to a log named after the class.
5. Read the output. It must show:
   - the rule name,
   - the file and line, or the screenshot path,
   - the fix, written as an instruction.
6. Remove the violation. Run the gate again and save the green output.
7. Repeat for each class. Keep the logs with the change that introduced the gate.
8. Run the whole gate on the final tree and record the commit.

## Record

```text
| Class | Planted violation | Red log | Rule named | Fix shown | Green log |
|---|---|---|---|---|---|
| colour-hex | `#ff0000` in a feature file | red-hex.log | yes | yes | green-static.log |
| radius-literal | `rounded-lg` in a feature file | red-radius.log | yes | yes | green-static.log |
| overlay import | banned library import | red-import.log | yes | yes | green-static.log |
| new surface | spec renders an unregistered screen | red-surface.log | yes | yes | green-visual.log |
| nesting | inner radius that is not outer minus inset | red-visual.log | yes | screenshot path | green-visual.log |
```

Rows with invented log names show the shape. The audited program kept one red log per class: a hex literal, a radius literal and a banned import for the static gate, and a failing nesting run for the visual gate.

## What a good red looks like

```text
RATCHET FAILED
  [radius-literal] src/features/inbox/row-chips.tsx:195 must stay at zero. Use a radius role: capsule for controls, section for cards.
```

The name, the place and the replacement are in the first two lines. An agent that reads only this output can fix the problem.

## Checks on the checker

- Zero matches. Delete the element the assertion targets and run it. The assertion must fail.
- Pre-fix commit. Run the gate against the commit before a known defect was fixed. It must be red.
- Allow list. Add an entry for a file that has no hit. The gate must call it stale.
- Baseline. Raise a recorded count by hand and run the tool in plain and in write mode. Both must refuse unless `--allow-raise` is passed.
- Receipt. Write a green receipt, make the visual run fail so it invalidates the receipt, then try the deploy script. It must refuse, with the earlier green receipt still on disk.

## Failure modes

- Planting on the shipping branch and forgetting to remove it.
- Planting a violation the regex was written around. Use a violation you did not design the rule for, such as the same literal in a template string.
- Accepting a red whose message has no rule name. The next agent will not know what to change.
- Proving the gate once and never again. Rerun the table when the gate's rules change.
