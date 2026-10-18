# Visual gates

The static gate reads source. The visual gate looks at a running page. It has two parts: geometry specs, which test one rule precisely, and a style matrix, which walks many screens and checks a common list.

## Geometry specs

Write one spec per rule that an owner decision created. The audited program's gate held specs for nesting, round controls, the phone header, wide screens and toolbar heights, and its matrix checked touch targets. These are the rules and their assertions:

| Rule | Assertion |
|---|---|
| Nested shapes are concentric | for each inner shape, inner radius = outer radius - inset, within a pixel |
| Controls in a row share one height | same-row heights within 0.5 px |
| No overflow | no horizontal scroll from 320 px up to 3840 px |
| Wide screens | one page frame, no fixed pixel cap on a plane, balanced gutters, from 1024 to 3840 px |
| Phone header | the collapsed header capsule stays inside the gutters |
| Touch targets | at least 44 px on a phone |

Practices that earned their place:

- Measure after the animation ends. Two specs failed because they measured mid-animation, at 1.41 px and 6.9 px.
- Fail on zero matches. A badge check passed with no badges on the page. Count the elements the assertion found and fail when the count is zero.
- Scroll to the control. See the first-viewport note below.
- Print the rule name, the broken expectation and a screenshot path on failure. The reporter prints one block per failure, and a test keeps its summary from losing a rule name.
- Further rules from the brief template: a picker edge within 1 px of its trigger, badges inside their container, icons centered within 0.5 px. They were named as gates that would have caught defects, and the program had not confirmed them as running gates.

## The style matrix

The matrix is a table of cells: style x theme x screen x viewport. For each cell the spec opens the screen and checks a common list.

| Check | Threshold |
|---|---|
| text contrast | 4.5:1, and 3:1 for large text and UI parts |
| touch targets | 44 px on phone cells |
| nesting | concentric radii |
| clipping and overflow | nothing cut off, no horizontal scroll |
| page errors | no console or page errors |

Run every cell in two opposite themes, dark and light. A value that holds in one theme can fail in the other, and a style that redeclares tokens can leak values across themes. The matrix is where that shows up. In the audited program a style pack was defined as tokens only and never colors, so a pack could not smuggle a fixed color into both themes.

Cells in the release gate:

- a desktop viewport in the engine with the best paint support,
- the same engine with a phone viewport, pixel ratio and touch,
- one smoke cell in the engine that phones really use.

The release gate ran a subset on purpose: the shipped style, both themes, every matrix screen. The full matrix alone was 151 cells. Other styles, other engines and extra widths lived in their own configs until they were green and fast. List those configs, name an owner, and move them into the gate when they pass.

## The new-surface registry

Keep the matrix screens in one registry. Add a test that fails when a spec renders a surface that is neither in the registry nor listed as "not themable, with a reason" or "legacy debt". Planting an unregistered surface produced this failure in the program:

```text
new-feature-geometry.spec.ts renders "settings/payouts-v2": add a screen to MATRIX_SCREENS and its route to MATRIX_ROUTES, or NOT_THEMABLE with the reason
```

## Limits to state in every report

- The matrix judges what is in the first viewport. A control below the fold is not measured. Put the check in a geometry spec that scrolls to it, or open the screen scrolled.
- A headless engine on a server paints no backdrop blur. Treat glass and blur as unverified until a simulator or a real device has looked at them. Treat server-side engine runs as geometry only.
- Run on the production build. A dev server skips the minifier and serves about 1,500 unbundled modules, which also made one engine time out on cold pages.
- Use the owner's environment. The owner's browser, a shorter window and a wider screen found defects that the default matrix did not.

## Fixtures

A check on empty data passes for the wrong reason. The shared fixture workspace should hold at least 12 items in lists, items in at least 3 folders, badges of 1, 2 and 99+ digits plus a muted badge, groups and channels with photo, video and link-preview media, every role, and a sent message in each delivery state. Report a missing fixture as its own outcome, never as red and never as a pass. About 17 cards in the program had their browser acceptance skipped because the lane database lacked data. The fixture-missing outcome is a recommendation that has not been exercised yet.

## Receipts

A red run prints `DESIGN GATE: FAILED`, one block per failure, copies the screenshots to a folder that survives the run, writes no receipt and so blocks the deploy script. A green run's receipt says `design=pass`. A gate run on a laptop cannot run the visual part. It needs an explicit skip flag, and the release note records the skip.
