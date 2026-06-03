# Mind-Worker Extension Design

**Session 1 status:** 36 questions answered (gather/implement/review workflow). Continue from Q36.
**Session 2 status:** Reset/startup/session decisions resolved. See `mind-worker-reset-design.md` for launcher-path source of truth.

> **⚠️ NOTE:** This doc covers the initial gather/implement/review workflow exploration (session 1 raw notes). The delegate interface, workflow model, and tool schema were consolidated and superseded by `mind-worker-architecture.md` (the authoritative session 1 design doc). The launcher-based startup/reset model (session 2) is documented in `mind-worker-reset-design.md`. Where this doc describes startup/role-transition mechanics (e.g., `/be-mind` auto-spawn), those sections are superseded by the launcher path but kept for backward-compatibility reference.

## Core Architecture

- **Mind model** = active pi session model (planner, decision maker, orchestrator)
- **Worker model** = fixed config (cheaper model for implementation)
- **Reviewer model** = runs mind's model in subprocess (same as mind, offloaded for context isolation)
- **Invocation**: worker/reviewer runs as subprocess pi (like subagent), not inline `complete()` call or in-session model switch
- **Mode toggle**: user enables `/mind` = toggle on/off. First use triggers `/mind configure`

## Workflow (per user prompt)

1. **Auto-gather** (before mind thinks): extension spawns gather worker with user prompt. Worker explores codebase. Outputs structured findings.
2. **Mind receives context** → plans → writes numbered plan to temp file.
3. **Mind calls implement** → delegates to worker subprocess with plan file + context file.
4. **Worker implements** → full tools (read, write, edit, bash, grep, find, ls).
5. **Mind calls reviewer** → reviewer subprocess runs, uses `git diff`, checks against context.
6. **User checkpoint**: mind shows reviewer verdict. Extension dialog: Approve / Reject / Request fixes.
7. **On approval** → extension auto-commits (`git add -A && git commit -m "..."`), generated commit message if user confirms.

## Tool Interface

Single generic tool:
```
delegate(
  phase: "gather" | "implement" | "review",
  task: string,              // core instruction
  files?: string[],          // target files
  contextFile: string,       // required for "implement" — path to gather output JSON
  planFile: string,          // required for "implement" — path to mind's numbered plan
  reviewCriteria?: string[]  // optional for "review"
)
```

## Error Handling

- **Timeout**: user decides — present timeout to user, let them decide retry/increase timeout/abort
- **Worker error**: pass error text to mind, let mind decide retry
- **Reviewer failure**: mind iterates — fix findings, call implement again
- **Auto-retry limit**: severity-based — LOW auto-fix once then show user, HIGH/CRITICAL stop immediately

## Data Flow

| Phase | Worker Output | How Mind Consumes |
|-------|--------------|-------------------|
| Gather | JSON file (`files`, `keyFunctions`, `dependencies`, `snippets`, `content`) | Extension transforms JSON → markdown text in tool result + injects as persistent message |
| Implement | Write `planFile` + `contextFile` → worker receives task from those files | Mind writes plan to temp file. Worker produces code changes. |
| Review | Structured verdict (Verdict: PASS/FAIL/NEEDS_FIX, Issues, Summary) | Extension shows verdict to user. User decides next action. |

## Temp File Lifecycle

- Context files kept until next phase (gather context persists until implement starts, plan persists until implement finishes)
- All files in session-shared temp dir
- Cleaned on session shutdown or extension restart

## System Prompt Injection

Extension intercepts `before_agent_start` when mind-worker mode is active. Injects explicit workflow protocol:

> "When given a complex task, follow this workflow: 1) Gather context via delegate(phase:'gather') 2) Plan: write numbered plan to file 3) Implement via delegate(phase:'implement') 4) Review via delegate(phase:'review') 5) Ask user for approval"

Injected as system prompt modification (not persistent message).

## Session Resume

Track workflow phase + temp file paths via `pi.appendEntry()`. On resume, remind mind where it left off.

## Feedback & Visibility

- Status indicator (`ctx.ui.setStatus`) shows phase info, footer reflects current phase
- Kitty terminals optional for visibility toggle
- Toggle applies to all phases (gather, implement, review)
- One persistent Kitty window reused across invocations (not a new window per call)

## Phase Feedback

- Gather: status in footer only ("🔍 Gathering context...")
- Implement + Review: status + optional Kitty window

## Configuration (command-based)

