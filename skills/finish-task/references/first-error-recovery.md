# First-error recovery

An error is a new fact. Preserve it before changing the plan.

1. Record the exact command or action, exit status and relevant output.
2. Classify the failure:
   - **product**: the behavior under test is wrong;
   - **fixture**: the test does not represent the claimed behavior;
   - **environment**: a prerequisite, permission or service is unavailable;
   - **invocation**: the command, path or target is wrong;
   - **flaky**: the same state produces inconsistent results.
3. Choose the smallest probe that can distinguish the leading explanations.
4. Repair the cause, then rerun the same proof.
5. Update the Finish Card with the result and next step.

After three unsuccessful fixes for the same failure, stop patching. Re-check ownership, data flow and the reproduction. A fourth edit needs a new fact, not a new guess.

An unavailable check is never a pass. If no safe alternative proves the required acceptance item, report `NOT-VERIFIED` or `BLOCKED` with the missing prerequisite and owner.

