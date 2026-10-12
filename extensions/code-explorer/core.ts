import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export type Action = 'files' | 'text' | 'ast' | 'symbol' | 'references' | 'impact';
export interface Request { action: Action; query: string; scope?: string; language?: string; maxResults?: number }
export interface Answer {
  backend: 'rg' | 'ast-grep' | 'cymbal' | 'none';
  repo: string; command?: string; output: string;
  warning?: string; truncated?: boolean; fileCount?: number;
}

const SOURCE_GLOB = '*.{py,pyi,go,rs,js,jsx,ts,tsx,java,c,cc,cpp,h,hpp,cs,rb,php,kt,kts,swift,lua,scala,ex,exs}';
const LANG_GLOBS: Record<string, string> = {
  python: '*.py', javascript: '*.{js,jsx}', typescript: '*.{ts,tsx}',
  jsx: '*.jsx', tsx: '*.tsx', go: '*.go', rust: '*.rs', java: '*.java',
};
const KNOWN_LARGE = new Set(['edx-platform']);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SIZE_TIMEOUT_MS = 6_000;
const SEARCH_TIMEOUT_MS = 10_000;
const CYMBAL_TIMEOUT_MS = 15_000;
export const MAX_FILES = 2000;

interface Entry { count?: number; countedAt?: number; disabledUntil?: number; reason?: string }
interface DiskCache { version: 1; repos: Record<string, Entry> }
export interface State { allowed: boolean; reason: string; count?: number }

function cachePath(): string {
  return process.env.PI_CODE_EXPLORER_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pi-code-explorer', 'state.json');
}
function key(root: string): string { return createHash('sha256').update(root).digest('hex'); }
function getDisk(): DiskCache {
  try { const parsed = JSON.parse(readFileSync(cachePath(), 'utf8'));
    if (parsed?.version === 1 && typeof parsed.repos === 'object') return parsed;
  } catch { /* cache is optional */ }
  return { version: 1, repos: {} };
}
function saveDisk(data: DiskCache): void {
  try {
    const file = cachePath(); mkdirSync(resolve(file, '..'), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temp, file);
  } catch { /* filesystem caching is best-effort */ }
}