Stored in `~/.pi/agent/mind-worker.json` (global, not project-local):
- `workerModel`: string (model id)
- `timeout`: number (seconds, default e.g. 120)
- `visibility`: boolean (show subprocess in Kitty window)

## Concrete Scenario

User: "Add rate limiting to the API endpoints in src/server.ts"

1. Extension intercepts → auto-spawns gather worker → explores src/server.ts, finds existing patterns, dependencies
2. Gather worker writes JSON context file with findings
3. Extension transforms JSON → markdown, injects as message + context file path
4. Mind reads context → writes numbered plan to `/tmp/mind-plan.md`
5. Mind calls `delegate(phase:"implement", planFile, contextFile, task)`
6. Worker reads plan, implements changes, exits
7. Mind calls `delegate(phase:"review", files:["src/server.ts"])`
8. Reviewer runs `git diff`, checks against context criteria, outputs verdict
9. Mind presents verdict to user. Extension shows dialog: Approve / Reject / Request fixes
10. User approves → extension offers to commit with auto-generated message

## Decisions Made (for quick reference)

| # | Question | Answer |
|---|----------|--------|
| 1 | Architecture | A: Mind = main model, Worker = subprocess tool |
| 2 | Model selection | A: Mind = active pi model, Worker = fixed config |
| 3 | Invocation mechanism | A: Subprocess (like subagent) |
| 4 | Worker tools | A: Full tools |
| 5 | Workflow loop | C: Iterative with user checkpoints + reviewer subprocess |
| 6 | Reviewer model | D: Same as mind, offloaded for context isolation |
| 7 | Concrete scenario | Walked through |
| 8 | Data flow | 1B (file), 2B (file), 3B (git diff), 4A (structured review to user) |
| 9 | Kitty visibility | C: Optional, toggle-able |
| 10 | Tool interface | A: Single generic `delegate` tool with phase param |
| 11a | Timeout handling | 3: Tell user, let them decide |
| 11b | Error handling | 1: Pass error to mind, let mind decide |
| 11c | Negative review | 1: Mind iterates with corrections |
| 12 | Configuration | C: Command-based `/mind configure` |
| 13 | Temp file lifecycle | C: Kept until next phase, cleaned on session end |
| 14 | Tool schema fields | C: Full explicit — all fields |
| 15 | Plan format | B: Structured markdown with numbered steps |
| 16 | Kitty integration | C: Named pipe / streaming, pi subprocess visible |
| 17 | Registration | B: Mode toggle intercepting agent_start |
| 18 | System prompt injection | B: Explicit workflow protocol |
| 19 | Worker model config | B: AppendEntry + config file |
| 20 | Context extraction | C: JSON for parsing + text for mind |
| 21 | `--mode json -p` agreed | Yes |
| 22a | Schema detail | contextFile required for implement, planFile optional (then B: required) |
| 22b | Reviewer input | A: diff internally + B: specific reviewCriteria from mind |
| 23 | Session resume | B: Track workflow phase + temp file paths |
| 24 | Gather timing | B: Auto-gather before mind thinks |
| 25 | Gather feedback | B: Status indicator, fully headless |
| 26 | Gather visibility toggle | B: Gather never gets Kitty window (even if visibility on) |
| 27 | Kitty re-use | B: One persistent window across invocations |
| 28 | Concurrency | B: Parallel gather only (not implement) |
| 29 | Context file format | C: JSON metadata (structured) |
| 30 | Context → mind consumption | D: Both summary text + full context as persistent message |
| 31 | Config storage | A: Global `~/.pi/agent/mind-worker.json` |
| 32 | Reviewer format | B: Structured sections (Verdict, Issues, Summary) |
| 33 | User checkpoint | C: Mind drives interaction naturally |
| 34 | Auto-commit | B: Extension asks, commits on approval |
| 35 | Auto-retry limit | C: Severity-based (LOW auto-fix, HIGH stop) |
| 36 | "Request fixes" | A: User types, goes to mind as regular prompt |
| 37 | Mode toggle UX | A: Simple `/mind` toggle, config on first use |
| 38 | Worker turns | C: Single-turn (one assistant response), retry if needed |
| 39 | Gather parallelism | PENDING — continue from here |

## Unresolved Questions

- **Q36**: Gather parallelism — how to merge multiple parallel gather context files?
- Implementation details: file naming convention for temp files, exact JSON schema for gather output, exact JSON schema for plan file, how event bus emits phase updates, how Kitty named pipe streaming works, how reviewer generates structured verdict
