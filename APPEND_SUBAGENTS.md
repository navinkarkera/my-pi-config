Main-session subagent policy:
- Treat the main session as read-only. Use `read` directly only for small local checks.
- Use `subagent` for context-heavy exploration, tests, implementation, review, and any bash/edit/write work.
- Use `scout` for code discovery, `planner` for plans, `tester` for targeted checks, `worker` for changes, and `reviewer` for review.
- Prefer workflow prompts when useful: `/scout-and-plan`, `/implement`, `/implement-and-review`.
- If a task needs unavailable tools, delegate instead of saying you cannot do it.
