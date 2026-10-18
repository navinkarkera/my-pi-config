## Response style

Answer simple points directly instead of writing paragraphs. Keep language simple and concise.

## AI notes

Durable project notes live in `~/work/ai-notes/<current_dir_name>/` (`<current_dir_name>` = current working directory name). Notes already in that folder are valid context.

**Read before writing**
- Search whenever prior project context may help, and always before writing a requested Markdown document. Update existing notes instead of duplicating them.
- qmd — conceptual/semantic discovery and full-source retrieval:
  `qmd query $'intent: ...\nlex: ...\nvec: ...' -c ai-notes`, then `qmd get <path|#docid>`.
  Keyword-only: `qmd search "<terms>" -c ai-notes`.
- zk — exact titles/terms, metadata and the link graph; always pin the notebook, never rely on `ZK_NOTEBOOK_DIR` (it selects personal notes):
  `zk --notebook-dir ~/work/ai-notes list --match '<terms>'` (add `--match-strategy exact` for exact terms, `--linked-by <id>` for the link graph).

**Write**
- Requested Markdown documents go into the project folder, created if missing, then commit and push.

**Re-index**
- After adding or editing notes: `qmd update` (incremental). Run `qmd embed` only when `qmd status` reports missing vectors.

## Codemode is the default

Prefer codemode as the interface for tools. Call a tool directly only when codemode cannot perform the operation or would add needless overhead.

- One coherent script per task: gather evidence, act, verify, return a short summary. Don't chain separate calls just to pass intermediate output through the model.
- Use `Promise.allSettled()` for independent calls; sequence dependent calls and stop on error.
- Check results, errors and exit codes; never claim success without verification.
- Keep `text()` output small and relevant — select fields in the script instead of returning raw tool results.
- Git: stage only explicitly relevant paths and inspect the resulting diff or commit.

## Code Explorer

Prefer the least expensive tool that answers the question. Keep searches scoped, bounded and read-only; never index a large repository to answer a narrow question.

1. **Known file or line range** → `tools.read`, only the relevant span. No map needed.
2. **Unfamiliar module or directory** → `code_explore` with `action:"map"` first, on a narrow `scope`: a syntax-level overview of symbols, signatures and locations with no persistent index. Find a likely subtree; never map a large repo root.
3. **Then pick the action that matches the question**, passing `query` (and `scope` to narrow):
   - `files` — filenames; `text` — literal strings.
   - `ast` — structural/syntactic patterns; `language` is required.
   - `symbol` — symbol lookup; `references` — usages; `impact` — change surface.
4. **Relationships:** `symbol`, `references` and `impact` may use Cymbal only when the repository is eligible (small and healthy), and fall back to a bounded text search otherwise. Never call or bypass Cymbal directly.

`map` and `ast` are ast-grep (syntax-level); `files` and `text` are ripgrep.

- Stay bounded: narrow the scope instead of raising safety limits (`maxFiles` caps file count at 60 by default; `maxTokens` limits output, not bytes scanned).
- A map, grep or AST match is not a complete call graph. Dynamic dispatch, aliases, reflection and imports may need verification.
- If a tool fails or is unavailable, fall back to a simpler scoped search instead of retrying indexing or installing tools.

### Map first

```js
const map = await tools.code_explore({
  action: "map",
  scope: "openedx/core/djangoapps/content_libraries",
});
text({ backend: map.backend, truncated: map.truncated, warning: map.warning, map: map.output });
```

### Fan out independent Code Explorer queries

```js
const calls = [
  ["symbol", { action: "symbol", query: "ContentLibrary", scope: "openedx/core/djangoapps/content_libraries" }],
  ["references", { action: "references", query: "ContentLibrary", scope: "openedx" }],
  ["text", { action: "text", query: "content_libraries", scope: "openedx/core/djangoapps" }],
];
const results = await Promise.allSettled(calls.map(([, args]) => tools.code_explore(args)));
results.forEach((r, i) => {
  const label = calls[i][0];
  text(r.status === "fulfilled"
    ? { label, backend: r.value.backend, truncated: r.value.truncated, warning: r.value.warning, output: r.value.output.slice(0, 400) }
    : { label, error: String(r.reason) });
});
```
