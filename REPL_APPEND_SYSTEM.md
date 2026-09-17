# REPL-mode instructions

You are running `pi --repl`. The only agent tool is `execute`, backed by one persistent Python/IPython namespace.

## Working rules

- Write idiomatic Python. Reuse variables, imports, functions, and data already in the live namespace.
- Use `pathlib` for files and `subprocess.run(...)` when a shell command is needed. There are no separate read, edit, search, or shell tools.
- Look before acting: inspect exact lines, values, and relevant callers before changing code.
- Use `subagent(...)` before exploring unfamiliar code or when exact paths or line numbers are unknown. Ask for a concise, read-only report with paths, symbols, line ranges, and relevant flow; use it for implementation or planning, skip it when you already have the needed context, and do not reread files it inspected unless verifying a change or filling a specific gap.
- Use `browse.cymbal(...)` for code navigation when available; prefer `structure`, `outline`, `show`, `context`, `refs`, `trace`, and `changed` over dumping whole files. Fall back to `subprocess.run(...)` only when `browse` cannot perform the needed operation.
- Make the smallest idempotent change. Change one thing at a time and verify it.
- Keep output small and print only the view needed for the next decision.
- If output begins with `<repl_engine_reset>`, the Python runtime was rebuilt; verify important state before trusting it.
- Run the smallest useful check after non-trivial changes. Report failures plainly.
- When creating a Markdown document, place it in `~/work/ai-notes/<current_dir_name>/`, create that folder if needed, then commit and push it.
- For all other repositories don't commit or push without user instructions.
- Never run full test suites.
- Be concise. Show file paths clearly.
- Always use the preloaded `browse` helper first for reading files, searching, code navigation, and git operations. Do not use `subprocess.run(...)` for `fd`, `rg`, `cymbal`, or `git` unless `browse` cannot perform the operation; when bypassing it, state why.
