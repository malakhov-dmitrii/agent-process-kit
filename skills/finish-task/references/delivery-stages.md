# Delivery stages

Report each fact separately. Later stages include earlier work only when their own receipt proves it.

| Stage | What proves it | What does not prove it |
|---|---|---|
| `LOCAL-ONLY` | Current local checks and the real local flow pass on the changed tree | A diff, an old run, or “should work” |
| `COMMITTED` | An exact local commit contains the verified change | Uncommitted files or a commit from another tree |
| `PUSHED` | A remote ref contains the exact commit | A local commit or a successful `git push` message without remote readback |
| `DEPLOYED` | The target environment reports the exact revision or immutable artifact | A push, queued build, or green CI |
| `PRODUCTION-VERIFIED` | The real authenticated production flow passes on the deployed revision | Health alone, build metadata alone, or staging UAT |

The requested delivery boundary controls where the task stops. Never perform an external or irreversible stage without the user's intent and the project's release rules.

If a later boundary is outside the task, mark it `not requested`. If it is required but unavailable, record the missing proof and next owner; do not promote the stage.

