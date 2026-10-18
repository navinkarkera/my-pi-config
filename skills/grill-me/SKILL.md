---
name: grill-me
description: Interview the user relentlessly about a plan or design, one round of related questions at a time, and capture durable vocabulary and decisions in ~/work/ai-notes. Use when the user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview me relentlessly until we reach a shared understanding. Keep the durable record in `~/work/ai-notes` — **never write generated docs into the current repo**.

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

`<current_dir_name>` is the basename of the session's current working directory — the folder name you are working in. The target folder, `<notes_target>`, is `~/work/ai-notes/<current_dir_name>/`; create it if it does not exist.

Before writing, read `~/work/ai-notes/AGENTS.md` (if present) and the existing notes in the target folder. Search before writing; update an existing note instead of adding a near-duplicate.

Never overwrite a definition the user relied on elsewhere. If a new definition conflicts with an existing one, keep both and flag the disagreement.

### Vocabulary → CONTEXT.md

Record durable vocabulary in the target `CONTEXT.md` under `## Language`. Create a minimal `CONTEXT.md` only when a term is actually settled — do not scaffold one up front.

Write resolved terms inline during the interview, as soon as they crystallise — into the ai-notes target, never the source repo.

### Decisions → <notes_target>/decisions/NNNN-slug.md

Write a decision note only when all three hold: hard to reverse, surprising without context, and a real trade-off. Otherwise skip it.

Number sequentially: scan the target's existing decision files and take the next number, starting at 0001. Keep it short: status, context, decision, options considered, consequences, plus provenance (source repo, branch, commit). Metadata/frontmatter follows `~/work/ai-notes/AGENTS.md`, including `type: decision`.

## Domain awareness

**Challenge against the glossary.** When the user's term conflicts with the target `CONTEXT.md` or an existing repo glossary, call it out immediately: "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

**Sharpen fuzzy language.** Propose a precise canonical term: "You're saying 'account' — do you mean the Customer or the User? Those are different things."

**Discuss concrete scenarios.** Invent scenarios that probe edge cases and force precision about the boundaries between concepts.

**Cross-reference with code.** When the user states how something works, check whether the code agrees. Surface contradictions: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

## Committing

At session end, once, in `~/work/ai-notes` — never in the source repo:

1. `git status` and diff **only the target path**.
2. If a target note had pre-existing edits you did not make, ask before including them.
3. Stage exactly the files you touched. Never `git add -A`, never sweep unrelated changes.
4. If no ai-notes file changed, skip the commit and push. Otherwise commit the touched files as `docs(<folder>): <summary>`, where `<folder>` is `<current_dir_name>`, then push normally.
5. If commit or push fails, report it plainly. No force, no rebase.
