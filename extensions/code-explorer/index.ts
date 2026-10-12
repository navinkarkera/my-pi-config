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
      description: 'Scoped repository maps via ast-grep; bounded text/file search via rg; Cymbal relationships only if repo size and health allow it.',
      instructions: 'Call tools.code_explore({...}) from codemode. Use action=map with an explicit scope for a bounded, syntax-only symbol overview; no query required. It refuses more than 60 source files by default, limits output to ~1024 tokens, and never indexes the whole repo. For AST searches, use Pi native ast_grep_search if available. Prefer narrow paths and filter structured outputs before text(). Never bypass Cymbal limits through bash.',
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Bounded code navigation: action=map generates a small directory/file symbol map using ast-grep outline (no index); files/text use ripgrep; symbols/references/impact use Cymbal only on small, healthy repos. Outputs are bounded; edx-platform never runs Cymbal.',
    promptSnippet: 'Use code_explore via codemode; map action gives a bounded, syntax-only file/directory overview, no indexing. Native ast_grep_search handles patterns.',
    promptGuidelines: [
      'Inside codemode, use tools.code_explore({action:"map",scope:"narrow/subtree"}) for a lightweight bounded structural map. Prefer read for known files/line ranges.',
      'Use action=files for names, text for literals, map for directory/file outlines, and symbol/references/impact for relationships. Use native ast_grep_search for structural patterns when available. Never call Cymbal directly on large repositories.',
      'Map uses ast-grep outline and refuses overly large directory scans; provide a narrower scope instead. Syntax-only results and text matches are not type-resolved call graphs.',
    ],
    outputSchema: Type.Object({
      backend: StringEnum(['rg', 'ast-grep', 'cymbal', 'none'] as const),
      repo: Type.String(),
      output: Type.String(),
      warning: Type.Optional(Type.String()),
      truncated: Type.Boolean(),
      fileCount: Type.Optional(Type.Integer()),
      tokensApprox: Type.Optional(Type.Integer()),
      mappedFiles: Type.Optional(Type.Integer()),
      symbolCount: Type.Optional(Type.Integer()),
    }),
    parameters: Type.Object({
      action: StringEnum(['files', 'text', 'ast', 'symbol', 'references', 'impact', 'map'] as const, {
        description: 'map=bounded ast-grep outline of scope; files=filename search; text=literal; ast=structural pattern; symbol/references/impact=Cymbal if safe, otherwise bounded search',
      }),
      query: Type.Optional(Type.String({ description: 'Text/symbol/filename/pattern; optional for action=map, where it filters outline symbols' })),
      scope: Type.Optional(Type.String({ description: 'Relative file/directory within repo, default current directory; use a narrow scope where possible' })),
      language: Type.Optional(Type.String({ description: 'Language for ast-grep (required for ast): python, typescript, javascript, tsx, etc. Also narrows rg results for supported languages.' })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 80, description: 'Limit result lines (default 40)' })),
      maxTokens: Type.Optional(Type.Integer({ minimum: 128, maximum: 4096, description: 'For map only: approximate output token budget (default 1024)' })),
      maxFiles: Type.Optional(Type.Integer({ minimum: 1, maximum: 120, description: 'For map only: maximum source files scanned (default 60); larger scopes are refused' })),
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
        ...(answer.tokensApprox !== undefined ? { tokensApprox: answer.tokensApprox } : {}),
        ...(answer.mappedFiles !== undefined ? { mappedFiles: answer.mappedFiles } : {}),
        ...(answer.symbolCount !== undefined ? { symbolCount: answer.symbolCount } : {}),
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
