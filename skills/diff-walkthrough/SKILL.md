---
name: diff-walkthrough
description: Writes a read-only walkthrough document for one fixed Git comparison, explaining what changed, why it was done (inferred rationale labelled), and how it works, then opens it in the user's tmux pane. Use when the user asks for a diff walkthrough or a guided visual explanation of selected changes. Not a code review or findings report.
---

# Diff walkthrough

Use the installed `diff-walkthrough` CLI from PATH (fallback: verified checkout `~/dotfiles/project-scripts/.local/bin/diff-walkthrough`). Read `diff-walkthrough {capture,render} --help` before the first run; do not reimplement or wrap it.

## 1. Capture once, inside the target repository

Default `diff-walkthrough capture` (tracked changes vs HEAD). For a commit, range, or subtree use the exact spellings from `capture --help`: `--commit REV`, `main...HEAD`, `main...HEAD -- src/`. Keep the printed `snapshot_id` and `snapshot_dir`, and read only the frozen `patch.diff` plus `manifest.json` and its `target` ids.

## 2. Write private notes outside the repo

Write JSON matching the schema printed by `render --help`: `snapshot`, `groups[{title, targets[{id, what, why, how}]}]`, optional `omitted[{id, reason}]`. Put the file in a private temp path (`mktemp`); never write into the target repository.

- Keep 2-5 small thematic groups in reading order; a file's hunks must stay in patch order.
- `what` is the change in plain words, `how` the mechanism, `why` the rationale — mark it "(inference)" unless the code, commit message, or user states it.
- Select meaningful hunks. Omit tests, fixtures, and permission-only changes by default unless the user asks, and give each a reason in `omitted`. The CLI counts every target you leave out.

## 3. Render and open by default

Run `diff-walkthrough render --snapshot <id> --notes <file> --open` and open it without a second confirmation: `--open` shows the document with `less -R` in the user's tmux pane.

- Use plain `render` (no `--open`) when the user asked not to open it, or when a background/delegated worker prepared it for handoff: pass the printed `document<TAB>path` to the user-facing agent. Never open a pane in a worker-only session and never guess a tmux session.
- If `--open` fails (no `$TMUX`, viewer error), say so and give the document path already printed on stdout. Do not open an alternate viewer.
- The CLI validates the notes and renders; add no scripts, post-processing, or extra formatting.

## 4. Reuse the snapshot for follow-ups

For another theme, more context, or tests, write a new notes file against the same snapshot and render again: frozen slices and line numbers never move. Snapshots live in `$TMPDIR`, expire 24h after capture, and are pruned by the next capture. If it is gone, say so and ask before capturing again — never silently recapture.

```bash
id=$(diff-walkthrough capture | awk -F'\t' '$1=="snapshot_id"{print $2}')  # once, in the repo
diff-walkthrough render --snapshot "$id" --notes "$notes" --open
```

In Pi: `/skill:diff-walkthrough HEAD~1` or `/skill:diff-walkthrough main...HEAD -- src/`.