export function repositoryRoot(cwd: string): string {
  try { return realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
  catch { return realpathSync(cwd); }
}
export function scopedPath(cwd: string, root: string, supplied?: string): string {
  const candidate = resolve(cwd, supplied?.replace(/^@/, '') || '.');
  if (!existsSync(candidate)) throw new Error(`Scope not found: ${candidate}`);
  const actual = realpathSync(candidate);
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Scope must remain inside the current repository.');
  if (!statSync(actual).isDirectory() && !statSync(actual).isFile()) throw new Error('Scope must be a file or directory.');
  return actual;
}

interface RunResult { stdout: string; stderr: string; code: number | null; timedOut: boolean; truncated: boolean; missing: boolean; cancelled: boolean; lines: number }
/** No shell: user-supplied queries are never interpreted as commands. */
export async function run(cmd: string, args: string[], cwd: string, options: {
  timeoutMs?: number; maxBytes?: number; maxLines?: number; countOnly?: boolean; stopAfter?: number; signal?: AbortSignal;
} = {}): Promise<RunResult> {
  const { timeoutMs = SEARCH_TIMEOUT_MS, maxBytes = 18_000, maxLines = 80, countOnly = false, stopAfter = Number.MAX_SAFE_INTEGER, signal } = options;
  return new Promise((done) => {
    let stdout = '', stderr = '', lines = 0, bytes = 0, timedOut = false, truncated = false, missing = false, cancelled = false, ended = false;
    let tail = '';
    if (signal?.aborted) { done({stdout,stderr,code:null,timedOut,truncated,missing,cancelled:true,lines}); return; }
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const stop = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const abort = () => { cancelled = true; stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (buf: Buffer) => {
      if (countOnly) {
        const piece = tail + buf.toString('utf8');
        const parts = piece.split('\n'); tail = parts.pop() ?? '';
        lines += parts.length;
        if (lines > stopAfter) { truncated = true; stop(); }
      } else {
        if (truncated) return;
        const piece = buf.toString('utf8');
        const nextBytes = bytes + Buffer.byteLength(piece);
        const nextLines = lines + (piece.match(/\n/g)?.length || 0);
        if (nextBytes > maxBytes || nextLines >= maxLines) {
          const room = Math.max(0, maxBytes - bytes);
          stdout += Buffer.from(piece).subarray(0, room).toString('utf8');
          truncated = true;
          stop();
        } else { stdout += piece; bytes = nextBytes; lines = nextLines; }
      }
    });
    child.stderr.on('data', (buf: Buffer) => { if (stderr.length < 2500) stderr += buf.toString('utf8').slice(0, 2500 - stderr.length); });
    child.on('error', (err: NodeJS.ErrnoException) => { missing = err.code === 'ENOENT'; stderr = err.message; });
    child.on('close', code => {
      if (ended) return; ended = true;
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (countOnly && tail) lines++;
      done({ stdout, stderr, code, timedOut, truncated, missing, cancelled, lines });
    });
  });
}
function hasIndexFailure(x: RunResult): boolean {
  return x.timedOut || x.missing || /(?:failed to (?:refresh|build|scan|open)|(?:error|failed|unable).*?(?:index|database|sqlite)|(?:index|database|sqlite).*?(?:error|failed|corrupt|locked)|migration|panic)/i.test(x.stderr);
}
function formatRun(x: RunResult): string {
  if (x.cancelled) return 'Cancelled.';
  if (x.missing) return `Tool missing: ${x.stderr}`;
  if (x.timedOut) return 'Search timed out.';
  return x.stdout.trim() || (x.code === 1 ? 'No matches.' : x.stderr.trim() || '(No output)');
}
function trimOutput(value: string, limit: number): string {
  const lines = value.split('\n');
  return lines.length > limit ? lines.slice(0, limit).join('\n') + `\n[Output limited to ${limit} lines]` : value;
}

export class Explorer {
  private cache = getDisk();
  private astBin: string | null | undefined;
  private eligibilityPromises = new Map<string, Promise<State>>();
  private maxFiles: number;
  constructor(maxFiles = MAX_FILES) { this.maxFiles = maxFiles; }
  private entry(root: string): Entry { return this.cache.repos[key(root)] ||= {}; }
  private persist(): void { saveDisk(this.cache); }
  async state(root: string, signal?: AbortSignal): Promise<State> {
    if (KNOWN_LARGE.has(basename(root).toLowerCase())) return { allowed: false, reason: 'known large/problematic repo (edx-platform)' };
    // Pull in changes made by other Pi sessions/workers.
    this.cache = getDisk();
    const now = Date.now(); const item = this.entry(root);
    if ((item.disabledUntil ?? 0) > now) return { allowed: false, reason: `Cymbal cooling down: ${item.reason ?? 'previous failure'}`, count: item.count };
    if ((item.countedAt ?? 0) + CACHE_TTL_MS > now && item.count !== undefined)
      return { allowed: item.count <= this.maxFiles, reason: item.count > this.maxFiles ? `source count exceeds ${this.maxFiles}` : 'within source-file limit', count: item.count };
    // Deduplicate simultaneous calls within the same extension instance.
    if (!this.eligibilityPromises.has(root)) {
      this.eligibilityPromises.set(root, (async () => {
        const result = await run('rg', ['--files', '-g', SOURCE_GLOB, '.'], root, { countOnly: true, stopAfter: this.maxFiles, timeoutMs: SIZE_TIMEOUT_MS, signal });
        if (result.timedOut || result.missing || result.cancelled || (result.code !== 0 && !result.truncated)) {
          return { allowed: false, reason: 'could not safely determine repository size' };
        }
        this.cache = getDisk(); // Merge before writing; another worker may have updated another repo.
        const current = this.entry(root);
        current.count = result.lines;
        current.countedAt = Date.now(); this.persist();
        return { allowed: result.lines <= this.maxFiles, reason: result.lines > this.maxFiles ? `source count exceeds ${this.maxFiles}` : 'within source-file limit', count: result.lines };
      })().finally(() => this.eligibilityPromises.delete(root)));
    }
    return this.eligibilityPromises.get(root)!;
  }
  disable(root: string, reason: string): void {
    this.cache = getDisk(); const item = this.entry(root); item.disabledUntil = Date.now() + COOLDOWN_MS; item.reason = reason; this.persist();
  }
  reset(root: string): void { this.cache = getDisk(); delete this.cache.repos[key(root)]; this.persist(); }
  private async astCommand(cwd: string, signal?: AbortSignal): Promise<string | null> {
    if (this.astBin !== undefined) return this.astBin;
    for (const cmd of ['ast-grep', 'sg']) {
      const version = await run(cmd, ['--version'], cwd, { timeoutMs: 1200, signal });
      if (!version.timedOut && version.code === 0 && /ast-grep/i.test(version.stdout + version.stderr)) return (this.astBin = cmd);
    }
    return (this.astBin = null);
  }
  private async searchRg(action: 'files'|'text'|'symbol'|'references'|'impact', query: string, root: string, scope: string, lang: string | undefined, max: number, signal?: AbortSignal): Promise<Answer> {
    const args = action === 'files' ? ['--files'] : ['-n', '-F', '--max-columns', '240', '--max-columns-preview'];
    if (lang && LANG_GLOBS[lang]) args.push('-g', LANG_GLOBS[lang]);
    // Keep files filtering literal and in-process, instead of passing an unsafe glob.
    if (action !== 'files') args.push('--', query);
    args.push(scope);
    const out = await run('rg', args, root, { signal, maxLines: action === 'files' ? 3000 : max + 1, maxBytes: 30_000 });
    let output = formatRun(out);
    let truncated = out.truncated;
    if (action === 'files' && !out.missing && !out.timedOut && !out.cancelled) {
      const hits = out.stdout.split('\n').filter(p => p && p.toLowerCase().includes(query.toLowerCase()));
      truncated ||= hits.length > max;
      output = hits.slice(0, max).join('\n') || 'No matching file names.';
    } else if (!out.missing && !out.timedOut && !out.cancelled) {
      output = trimOutput(output, max);
      truncated ||= output.includes('[Output limited');
    }
    return { backend: out.missing ? 'none' : 'rg', repo: root, output, truncated,
      warning: ['references', 'impact'].includes(action) ? 'Text matches are candidate references, not a complete resolved call/impact graph.' : undefined };
  }
  private async searchAst(query: string, root: string, scope: string, lang: string | undefined, max: number, signal?: AbortSignal): Promise<Answer> {
    if (!lang) return { backend:'none', repo:root, output: 'AST search requires language, e.g. python or typescript.' };
    const exe = await this.astCommand(root, signal);
    if (!exe) return { backend:'none', repo:root, output: 'ast-grep is not installed (or `sg` refers to a different utility).' };
    const r = await run(exe, ['run', '--pattern', query, '--lang', lang, scope], root, {signal,maxLines:max + 1,maxBytes:30_000});
    return {backend:'ast-grep',repo:root,output:trimOutput(formatRun(r),max),truncated:r.truncated};
  }
  private async rgWithAstCandidates(action: 'references'|'impact', query: string, root: string, scope: string, lang: string | undefined, max: number, signal?: AbortSignal): Promise<Answer> {
    const hits = await this.searchRg(action, query, root, scope, lang, max, signal);
    if (signal?.aborted || !lang || !/^[A-Za-z_$][\w$]*$/.test(query)) return hits;
    const ast = await this.searchAst(`${query}($$$ARGS)`, root, scope, lang, Math.min(12,max), signal);
    if (ast.backend === 'ast-grep') {
      hits.backend = 'rg'; // primary backend, second method is recorded in output
      hits.output += `\n\nAST call-site candidates (${lang}):\n${ast.output}`;
      hits.truncated ||= ast.truncated;
    }
    return hits;
  }
  async explore(req: Request, cwd: string, signal?: AbortSignal): Promise<Answer> {
    const root = repositoryRoot(cwd);
    let scope: string;
    try { scope = scopedPath(cwd, root, req.scope); } catch (e) { return { backend:'none',repo:root,output:String(e) }; }
    const query = req.query.trim();
    if (!query || query.length > 500) return { backend:'none',repo:root,output:'Provide a query of 1–500 characters.' };
    const max = Math.max(1, Math.min(80, req.maxResults ?? 40));
    const lang = req.language?.toLowerCase();
    if (req.action === 'files' || req.action === 'text') return this.searchRg(req.action,query,root,scope,lang,max,signal);
    if (req.action === 'ast') return this.searchAst(query,root,scope,lang,max,signal);
    const eligibility = await this.state(root, signal);
    if (eligibility.allowed && !signal?.aborted) {
      const args = req.action === 'symbol' ? ['search',query,'--limit',String(max)]
        : req.action === 'references' ? ['refs',query]
        : ['impact',query,'--depth','1'];
      const result = await run('cymbal',args,root,{signal,timeoutMs:CYMBAL_TIMEOUT_MS,maxLines:max * 3,maxBytes:25_000});
      if (result.code === 0 && !result.timedOut && !result.missing && !result.cancelled)
        return {backend:'cymbal',repo:root,output:formatRun(result),truncated:result.truncated,fileCount:eligibility.count};
      if (result.cancelled) return {backend:'none',repo:root,output:'Cancelled.'};
      if (hasIndexFailure(result)) this.disable(root, result.timedOut ? 'Cymbal query timed out' : (result.stderr.trim() || 'Cymbal indexing failed'));
      // A miss or normal query error is not a repository-health failure.
    }
    const fallback = req.action === 'symbol'
      ? await this.searchRg('symbol',query,root,scope,lang,max,signal)
      : await this.rgWithAstCandidates(req.action,query,root,scope,lang,max,signal);
    const why = eligibility.allowed ? 'Cymbal query was unavailable or did not return a result' : `Cymbal skipped: ${eligibility.reason}`;
    fallback.warning = [why,fallback.warning].filter(Boolean).join(' | ');
    fallback.fileCount = eligibility.count;
    return fallback;
  }
}
