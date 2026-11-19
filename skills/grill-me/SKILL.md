---
name: grill-me
description: Interview the user relentlessly about a plan or design, one round of related questions at a time, and capture durable vocabulary and decisions in ~/work/ai-notes. Use when the user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview me relentlessly until we reach a shared understanding. Keep the durable record in `~/work/ai-notes` — **never write generated docs into the current repo**.

**The source repo is read-only.** Inspect its docs, code, glossary and map as evidence; route every generated glossary or decision entry to the matching project folder in `~/work/ai-notes`. Do not invoke the upstream domain-modeling writing flow or create `GLOSSARY.md`/`docs/adr/` in the source repo.

## The frontier

Grilling walks a decision tree, not a script. Map it as a **design tree**: every decision branches into the decisions that hang off it.

- The **frontier** is every decision whose prerequisites are already settled — the questions you can ask now without guessing at answers you have not heard yet.
- Ask **the whole frontier in one round**: number each question, give your **recommended answer**, and word each question so a plain "yes" accepts the recommendation. Then **wait for all the answers** before the next round.
- A question whose answer depends on another question still open in this round belongs to a **later round**, not this one.
- Fold in every answer, then **recompute the frontier** for the next round.
- Finish when the frontier is empty: say so, and state that nothing is left silently assumed. Stop earlier only if the user explicitly stops the interview.
- **Never implement, edit project code, or write docs into the current repo** until the design is settled and the user confirms.

Facts are the agent's job, never the user's. When a round needs a fact, delegate the lookup — a sub-agent or parallel tool calls, when the session allows — instead of asking the user, and never let it block questions that do not depend on it: ask those now, fold the fact in when it lands. Decisions stay with the user: put each one to them and wait.

## Presenting a round

When the `questionnaire` tool is available — directly, or as `tools.questionnaire` under codemode-only sessions — present the whole round in **one call**:

- One entry per frontier question, each with a unique `id` (`q1`, `q2`, …) and a `label` of `Q1 <short title>`.
- `prompt`: the full question, ending with `Recommended: <your answer>`.
- `options`: every option needs both required fields — `value` (the string returned) and `label` (what the user sees); using the same text for both is fine, and `description` is optional. Put the recommendation first, clearly marked (`label: "Yes — <your answer>"`), then the real alternatives the user might genuinely choose.
- `allowOther: true`, so "Type something." is available.

Wait for the completed submission (every tab answered) before the next round. Then read the result text rather than the `cancelled` flag alone: "User cancelled the questionnaire" means the user stopped — end the interview, do not re-ask; "UI not available" means the tool cannot render here — fall back to the numbered prose round below.

If the questionnaire is unavailable or the session is not `tui`, fall back to **one numbered prose round**, each recommendation on its own clearly separated line (`➡️ <your answer>`). Never split a round into single questions.

## Notes target

Before choosing a target, read `~/work/ai-notes/AGENTS.md` (if present). Match the source repository name to a top-level project folder and reuse it.

When launched from a subdirectory or a worktree, identify the source project and reuse its existing notes folder rather than creating a second one. If the repo is clear and no matching folder exists, lazily create `~/work/ai-notes/<repo>/`; ask only when the project or destination is ambiguous. Without a resolvable destination, keep interviewing and do not write rather than guessing.

Once the target exists, read its existing notes and search before writing; update an existing note instead of adding a near-duplicate. Never overwrite a definition the user relied on elsewhere. If a new definition conflicts with an existing one, keep both and flag the disagreement.

After editing notes, run `qmd update` (incremental); run `qmd embed` only if `qmd status` reports missing vectors.

### Vocabulary → GLOSSARY.md (default)

Record durable vocabulary in `<notes_target>/GLOSSARY.md` when the project has no established glossary; create it only when the first term is settled. Keep it pure vocabulary with tight definitions, scope and `_Avoid_` aliases; no implementation detail or spec-like prose.

Reuse an existing standalone vocabulary note, or the target `CONTEXT.md` under `## Language` if that is already the project's canonical glossary. Do not duplicate or migrate existing terms. Use the repo's own `GLOSSARY.md`/`GLOSSARY-MAP.md`, if any, as read-only evidence.

For a new standalone glossary, add one meaningful relative Markdown link between it and the nearest existing `CONTEXT.md` or project index, following `~/work/ai-notes/AGENTS.md`; no other scaffold unless those rules require it.

Write resolved terms inline during the interview, as soon as they crystallise — into the ai-notes target, never the source repo.

### Decisions → <notes_target>/decisions/NNNN-slug.md

Write a decision note as soon as it is settled, and only when all three hold: hard to reverse, surprising without context, and a real trade-off. Otherwise skip it and leave the choice in the conversation.

Number sequentially: scan the target's existing decision files and take the next number, starting at 0001. Keep it short: status, context, decision, options considered, consequences, plus rationale and provenance (source repo, branch, commit). Metadata/frontmatter follows `~/work/ai-notes/AGENTS.md`, including `type: decision`.

## Domain awareness

**Challenge against the glossary.** When the user's term conflicts with the target `CONTEXT.md`, a reused notes glossary, or the repo's existing glossary, call it out immediately: "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

**Sharpen fuzzy language.** Propose a precise canonical term: "You're saying 'account' — do you mean the Customer or the User? Those are different things."

**Discuss concrete scenarios.** Invent scenarios that probe edge cases and force precision about the boundaries between concepts.

**Cross-reference with code.** When the user states how something works, check whether the code agrees. Surface contradictions: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

## Closing

Finish by listing the notes actually changed in this session. Say plainly which decisions were conversational only and which were recorded as decision notes; do not expand into spec generation.

## Committing

At session end, once, in `~/work/ai-notes` — never in the source repo:

1. `git status` and diff **only the target path**.
2. If a target note had pre-existing edits you did not make, ask before including them.
3. Before staging, run the `AGENTS.md` link and orphan checks from the notes repo root; fix broken internal links or new active orphans you introduced, without inventing reciprocal links.
4. Stage exactly the files you touched. Never `git add -A`, never sweep unrelated changes.
5. If no ai-notes file changed, skip the commit and push. Otherwise commit the touched files as `docs(<folder>): <summary>`, where `<folder>` is the target folder, then push normally.
6. If commit or push fails, report it plainly. No force, no rebase.
