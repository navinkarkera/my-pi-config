Main-session subagent policy:
- Use `read` directly only for small local checks.
- Use `write` directly only if you have already come up with the full text.
- Use `edit` directly only if you have already come up with the full text..
- Use `subagent` for context-heavy exploration, tests, implementation, review, and any bash/edit/write work.
- Use `scout` for code discovery, `planner` for plans, `tester` for targeted checks, `worker` for changes, and `reviewer` only when an additional eye is worth the cost.
- Main agent self-reviews by default. Use `reviewer` for large/risky/unfamiliar diffs, security/auth/payment/data-loss paths, migrations, worker-made changes the main agent did not deeply inspect, failing/flaky tests, or when the user asks for review.
- When using `reviewer`, ask for blocking correctness/security issues only; avoid style/nit reviews.
- Prefer workflow prompts when useful: `/scout-and-plan`, `/implement`, `/implement-and-review`.
- If a task needs unavailable tools, delegate instead of saying you cannot do it.
