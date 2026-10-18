---
name: design-gates
description: Use when agents change UI that must stay consistent across screens, themes and devices, when a visual rule keeps breaking after release, or when you add a lint, ratchet or visual test and need to show that it can fail.
---

# Design gates

Prose rules do not hold at agent volume. In the audited program the owner found 29 defects and plan errors by eye, most of them visual, and no gate caught any of them first. Each class that recurred was then turned into a gate, and those classes stopped coming back. A gate that has never failed proves nothing, so every gate below is shown red once before anyone trusts it.

## 1. Write the rules once

Keep one design document: tokens, primitives, layout, shape, themes, the gates and the decision log. Feature code names role tokens and composes primitives. It writes no literal color, radius, shadow, border width, pixel font size, z-index or duration, and it imports no overlay library directly. Keep one copy. An older frozen copy in the audited program kept teaching token names after they were renamed, and new files referenced tokens that nothing defined.

The step is done when a new agent finds the rules, the primitives table and the gates in one file.

## 2. Put a static gate in the push gate

The static gate runs in seconds, before the type check. It holds a ratchet with zero targets, counters that may only fall, and an allow list with reasons. It adds a scan for net new literals in the files a change touches, a test that every referenced token exists, and a test that the docs name no dead token. Details and a script are in [static ratchet](references/static-ratchet.md).

The step is done when a planted literal fails the gate and the message names the rule and the fix.

## 3. Put a visual gate in the release gate

The visual gate runs geometry specs and a style matrix against a fresh server, in two opposite themes. It runs on a runner, in the release class of the slot queue. Details are in [visual gates](references/visual-gates.md).

The step is done when a planted layout violation fails the release gate, prints a screenshot path and writes no receipt.

## 4. Make every new surface join the gates

A screen, panel or shared control is not done until a geometry assertion or a matrix screen covers it, or a written reason says why not. Enforce it with a test: a spec that renders a surface missing from the matrix registry fails.

The step is done when a planted unregistered surface is red.

## 5. Prove every gate red

For each rule class, plant one violation, capture the red output, remove it and run green on the final tree. The procedure is in [prove a gate red](references/prove-gate-red.md).

The step is done when a table lists each class with its red log and the final green run.

## 6. Look at the screenshots

Gates measure and people notice. The implementer opens every screenshot before reporting. The checklist: square corners inside round ones, radii that do not nest, a flat color where a material should show, clipped text, overflow at 320 px, icons off center, low contrast, and a resting control that looks focused. In the audited program the agent's own screenshot pass found problems the checks had passed, and only after the owner asked for it.

The step is done when the final report names the screenshot files that were opened.

## 7. Tie the receipt to the design verdict

A red visual run writes no receipt, so a deploy script that reuses only matching receipts refuses to ship. A green run writes `design=pass`. A receipt without that flag predates the gate and is not reused. See `verify-delivery` for the receipt script.

The step is done when a deploy attempt on a tree with a red design run is refused.

## Failure modes

- Raising a baseline to get green. The script refuses to raise a recorded count. Real exceptions go in the allow list with a reason, and a stale entry fails.
- A blind spot for a teammate's area. The program exempted one area while a teammate owned it. After that feature shipped, the exemption became counted debt that may only fall, and the same rules applied.
- The dev server instead of the production build. A minifier folded `translate` into `transform`, and a header capsule sat off screen for two days while every dev-server run passed.
- A headless engine with no blur. Glass was owed on a real device in six release notes and was first checked in a simulator after nearly five days.
- A subset by design. The release gate ran one pack, two themes and three cells, because the full matrix alone was 151 cells. Checks left out of the gate need an owner and a list, or they rot. Two wide-screen checks were left out because they were out of date.
- First viewport only. The matrix judged what was visible on load. A 36 px trigger lower on a page passed, and the same trigger above the fold failed. Scroll to the control.
- Zero matches pass. Make each assertion fail when it matches nothing.
- An orphan server. A killed gate left its dev server holding a port for 5 hours. Stop servers on exit.
- Missing data. About 17 of roughly 110 cards had their browser acceptance skipped or replaced by a read-only production check because the lane database lacked data. Extend the fixture instead.
