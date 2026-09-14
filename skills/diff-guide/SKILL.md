---
name: diff-guide
description: Explains and guides understanding of current diffs, PRs, commits, and branch changes with evidence-based answers and limited actionable risk critique. Use when asked to understand, explain, walk through, or answer factual questions about a diff, PR, commit, branch, staged/unstaged changes, or the changes in specific files.
---

# Diff Guide

Help the user understand a change before reviewing it. This is separate from `code-review`.

## Start and scope

1. Inspect repository state and anchor an explicit snapshot. Prefer `cymbal` when available; otherwise use generic Git, search, and file-reading tools.
2. For “current diff”, inspect status and include staged, unstaged, and untracked working-tree changes when present (`git diff HEAD` plus untracked file contents). Otherwise compare `HEAD` with its parent; for a root commit compare it with Git’s empty tree. In a repository without `HEAD`, treat untracked contents as the snapshot. Ask one short clarification only when plausible scopes materially differ. State exactly what is included, record the snapshot and state, and detect working-tree drift before factual answers or export; then ask whether to refresh or answer against the original snapshot.
3. Read changed code plus only necessary definitions, direct/meaningful callers and callees, tests, types, config, local docs/history, and conventions. Inspect generated, lockfile, snapshot, and vendor changes for consistency/anomalies, but do not routinely explain them.
4. Do not fetch or consult remote PRs, issues, or docs unless the user supplies or requests them. If local evidence is insufficient, request an external repository path or link.

## Guided explanation

Begin with a concise scope and change map, followed by a numbered recommended route. Walk one semantic section at a time and pause for questions/comments. Use small annotated snippets only when useful; cite exact `path:line` and/or symbols. Keep critique unsolicited and limited to evidence-backed, actionable correctness, security, regression, compatibility, performance, and test risks. Avoid subjective style comments unless they block understanding or violate a project convention.

For every claim—including findings, ledger notes, Q&A, and exports—distinguish **Fact**, **Inference**, and **Unknown**. Never imply runtime certainty from static inspection. Re-inspect code for follow-up questions rather than relying only on chat memory. Answer follow-ups in this order: direct answer, **Evidence**, **Reasoning/inference**, **Unknowns/verification**. Verification commands may be suggested, but do not run tests, execute project code, edit files, or perform Git mutations without explicit approval.

Useful opening shape:
```markdown
Scope: [snapshot/range and working-tree state]
Change map: [1–3 bullets]
Route:
1. [semantic section] — [why]
2. [semantic section]
3. [tests/config/integration]
I’ll start with 1, then pause. Claims are labeled Fact, Inference, or Unknown.
```

## Review ledger and controls

Maintain an in-session ledger keyed by section/location. Preserve each user comment verbatim, then add: normalized note, author/source, category, status (`confirmed`, `disputed`, or `unresolved`), verification performed/result, evidence, and follow-up. `confirmed` means verified by cited evidence. Record comments before verifying them; respectfully surface contradictions. Support `next`, `back`, `jump N`, `note ...`, and `ledger`, plus equivalent natural language.

## Export

Export only on explicit `finish` or `export`. Write a self-contained Markdown review to `~/work/ai-notes/<current_dir_name>/`, containing reviewed range/state, concise change map, user comments, AI findings, Q&A/open questions, decisions/follow-ups, and evidence references—not a transcript. Re-check snapshot drift first. Follow host, repository, and environment policy for committing or pushing the exported document rather than assuming either is available; report any failure.

Compact export/ledger shape:
```markdown
# Diff Guide: [repo/change]
Reviewed: [range, snapshot, state]
## Change map
## User comments
- Verbatim: “...” | Note: ... | Source: user | Category: ... | Status: ... | Verification: ... | Evidence: ... | Follow-up: ...
## AI findings
## Q&A and open questions
## Decisions and follow-ups
## Evidence
- `path:line`, `Symbol`, command/output snapshot
```

Remain read-only by default. For an export, follow the applicable host instruction and repository/environment policy on committing and pushing; do not assume Git push is available, and report failures.
