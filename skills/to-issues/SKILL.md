---
name: to-issues
description: Break a plan, spec, or PRD into independently grabbable implementation tasks, written as local notes under ~/work/ai-notes, each declaring its hard blockers. Use when the user wants to convert a plan into tasks, issues, or tickets, create implementation tickets, or break down work into issues.
---

# To Issues

Turn a settled plan, spec, or PRD into **implementation tasks**: tracer-bullet vertical slices, each delivering demonstrable end-to-end behaviour and declaring only its hard blockers. Tasks are always local Markdown notes — this skill never creates or modifies anything on an issue tracker.

## 1. Gather context

Work from the conversation and from any spec, PRD, or issue the user references. A tracker issue (number or URL) may be read as source context: **fetch its full body and comments read-only**, and record that provenance in the tasks. Never publish, edit, label, close, attach, or create anything on GitHub, GitLab, or any other tracker.

Search the target folder first and update an existing task rather than creating a near-duplicate. Facts are the agent's job, never the user's: research the codebase and notes instead of asking. Explore enough to understand the current state, prefactoring opportunities, and the project's domain vocabulary.

## 2. Where tasks go

Every task goes to `~/work/ai-notes/<current_dir_name>/tasks/<feature-slug>/<NN>-<slug>.md`, where `<current_dir_name>` is the basename of the session's current working directory. Generated Markdown never goes into the source repo — not `.tasks/`, not `.scratch/`, nowhere in it.

## 3. Draft the slices

Each task is a **tracer bullet**. Produce the fewest complete vertical slices, each cutting through every layer it needs and demoable on its own. Avoid layer-shaped or file-shaped tasks and over-decomposition; a small change may be a single task.

**Guard the lower bound.** If the whole change fits one fresh implementation context and tasks would add no coordination or tracking value, recommend going straight to implementation; write one task only if the user still wants the tracking.

<slice-rules>
- End-to-end behaviour, not a horizontal slice of one layer
- Sized to fit one fresh implementation context window
- Acceptance criteria owned by this task, observable and falsifiable, and false at the commit the implementer starts from
- Any required prefactoring comes first, preserves behaviour, and makes the later slices easier
</slice-rules>

**Wide refactors are the exception.** One mechanical change whose blast radius breaks many call sites at once becomes expand → migrate → contract: add the new form beside the old; migrate in batches sized by blast radius, each batch independently green and blocked by the expand; contract once no caller remains, blocked by every batch. If the batches cannot stay green alone, give them an integration branch and a final integrate-and-verify task that every batch blocks.

**The testing seam belongs in the task.** Carry confirmed seams and spec user stories/outcomes across from the source. If a seam or a necessary design decision is missing, ask before writing. Facts get researched; unresolved design decisions are not implementation tasks — settle them or mark a clearly human-only step instead of pretending it is agent-ready.

## 4. Wire the dependencies

Every dependency must be a **hard blocker**, with no dangling or self edges, forming a DAG. Order the tasks blockers first and link each one to its blockers with relative Markdown links between the task files. Represent the executable frontier — which tasks can start immediately and which can run in parallel.

## 5. Quiz the user

Before anything is written, show the whole breakdown as a numbered list: **title**, **delivered behaviour**, **verification/demo**, **test seam**, **blockers**, and the spec **user story/outcome** each task covers.

Ask the user to approve the granularity, the blocking edges, and any merge or split choices. Do not write any task until they approve.

## 6. Write the tasks

One file per task named `<NN>-<slug>.md`, numbered from `01` in dependency order, blockers first. Each file records: title, delivered behaviour, acceptance criteria, blockers, status, test seam, how the work is verified or demoed, provenance (source spec or issue), and what is out of scope.

Before writing, read `~/work/ai-notes/AGENTS.md` and the target `CONTEXT.md` and `TODO.md`, and search first with `rg` plus zk run from `~/work/ai-notes` (`zk --notebook-dir ~/work/ai-notes list --match '<terms>'`). Every zk command uses `~/work/ai-notes` as its working directory and notebook root, so it can never resolve to the source repo. Task notes carry the AGENTS.md metadata with `type: plan`; if the target `TODO.md` is absent, create it with valid AGENTS.md metadata and link the new task files from it.

Mark genuine human-only or external steps clearly rather than presenting them as agent-ready, and keep task bodies free of file paths, line numbers, and code snippets — except a prototype snippet that encodes a decision, clearly attributed as one.

## 7. Commit local tasks

From `~/work/ai-notes` (the working directory for every zk command): run the AGENTS.md graph checks (`zk --notebook-dir ~/work/ai-notes list --orphan` and `zk --notebook-dir ~/work/ai-notes list --broken-links`), note the pre-existing baseline, and confirm the new files add no new orphan or broken internal link. Then inspect the target-path diff, ask before including pre-existing edits you did not make, stage only the exact files you touched, commit as `docs(<current_dir_name>): add <feature> implementation tasks`, and push normally. If the commit or push fails, report it plainly. No force, no rebase.
