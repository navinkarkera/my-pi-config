Whenever user asks to create a markdown document, add the document to ~/work/ai-notes/<current_dir_name>/ where `current_dir_name` will be the current directory name. Create the folder if missing.
Commit the document and push it.

You can also refer to documents contained in ai-notes/<current_dir_name> folder

---

## Code Exploration Policy
Use `cymbal` CLI for code navigation — prefer it over Read, Grep, Glob, or Bash for code exploration.
- **New to a repo?**: `cymbal structure` — entry points, hotspots, central packages. Start here.
- **To understand a symbol**: `cymbal context <symbol>` — source + callers + imports in one call. Or `cymbal investigate <symbol>` for a kind-adaptive summary.
- **To understand multiple symbols**: `cymbal investigate Foo Bar Baz` — batch mode, one invocation.
- **To trace an execution path**: `cymbal trace <symbol>` — follows the call graph downward.
- **To assess change risk**: `cymbal changed` (unstaged edits; `--staged` for staged), `cymbal changed --base main` (working tree vs main), or `cymbal impact <symbol>` (transitive callers).
- **To review a symbol's diff**: `cymbal diff <symbol> [base]` — git diff scoped to one function's line range.
- Before reading a file: `cymbal outline <file>` or `cymbal show <file:L1-L2>`
- Read nested symbols: `cymbal show Parent.child` (e.g. a function inside a React component).
- Before searching: `cymbal search <query>` (symbols) or `cymbal search <query> --text` (grep)
- Before exploring structure: `cymbal ls` (tree) or `cymbal ls --stats` (overview)
- To find usage: `cymbal refs <symbol>` or `cymbal importers <file>`
- The index auto-builds on first use — no manual indexing step needed. Queries auto-refresh incrementally.
- Use `cymbal show <symbol>` to read a specific function/type instead of reading the whole file.
- All commands support `--json` for structured output.
