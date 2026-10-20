# Coverage inventory

Write the list of surfaces from the code, then write the cards. A card list built from specs reflects what the specs remembered.

## What a sweep found

In the audited program, 87 cards had been written from specs when the owner pointed at a panel that no card covered. A sweep of the code compared the files that cards named with the files that existed:

| Angle | Result |
|---|---|
| UI files that no card names by path | 521 of 898 |
| of those, not named even by file name in any card text | 453 |
| files that own an overlay (dialog, sheet, popover, menu) and appear on no card | 51 |
| exported state components (banner, empty, skeleton, error, toast) on no card | 34 |
| route files mapped to feature modules | 99 |

The sweep produced 30 new cards, about 85 agent-hours of work, in about 25 minutes of parallel analysis. Two of the gaps were a panel the owner had already complained about and the application's error and not-found screens, which fell back to the framework default.

## The seven angles

Run them in parallel and merge the results.

1. By path. List every source file of the UI. List every path named in the cards. The difference is the first worklist. [`scripts/uncovered.sh`](../scripts/uncovered.sh) does this.
2. By file name. Drop each file whose base name appears anywhere in card text. This removes false positives from cards that mention a file without its directory. Run the script with `-b`.
3. By overlay. Search for the code that opens dialogs, sheets, popovers, menus and confirmations. List the files that own one and appear on no card.
4. By state. List exported components named like a banner, notice, strip, toast, empty state, skeleton, placeholder, error, hint or warning.
5. By legacy pattern. Count the old patterns the program is removing (literal sizes, literal colors, native controls, direct library imports) in every uncovered file. The count ranks the worklist.
6. By mount. Trace each uncovered component to the screen that mounts it. This separates real surfaces from dead code, contexts and hooks, and it groups files into screens a user would name.
7. By route. Map every route to its feature module. Check the cross-cutting passes (a shape pass, a glow pass) against the routes they claim to cover.

## The rule for covered

A surface is covered when a card restyles or changes its content. A card that only moves the container does not cover it. A codemod that swaps imports does not cover it either.

## Output

One table, kept with the cards:

```text
| Screen | Surface (files) | Card or pass | Note |
```

Split it into covered surfaces and gaps. Each gap gets a new card and a one-line reason ("the tab bodies carry 19 literals and raw buttons"). Add a list of questions for the owner, for example an area whose ownership is unclear, and settle those before briefs go out.

Give each route one canonical screen. Twin pages (the same dashboard under two routes with different looks) show up here. The program found its twin dashboards only after release.

## Failure modes

- Counting by prose. A card that mentions a panel in its goal text but lists none of its files looks like coverage. Check the card's file list and done criteria.
- Treating the list as a verdict. Dead code, generated files and test helpers appear in it. Open a sample before you write cards.
- Running it once. Rerun the sweep when a pass lands or a route is added. One page went live after the cards were generated and had no card.
