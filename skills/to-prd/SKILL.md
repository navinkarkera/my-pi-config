---
name: to-prd
description: Turn the current conversation context into a PRD note under ~/work/ai-notes, updating a matching existing PRD in place. Use when user wants to create a PRD from the current context.
---

This skill takes the current conversation context and codebase understanding and produces a PRD note. Do NOT interview the user — just synthesize what you already know.

PRDs live in the ai-notes repo, not in an issue tracker. Do not write to any tracker or apply triage labels.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area you're touching.

2. Resolve the ai-notes project folder before writing:
   - Read `~/work/ai-notes/AGENTS.md` for the conventions.
   - Match by source repository or project name to a top-level folder, not by the worktree or subdirectory leaf name. Fall back to the topic folder that fits. Ask if nothing fits and the choice is unclear.
   - Read `<folder>/CONTEXT.md` and `<folder>/TODO.md` if present.
   - Search existing notes before writing: `qmd query` for concepts and `qmd get` for full sources; `zk --notebook-dir ~/work/ai-notes list --match '<terms>'` for exact terms. Pin the notebook explicitly — do not rely on `ZK_NOTEBOOK_DIR`.

3. Sketch out the major modules you will need to build or modify to complete the implementation. Actively look for opportunities to extract deep modules that can be tested in isolation.

A deep module (as opposed to a shallow module) is one which encapsulates a lot of functionality in a simple, testable interface which rarely changes.

Sketch out the seams at which you're going to test the feature. Prefer existing seams to new ones and use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one. Tests should assert external behavior, not implementation details.

Check with the user that these modules and seams match their expectations. Check with the user which modules they want tests written for.

4. Write the PRD using the template below to `~/work/ai-notes/<project>/prds/<feature-slug>.md` (create `prds/` if needed). If a matching PRD note already exists, update it in place instead of creating a near-duplicate. Follow the notebook's frontmatter conventions for important active notes and give the note one meaningful relative link to its nearest `CONTEXT.md`, `TODO.md`, index, or direct predecessor.

5. Before committing, check the link graph from the notes repo root: `zk --notebook-dir ~/work/ai-notes list --orphan` and `zk --notebook-dir ~/work/ai-notes list --broken-links`. Do not add a new active orphan or a broken internal note link.

6. Stage only the note paths you touched, inspect the staged diff, then commit and push. Do not stage unrelated files.

7. Reindex per the ai-notes instructions: `qmd update` (incremental); run `qmd embed` only when `qmd status` reports missing vectors.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
