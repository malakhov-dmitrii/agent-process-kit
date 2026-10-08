# Finish Card

Keep the card short enough to scan while the work is moving. Prefer the project's existing task-doc location. Otherwise use `.agent/tasks/<slug>.md` for work that spans several meaningful edits, checks or sessions.

```markdown
# Finish Task: <short task name>

## Goal
<One observable result.>

## Scope lock
- In scope:
- Non-goals:
- Delivery boundary: local | commit | push | deploy | production verification
- Review cap: plan <= 2, code <= 2

## Acceptance
- [ ] A1: <user-visible behavior and proof>
- [ ] A2: <regression or acceptance check>
- [ ] A3: <real handler, CLI, browser or session path>
- [ ] A4: <affected project gates and docs>

## Evidence
- Red proof:
- Review:
- Automated checks:
- Real user path:
- Delivery receipts:

## Delivery
- Verified stage:
- Remaining work:
- Next owner:
```

Check an item only after recording evidence. Keep progress narration in normal updates instead of growing the card. Add project-specific fields only when project rules require them.
