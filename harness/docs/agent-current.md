# Repository CURRENT compatibility

`.agent/CURRENT` can contain a task ID or JSON:

```json
{"task_id":"demo","status":"active","journal":".agent/tasks/demo.md"}
```

Legacy status labels are active, paused, blocked, handoff and done. The pointer
is discovery data for a chat; an explicit binding selects its task. Handoff
does not mutate CURRENT. Journals need a matching unfenced `Task-ID: demo`.
Review and update older unidentified journals before binding them.

See [workflow](../../docs/workflow.md).
