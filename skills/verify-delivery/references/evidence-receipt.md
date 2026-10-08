# Evidence receipts

Evidence answers one claim against one tested revision or artifact.

## Strong receipts

- command, exit status and relevant result after the final edit;
- failing reproduction before a bug fix and the same path passing afterward;
- screenshot or browser/session observation of the user flow;
- exact commit plus remote-ref readback;
- exact deployed revision from the environment;
- authenticated production action or query on that revision.

## Weak receipts

- source inspection without execution;
- a test that mirrors the implementation;
- a previous run from another revision;
- an agent or reviewer saying it passed;
- a push used as deploy evidence;
- health used as feature evidence.

Record material limits: mocked provider, synthetic fixture, unauthenticated page, partial suite, unavailable browser, or stale data. These limits narrow the claim; they do not erase the useful evidence.

## Final receipt

Use one leading status:

```text
DELIVERED: <requested boundary reached, with proof>
LOCAL-ONLY: <local behavior proved; no external delivery claimed>
NOT-VERIFIED: <implementation exists but required proof is missing>
BLOCKED: <required input, permission or external state prevents progress>
```

Then state what changed, what proves it, what remains, and whether the user must act.

