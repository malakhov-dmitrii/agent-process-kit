# Troubleshooting

| Result | Next step |
|---|---|
| `candidate` | Match current intent, then bind explicitly |
| `binding-mismatch` | Verify the actual chat/execution workspace before rebinding |
| `broken-binding` / `broken-pointer` | Inspect the journal path and matching unfenced Task-ID |
| `handoff-pending` | Retry the same identified acceptance as the same receiver |
| Already accepted | Coordinate with the recorded receiver; do not replace its acknowledgement |
| Lock exists | Confirm owner stopped, inspect state, remove only the stale lock, retry |
| Checklist `invalid` | Fix identity, section syntax, duplicate IDs or Evidence/Decision fields |
| Checklist `incomplete` | Required work remains |
| Setup directory exists | Inspect it; use its rollback receipt or a clean location |
| Rollback refuses edits | Preserve human edits and reconcile deliberately |
| `listen EPERM` in tests | Rerun with permission for localhost fixtures |

State is private data. Do not post raw journals or sessions publicly. Reduce failures to temporary fixtures and redact paths, identities and secrets.

For ineffective hooks, check registration, executable path, event, payload and trust status. Missing output or fail-open behavior does not establish successful verification.
