---
name: to-issues
description: Break a plan, spec, or PRD into independently grabbable implementation tasks, written as local notes under ~/work/ai-notes, each declaring its hard blockers. Use when the user wants to convert a plan into tasks, issues, or tickets, create implementation tickets, or break down work into issues.
disable-model-invocation: true
---

# To Issues

Break a plan, spec, or conversation into a set of **tasks**: tracer-bullet vertical slices, each declaring the tasks that **block** it. Tasks are always local Markdown notes under the ai-notes repo. Issue references are read-only source context: never publish, edit, label, close, attach, or create anything on GitHub, GitLab, or any other tracker.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments. Record the provenance in the tasks.

Before writing, search the target notes folder and update an existing task rather than creating a near-duplicate.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Task titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tasks.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each task its **blocking edges**: the other tasks that must complete before it can start. A task with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own task blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a task blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify task; green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each task, show:

- **Title**: short descriptive name
- **Blocked by**: which other tasks (if any) must complete first
- **What it delivers**: the end-to-end behaviour this task makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each task only depend on tasks that genuinely gate it?
- Should any tasks be merged or split further?

Iterate until the user approves the breakdown.

### 5. Write the tasks locally

Write the approved tasks to `~/work/ai-notes/<current_dir_name>/tasks/<feature-slug>/<NN>-<slug>.md`, where `<current_dir_name>` is the basename of the session's current working directory. Write one file per task, numbered from `01` in dependency order (blockers first). Each file's "Blocked by" lists the numbers/titles it depends on, with relative Markdown links between the task files. Never write a single combined file, and never write generated Markdown into the source repo.

Read `~/work/ai-notes/AGENTS.md` for the conventions: project folder mapping (by source repository or project, not the worktree or subdirectory leaf), frontmatter metadata for important active notes, and TODO/link rules. Read the target `CONTEXT.md` and `TODO.md` if present. Search existing notes first with `qmd query`/`qmd get` and pinned zk (`zk --notebook-dir ~/work/ai-notes list --match '<terms>'`), and update a matching task in place rather than duplicating it.

Work the **frontier**: any task whose blockers are all done. For a purely linear chain that means top to bottom.

<local-task-template>

# <NN>: <Task title>

**What to build:** the end-to-end behaviour this task makes work, from the user's perspective, not a layer-by-layer implementation list.

**Blocked by:** the numbers/titles of the tasks that gate this one, or "None (can start immediately)".

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</local-task-template>

Avoid specific file paths or code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

### 6. Commit and reindex

From `~/work/ai-notes`, run the AGENTS.md graph checks (`zk --notebook-dir ~/work/ai-notes list --orphan` and `zk --notebook-dir ~/work/ai-notes list --broken-links`) and confirm the new files add no new orphan or broken internal link. Inspect the diff, stage only the exact note paths you touched, commit, and push normally. No force, no rebase. Then run `qmd update` and run `qmd embed` only when `qmd status` reports missing vectors. If the commit or push fails, report it plainly.
