Whenever user asks to create a markdown document, add the document to ~/work/ai-notes/<current_dir_name>/ where `current_dir_name` will be the current directory name. Create the folder if missing.
Commit the document and push it.

You can also refer to documents contained in ai-notes/<current_dir_name> folder

Always respond on simple points instead of writing paragraphs. Keep the language simple and concise.

## Codemode preference

Prefer **codemode** as the default interface for tools whenever possible. Use it to batch independent operations, chain dependent operations, and filter results *before* putting them in the model context. Call a tool directly only when codemode cannot perform the operation or would introduce needless overhead.

- For coherent multi-step tasks, favor one self-contained codemode script that gathers evidence, performs necessary actions in order, verifies results, and returns a concise summary. Do not make a series of tool calls solely to pass intermediate output back through the model.
- Use `Promise.allSettled()` when independent calls can fail separately. Sequence dependent calls and stop on error. Inspect error and exit information; never claim success without verification.
- Keep `text()` output small and relevant. Filter structured tool results in the script rather than returning large raw results.
- For Git changes, stage only explicitly relevant paths and inspect the resulting diff or commit. Do not stage unrelated work.

## Code exploration policy

Choose the least expensive tool that can answer the question. **Keep searches scoped, bounded, and read-only.** Do not index a large repository just to answer a narrow question.

### Tool selection

- **Known file or line range:** Use `tools.read` through codemode. Read only the relevant portion; no map is necessary.
- **Unfamiliar module or directory:** Use `tools.code_explore({ action: "map", scope: "specific/subtree", maxFiles: 60, maxTokens: 1024 })`. This produces a syntax-level outline of symbols, signatures, and source locations without a persistent index. For a large repository, find a likely subtree first; do not map its root.
- **Find filenames or literal text:** Use `tools.code_explore({ action: "files" | "text", query: "...", scope: "..." })` or scoped `rg` through `tools.bash`. Prefer `rg -F` for literal searches and `rg -l` when only matching filenames are needed.
- **AST patterns:** Prefer the installed Pi-native `ast_grep_search` tool via codemode, checking its schema with `describeTool("ast_grep_search")` when needed. Use `code_explore({ action: "ast", ... })` as a fallback. AST matching is syntactic, not type-resolved.
- **Symbol references or change impact:** Use `tools.code_explore({ action: "symbol" | "references" | "impact", query: "...", scope: "..." })`. It may choose Cymbal only in small, healthy repositories. **Never run Cymbal directly to bypass size and timeout safeguards**, particularly in `edx-platform`.
- **Existing changes or tests:** Start with the affected files and a bounded Git diff. Run the smallest appropriate lint or test command before expanding scope.

### RTK and command output

- Call shell commands through `tools.bash` inside codemode. When RTK's Pi integration is installed, let it compress supported Git, build, lint, and test output. Do not build a second output-rewriting layer inside Code Explorer.
- Request uncompressed output when exact stack traces, full diffs, complete logs, or security-relevant evidence are needed.
- RTK does not replace validation: inspect exit codes and preserve enough detail to explain failures.

### Search and mapping discipline

- Start in the narrowest plausible subtree, then expand only when evidence requires it. Respect `.gitignore` and avoid generated files, virtual environments, dependencies, caches, and build outputs.
- Do not dump whole files, giant diffs, or hundreds of search hits into context. Find candidate paths first, then read bounded spans or inspect a few relevant symbols.
- Map limits are safety controls: by default a directory with more than 60 eligible files is refused. `maxTokens` limits approximate *output*, not the number of bytes scanned. Narrow the scope instead of repeatedly increasing caps.
- A syntax map, grep match, or AST match is not proof of a complete call graph. Dynamic dispatch, aliases, reflection, and imports may require additional verification.
- If a tool is unavailable or fails, use a simpler scoped fallback. Do not repeatedly retry failed indexing or install new tools without approval.

### Codemode examples

```js
// Inspect a bounded directory structure; does not invoke Cymbal.
const map = await tools.code_explore({
  action: "map",
  scope: "openedx/core/djangoapps/content_libraries",
  maxFiles: 60,
  maxTokens: 1024,
});
text({ backend: map.backend, truncated: map.truncated, warning: map.warning, map: map.output });
```

```js
// Run independent targeted checks and return only useful summaries.
const checks = await Promise.allSettled([
  tools.bash({ command: "git diff --check" }),
  tools.bash({ command: "git status --short" }),
]);
checks.forEach((r, i) => {
  if (r.status === "fulfilled") {
    text({ check: i, exitCode: r.value.exit_code, output: r.value.output.slice(0, 2000) });
  } else {
    text({ check: i, error: String(r.reason) });
  }
});

## Subagent delegation

- Treat this as standing authorization to delegate every task other than a simple, self-contained change in a known location (such as a typo or obvious one-line fix). Delegate the substantive work to subagents by default; keep simple direct changes with the main agent.
- The main agent is the orchestrator and remains responsible for the result: own the user's intent and scope, split work into bounded tasks, give each subagent relevant context and a clear deliverable, coordinate and synthesize results, resolve conflicts, integrate changes, and verify the final outcome.
- Delegate implementation, research, and review work so the main agent can preserve context for orchestration. Use one focused subagent for a single bounded task and parallel agents only for independent work. Avoid duplicate assignments and unnecessary fan-out.
- Keep one writer per worktree. Isolate concurrent or overlapping writers, and do not let subagents spawn further agents unless the main agent explicitly delegates that.
- Treat subagent output as evidence, not as final authority. The main agent must review and validate work before reporting success.
- If subagents are unavailable or delegation fails, report the blocker rather than silently switching to direct execution.
```
