Whenever user asks to create a markdown document, add the document to ~/work/ai-notes/<current_dir_name>/ where `current_dir_name` will be the current directory name. Create the folder if missing.
Commit the document and push it.

You can also refer to documents contained in ai-notes/<current_dir_name> folder

Always respond on simple points instead of writing paragraphs. Keep the language simple and concise.

## Code exploration (Pi 1.0 codemode-first)

Use `codemode` for code exploration whenever possible. Keep operations inside one codemode script when they form a coherent task; filter and summarize intermediate results before printing them with `text()`. For independent searches use `Promise.allSettled()`. Avoid large raw dumps and repeated repository scans.

- For a known file and line range, use `tools.read` directly inside codemode.
- For filenames, exact text, and symbol/impact lookups, prefer `tools.code_explore({action, query, scope?, language?, maxResults?})` inside codemode. It routes requests to ripgrep or Cymbal depending on task and repository size/health.
- For AST-aware structural matching, prefer the installed Pi-native `tools.ast_grep_search` if available. Discover its arguments with `describeTool("ast_grep_search")`. Otherwise use `tools.code_explore({action:"ast", query:pattern, language, scope})` if the `sg` or `ast-grep` executable is installed.
- Never run Cymbal directly through `tools.bash` as an alternate way around `code_explore` safety checks. In particular, skip Cymbal in `edx-platform` or where the extension reports it ineligible.
- Scope searches to the smallest likely subtree. Use bounded output and return concise, cited file:line locations. Treat ripgrep/AST fallback references as candidates, not a complete type-resolved call graph.
- Use `tools.bash` via codemode for shell tasks where specialized tools are not available. Do not make edits just to answer read-only code questions.

Example codemode script:

```js
const res = await tools.code_explore({
  action: "references",
  query: "publish_event",
  scope: "openedx/core",
  language: "python",
  maxResults: 25,
});
text({backend: res.backend, truncated: res.truncated, warning: res.warning,
      matches: res.output.split("\n").slice(0, 25).join("\n")});
```
