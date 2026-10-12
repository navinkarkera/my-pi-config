import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import { Explorer, repositoryRoot } from './core.ts';

/**
 * Auto-discovered from ~/.pi/agent/extensions/code-explorer/index.ts.
 * Searches are argv-based (never a shell) and bounded by timeout/output size.
 */
export default function codeExplorer(pi: ExtensionAPI) {
  const explorer = new Explorer();

  pi.registerTool({
    name: 'code_explore',
    label: 'Code Explore',
    exposure: 'codemode',
    namespace: {
      name: 'code-explorer',
      description: 'Bounded, read-only code navigation. Uses ripgrep for text/files and Cymbal for symbol relationships only if repo size and health allow it.',
      instructions: 'Call tools.code_explore({...}) from codemode. It returns structured {backend, repo, output, warning?, truncated, fileCount?}. For AST queries use the already-installed Pi ast_grep_search tool directly when available; code_explore action=ast is a CLI fallback. Filter outputs in the codemode script before text(). Never bypass the Cymbal size/timeout safeguards with tools.bash.',
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Bounded code navigation: find files and text with ripgrep; AST matches with ast-grep; symbols, references and impact with Cymbal only on small, healthy repositories. Automatically falls back on huge repos such as edx-platform, and caches repository size and Cymbal failures. No writes or indexing initiated explicitly.',
    promptSnippet: 'Use code_explore inside codemode for bounded rg/Cymbal exploration; call an available native ast_grep_search tool for AST queries.',
    promptGuidelines: [
      'Inside codemode, prefer tools.code_explore for exploratory text/file/symbol/impact searches. Use tools.read for known file ranges.',
      'Use code_explore action=files for names, text for literals, and symbol/references/impact for relationships. Prefer the Pi ast_grep_search tool for structural queries if available; otherwise code_explore action=ast works with an installed CLI. Never call Cymbal directly on large repositories.',
      'References and impact results from rg/ast-grep are candidates, not a type-resolved call graph.',
    ],
    outputSchema: Type.Object({
      backend: StringEnum(['rg', 'ast-grep', 'cymbal', 'none'] as const),
      repo: Type.String(),
      output: Type.String(),
      warning: Type.Optional(Type.String()),
      truncated: Type.Boolean(),
      fileCount: Type.Optional(Type.Integer()),
    }),
    parameters: Type.Object({
      action: StringEnum(['files', 'text', 'ast', 'symbol', 'references', 'impact'] as const, {
        description: 'files=filename search; text=literal search; ast=structural pattern; symbol/references/impact=try Cymbal if safe, otherwise bounded search',
      }),
      query: Type.String({ description: 'Literal text, symbol name, filename fragment, or ast-grep pattern' }),
      scope: Type.Optional(Type.String({ description: 'Relative file/directory within repo, default current directory; use a narrow scope where possible' })),
      language: Type.Optional(Type.String({ description: 'Language for ast-grep (required for ast): python, typescript, javascript, tsx, etc. Also narrows rg results for supported languages.' })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 80, description: 'Limit result lines (default 40)' })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const answer = await explorer.explore(params, ctx.cwd, signal);
      const preamble = `Backend: ${answer.backend}\nRepository: ${answer.repo}${answer.fileCount !== undefined ? `\nSource files scanned (capped): ${answer.fileCount}` : ''}`;
      const warning = answer.warning ? `\nNote: ${answer.warning}` : '';
      const structuredContent = {
        backend: answer.backend,
        repo: answer.repo,
        output: answer.output,
        ...(answer.warning ? { warning: answer.warning } : {}),
        truncated: Boolean(answer.truncated),
        ...(answer.fileCount !== undefined ? { fileCount: answer.fileCount } : {}),
      };
      const trunc = answer.truncated ? '\n[Output truncated; narrow scope or query]' : '';
      return {
        content: [{ type: 'text', text: `${preamble}${warning}\n\n${answer.output}${trunc}` }],
        structuredContent,
        details: { backend: answer.backend, truncated: !!answer.truncated, repo: answer.repo, warning: answer.warning },
      };
    },
  });

  pi.registerCommand('code-tools', {
    description: 'Inspect/reset code explorer repository cache: /code-tools status | reset',
    handler: async (argumentsText, ctx) => {
      const root = repositoryRoot(ctx.cwd);
      const arg = argumentsText.trim();
      if (arg === 'reset') {
        explorer.reset(root);
        ctx.ui.notify('Code explorer cache cleared for this repository.', 'success');
      } else if (!arg || arg === 'status') {
        const s = await explorer.state(root);
        ctx.ui.notify(`Cymbal ${s.allowed ? 'eligible' : 'disabled'}: ${s.reason}${s.count === undefined ? '' : ` (${s.count} source files, capped)`}`, s.allowed ? 'info' : 'warning');
      } else ctx.ui.notify('Usage: /code-tools [status|reset]', 'warning');
    },
  });

  // Guard obvious direct Cymbal bash invocations when the repo is known to be
  // too large/unhealthy. This is a usability guard, NOT a shell security parser.
  // The normal path is the code_explore tool above.
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const cmd = (event.input as { command?: unknown })?.command;
    if (typeof cmd !== 'string') return;
    if (!/(?:^|\n|;|&&|\|\|)\s*(?:timeout\s+\d+(?:s|m)?\s+)?cymbal(?:\s|$)/m.test(cmd)) return;
    const state = await explorer.state(repositoryRoot(ctx.cwd));
    if (!state.allowed) return {
      block: true,
      reason: `Cymbal disabled in this repository (${state.reason}). Use code_explore, rg, or ast-grep. To reconsider the cache, run /code-tools reset.`,
    };
  });
}
