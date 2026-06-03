---
name: code-review
description: Review code changes for correctness, maintainability, security, test coverage, and regressions. Use when asked to review a diff, PR, branch, staged changes, or specific files before merge.
---

# Code Review

Perform a focused, evidence-based code review. Prioritize defects that matter. Avoid style-only noise unless it harms readability or violates local conventions.

## Review Target

Infer target from user prompt:
- No target: review unstaged + staged changes against `HEAD`.
- `staged`: review `git diff --staged`.
- branch/PR/base named: compare with that base.
- file paths named: review only those files or diffs.

If target is ambiguous and multiple plausible scopes exist, ask one short clarification before reviewing.

## Steps

1. Inspect repository state:
   - `git status --short`
   - relevant `git diff` / `git diff --staged` / `git diff <base>...HEAD`
2. Read changed files and nearby context when needed. Do not rely on diff alone for behavior claims.
3. Identify project conventions from nearby code, tests, package files, linters, and docs.
4. Check for:
   - correctness bugs and edge cases
   - API/contract breaks
   - data loss, races, leaks, resource handling
   - security and privacy issues
   - error handling and observability gaps
   - test coverage gaps for changed behavior
   - maintainability issues that will slow future changes
5. Run targeted tests or static checks only user specifically asks to else DO NOT RUN TESTS or CHECKS
6. Produce concise findings with file/line references when possible.

## Finding Severity

Use these labels:
- `Blocker`: merge will likely break production, data, security, or builds.
- `Major`: likely bug or missing test for risky behavior.
- `Minor`: maintainability issue, edge case, weak naming, or small test gap.
- `Nit`: optional polish. Keep rare.

## Output Format

Start with verdict:
- `Verdict: approve`
- `Verdict: approve with comments`
- `Verdict: request changes`

Then findings, highest severity first:

```markdown
- [Major] path/to/file.ts:42 — Short title
  Problem: what is wrong and why it matters.
  Suggestion: concrete fix or test to add.
```

End with:
- `Tests run:` list commands, or `not run` with reason.
- `Open questions:` only if needed.

## Review Principles

- Be specific. Cite exact code, behavior, and failure mode.
- Prefer fewer high-signal findings over long lists.
- Do not invent line numbers. If exact lines unavailable, cite file/function.
- Separate confirmed issues from questions.
- If code is sound, say so and note any checks performed.
- Do not rewrite large sections unless user asks; suggest minimal fixes.
