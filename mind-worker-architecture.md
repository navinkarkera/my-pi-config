# Mind-Worker Pi Extension — Complete Architecture

> Consolidated design from 38-question grilling session.
>
> **⚠️ LAUNCHER PATH NOTE:** The launcher-based startup/reset model (defined in `mind-worker-reset-design.md`) supersedes the legacy command-based role switching for new development. Sections marked **[LEGACY]** describe the deprecated manual path. New sections and callouts **(added)** describe launcher additions. When both paths are described, the launcher path takes precedence.

---

## 1. Core Concepts

| Concept | Definition |
|---------|------------|
| **Mind** | The planner instance. Uses a superior model. Has zero file tools. Only tool is `delegate`. |
| **Worker** | The executor instance. Uses a cheaper model. Has full Pi tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`). |
| **User** | Human operator who types into the Mind TUI. All intent flows through Mind. |
| **Unix Socket** | The sole wire between Mind and Worker. Deterministic path per working directory. |
| **Plan File** | Persistent markdown file written by Mind, read by Worker, survives session resume. |
| **Socket Protocol** | Line-delimited JSON. Streams live status from Worker; final structured result back to Mind. |

---

## 2. Commands

| Command | Where | Behavior |
|---------|-------|----------|
| `/be-mind` | Mind split | Activates mind role: overrides session file, injects `delegate` tool, removes file tools, starts socket listener. If `KITTY_LISTEN_ON` env is set, auto-spawns worker split via `kitty @ launch --cwd $(pwd) pi /be-worker`. |
| `/be-worker` | Worker split | Activates worker role: overrides session file, enters "locked" mode (ignores keyboard input), polls for mind socket, connects. |
| `/stop-mind` | Mind split | Reverts to normal Pi (restore file tools, close socket, keep session). Worker detects disconnect and prints `[Mind disconnected. Waiting...]`. |
| `/stop-worker` | Worker split | Reverts to normal Pi (restore keyboard input, close socket). Mind detects disconnect and can retry or inform user. |

> **⚠️ LEGACY PATH:** All commands in this table are deprecated by the launcher path (see `mind-worker-reset-design.md`). They work for backward compatibility but new development should use the launcher-based startup/reset model.

| `/mind-reset` | Mind split | Triggers launcher-mediated hard reset (launcher path only): orchestrator kills both instances, cleans all pair-scoped artifacts, re-spawns fresh pair for this cwd. See `mind-worker-reset-design.md §4`. |

---

## 3. Architecture

### 3.1. Instance Layout

```
┌─────────────────────┐     ┌─────────────────────┐
│   Kitty Split 1     │     │   Kitty Split 2     │
│   Mind Instance     │◄───►│   Worker Instance   │
│   (superior model)  │unix │   (cheaper model)   │
│   read-only         │sock │   full tools        │
│   plans & reviews   │     │   executes tasks    │
└─────────────────────┘     └─────────────────────┘
         ▲                            ▲
         │                            │
      User types                   User watches
      (all input)                  (monitor only)
```

> **⚠️ LAUNCHER PATH ADDITIONS:** On the launcher path, the mind pane uses a **supervisor wrapper** (see `mind-worker-reset-design.md §6`). Both panes get explicit kitty titles (`mind-{hash}`, `worker-{hash}`). Worker pane is **monitor-only** with hard input block and title `worker-{hash}`. The supervisor manages mind lifecycle during resets.

### 3.2. Autoconnect by Directory

- Socket path: `~/.pi/agent/mindworker/{hash-of-cwd}.sock`
- Hash = stable hash of absolute `cwd` string. **[LAUNCHER PATH]** CWD is canonicalized via `realpath` before hashing to eliminate symlink mismatches between panes. See `mind-worker-reset-design.md §3.1`.
- Only **one** mind-worker pair allowed per directory at a time.
- **Mind** creates socket and listens.
- **Worker** polls socket path every `500ms`, timeout `30s`. If not found: error "Run `/be-mind` first." **[LEGACY]** — launcher path worker does **not** poll; launcher waits for socket live + manifest generation match before spawning worker.
- Stale socket from crashed instance: worker probes; if dead, deletes and retries. If alive and role occupied: error. **[LEGACY]** — launcher path cleanup phase deletes all artifacts (including socket) before spawn, so stale socket is impossible.

> **⚠️ LAUNCHER PATH ADDITIONS:** The launcher path adds **generation fencing** — a monotonically increasing integer in a manifest JSON (`~/.pi/agent/mindworker/{hash}-manifest.json`). On connect, the worker validates it talks to the right generation. Stale workers from prior generations are rejected. See `mind-worker-reset-design.md §3`.

### 3.3. Session Files

Mind and Worker must not share a session file (Pi's `SessionManager` names from `cwd`).

- **[LEGACY MANUAL PATH]** Mind session as single `.jsonl`: `~/.pi/agent/sessions/mind-{cwd-hash}.jsonl`
- **[LEGACY MANUAL PATH]** Worker session as single `.jsonl`: `~/.pi/agent/sessions/worker-{cwd-hash}.jsonl`
- **[LEGACY MANUAL PATH]** Set by overriding `sessionManager` in the extension before `createAgentSession` initializes.

> **⚠️ LAUNCHER PATH ADDITIONS:** On the launcher path, session isolation is enforced via the `--session-dir` CLI flag, not extension-side session manager override. The launcher passes `--session-dir ~/.pi/agent/sessions/mind-{hash}` to mind and `--session-dir ~/.pi/agent/sessions/worker-{hash}` to worker. These are full Pi session directories (not just `.jsonl` files). See `mind-worker-reset-design.md §2.3`.

---

## 4. Tooling & Capabilities

### 4.1. Mind Tool Set

Exactly **one** custom tool:

```typescript
pi.registerTool({
  name: "delegate",
  label: "Delegate",
  description: "Delegate a task to the worker instance.",
  parameters: Type.Object({
    task: Type.String({ description: "The task to execute" }),
    step: Type.Optional(Type.Number({ description: "Step number in the plan" })),
    plan: Type.Optional(Type.String({ description: "Full plan markdown. Extension writes this to disk before sending." })),
    context: Type.Optional(Type.String({ description: "Running summary of prior steps' outcomes" })),
    // reset: REMOVED from public schema. Hard respawn (mind-worker-reset-design.md) supersedes this.
  }),
  // ...
})
```

**No** `read`, `write`, `edit`, `bash` tools for Mind. Enforced mechanically.

### 4.2. Worker Tool Set

Full default Pi tools:
- `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`

Plus any project/local extensions that would normally load.

### 4.3. Mind System Prompt

Injected on mind role start (`/be-mind` or `--mind-worker-role mind`):

> "You are a planner and orchestrator. You have one tool: `delegate`. Use it to explore the codebase, implement changes, run tests, and review results. Answer simple factual questions directly from your context. Never attempt to read or write files yourself. When delegating code changes, always write a numbered plan and review the worker's diff before approving."

### 4.4. Project Snapshot Injection

On mind role start (`/be-mind` or `--mind-worker-role mind`), the extension auto-injects a lightweight persistent message:

- `tree -L 2` of the project
- `git status` output
- Recent `git log --oneline -5`

This lets the Mind plan immediately without delegating an exploration task first.

---

## 5. Communication Protocol

Unix socket carries **line-delimited JSON** objects.

### 5.1. Mind → Worker

```json
{ "type": "task", "id": "uuid-v4", "task": "string", "step": 1, "plan": "# Plan\n1. ...", "context": "Prior outcomes..." }
{ "type": "abort", "id": "uuid-v4" }
{ "type": "ping" }
```

### 5.2. Worker → Mind

```json
{ "type": "status", "id": "uuid-v4", "phase": "thinking", "detail": "Analyzing src/server.ts" }
{ "type": "status", "id": "uuid-v4", "phase": "tool", "detail": "read: src/server.ts" }
{ "type": "status", "id": "uuid-v4", "phase": "bash", "detail": "npm test", "stdout": "..." }
{ "type": "result", "id": "uuid-v4", "explanation": "...", "diff": "git diff output", "filesChanged": [...], "bashResults": [{"cmd": "...", "exitCode": 0, "output": "..."}] }
{ "type": "error", "id": "uuid-v4", "code": "TIMEOUT|CRASH|BUSY|INCOMPLETE", "message": "..." }
{ "type": "pong" }
```

### 5.3. Protocol Rules

- Each message is one JSON object terminated by `\n`.
- `id` correlates a `task` with its stream of `status`/`result`/`error`.
- Worker may emit **multiple** `status` lines but **exactly one** terminating `result` or `error`.
- `abort`: worker cancels current tool/bash and returns `{code: "ABORTED"}`.
- `ping`/`pong`: health checks.

---

## 6. Workflow

### 6.1. Per-User-Prompt Flow

```
User types in Mind TUI
         │
         ▼
Mind model decides: answer directly or delegate?
         │
    ┌────┴────┐
    ▼         ▼
 Direct    delegate(task, step, plan, context)
 answer        │
    │          ▼
    │    Extension writes plan to disk
    │          │
    │          ▼
    │    Send JSON over unix socket
    │          │
    │          ▼
    │    Worker receives task, runs as normal Pi turn
    │    Streams status back to Mind
    │          │
    │          ▼
    │    Worker finishes → sends result
    │          │
    │          ▼
    │    Mind receives result
    │    Reviews diff against plan
    │          │
    │    ┌─────┴─────┐
    │    ▼           ▼
    │ Issues?     Pass
    │    │           │
    │    ▼           ▼
    │ delegate     Present to user
    │ (fix)            │
    │    │             ▼
    │    └──────────► Done
    │
    └────────────────► User sees answer
```

### 6.2. Multi-Step Tasks

Mind **never** sends a giant "do everything" task. It delegates **step-by-step**.

Example:
1. `delegate(step: 1, task: "Add rate limit middleware to src/server.ts", plan: "...")`
2. Review result diff. If pass:
3. `delegate(step: 2, task: "Update tests in tests/server.test.ts", plan: "...", context: "Step 1 added RedisRateLimiter...")`
4. Review. If pass:
5. `delegate(step: 3, task: "Run npm test and report failures", plan: "...", context: "...")`

Between steps, the Mind can present checkpoint status to the user.

### 6.3. Context Field

After each step, the Mind updates a running `context` string summarizing key decisions and outcomes. This is sent with every subsequent `delegate` call so the Worker remembers what happened even if its own session gets compacted.

---

## 7. Data Flow & Files

### 7.1. File Locations

| File | Path | Lifecycle |
|------|------|-----------|
| Unix socket | `~/.pi/agent/mindworker/{cwd-hash}.sock` | **[LEGACY]** Created on `/be-mind`, deleted on `/stop-mind` or crash. **[LAUNCHER PATH]** Created on launcher-driven role-flag boot (`--mind-worker-role mind`), deleted on cleanup phase of reset. See `mind-worker-reset-design.md §4.4`. |
| Plan file | `~/.pi/agent/mindworker/{cwd-hash}-plan.md` | Written by Mind extension on each `delegate(plan)`. Survives resume. Deleted on `/stop-mind` or new plan overwrite. **[LAUNCHER PATH]** Deleted on cleanup phase of reset. See `mind-worker-reset-design.md §4.4`. |
| Mind session (legacy) | `~/.pi/agent/sessions/mind-{cwd-hash}.jsonl` | LEGACY manual path. Launcher: `--session-dir` directory, delete entire dir on reset. |
| Worker session (legacy) | `~/.pi/agent/sessions/worker-{cwd-hash}.jsonl` | LEGACY manual path. Launcher: `--session-dir` directory, delete entire dir on reset. |
| Mind session dir (launcher) | `~/.pi/agent/sessions/mind-{cwd-hash}/` | Full Pi session directory passed via `--session-dir`. |
| Worker session dir (launcher) | `~/.pi/agent/sessions/worker-{cwd-hash}/` | Full Pi session directory passed via `--session-dir`. |
| Manifest (generation) | `~/.pi/agent/mindworker/{cwd-hash}-manifest.json` | Created by launcher, refreshed by mind/worker. Read on reset for pids, pane IDs, generation, session dirs. |
| Gather / temp outputs | `/tmp/mindworker-{cwd-hash}-*.json` | Ephemeral, cleaned on session end or extension restart. **[LAUNCHER PATH]** Also cleaned on reset cleanup phase. See `mind-worker-reset-design.md §4.4`. |

### 7.2. Worker Result Structure

The worker extension intercepts the normal assistant turn and formats:

```json
{
  "explanation": "Human-readable summary of what was done",
  "diff": "git diff --no-color output (or empty string)",
  "filesChanged": ["src/server.ts", "tests/server.test.ts"],
  "bashResults": [
    { "cmd": "npm test", "exitCode": 0, "output": "...", "truncated": false }
  ],
  "decisions": ["Used interface instead of type alias per ambiguity"]
}
```

This is what the Mind receives as the `delegate` tool result.

---

## 8. Error Handling & Edge Cases

| Scenario | Detection | Resolution |
|----------|-----------|------------|
| **Worker busy** | Mind sends task while Worker mid-task | Worker immediately replies `{type:"error", code:"BUSY"}`. Mind extension retries with exponential backoff. |
| **Worker crash / OOM** | Socket EOF or timeout | Mind extension catches it, runs `git diff` to assess partial work, returns error result to Mind. Mind decides: retry from scratch or ask user. |
| **Bash timeout** | Worker extension wraps bash with 120s timer | Sends SIGTERM, then SIGKILL. Returns `{code:"TIMEOUT", partialOutput:"..."}`. |
| **Worker asks clarifying question** | Extension detects incomplete turn (question markers in final assistant text) | Returns `{code:"INCOMPLETE", question:"..."}`. Mind can answer via follow-up delegate or escalate to user. |
| **Ctrl+C in Mind** | User aborts blocked `delegate` | Extension sends `abort` over socket. Worker cancels, returns `{code:"ABORTED"}`. Both instances stay alive. |
| **Ctrl+C in Worker** | User aborts worker mid-task | Worker cancels its turn, sends `{code:"ABORTED"}` back to Mind. |
| **Stale socket** | Worker probes dead socket on startup | Deletes stale file, retries connection. If mind truly absent, errors out. **[LEGACY]** — launcher path cleanup phase deletes all artifacts before spawn, so stale socket is impossible. See `mind-worker-reset-design.md §4.4`. |
| **Mind stopped mid-task** | Worker sees socket close | Prints `[Mind disconnected. Waiting...]` and re-enters poll/listen loop. **[LEGACY]** — launcher path: role-flag worker exits immediately on disconnect. See `mind-worker-reset-design.md §7`. |
| **Worker stopped mid-task** | Mind sees EOF waiting for result | Returns error to Mind. Mind informs user: "Worker disconnected. Restart with `/be-worker`." **[LEGACY]** — launcher path: use `/mind-reset` or kitty shortcut to trigger full reset. |
| **Session resume** | Pi restarted, `/be-mind` run again | Extension re-reads plan file from `~/.pi/agent/mindworker/`, re-injects snapshot, restores socket listener. Worker reconnects via `/be-worker`. **[LEGACY]** — launcher path boots fresh with `--session-dir`; no session restore. See `mind-worker-reset-design.md §5.2`. |

---

## 9. Configuration

Stored in `~/.pi/agent/mind-worker.json` (global, not project-local):

```json
{
  "mindModel": "anthropic/claude-opus-4-5",
  "workerModel": "anthropic/claude-sonnet-4",
  "timeout": 120,
  "statusStream": true,
  "autoSpawnWorker": true,  // DEPRECATED - launcher path always spawns both
  "resetTimeout": 5,
  "kittyEnabled": true
}
```

- `timeout`: bash command timeout in seconds.
- `statusStream`: whether to stream `status` messages back to Mind (default true).
- `autoSpawnWorker`: **[DEPRECATED]** whether `/be-mind` tries `kitty @ launch` (default true). Ignored on launcher path.
- `resetTimeout`: seconds to wait before SIGKILL during reset kill phase (default 5).
- `kittyEnabled`: false if user doesn't use kitty (v1 only).

If config missing on first `/be-mind`, extension creates it with defaults and notifies user.

---

## 10. Safety & Isolation Rules

1. **Mind is read-only during worker execution.** It has no file tools; the only way to touch disk is via `delegate`.
2. **Worker is input-locked.** Keyboard input in worker TUI is ignored. All tasks come from socket. On the launcher path, the worker pane is **monitor-only** with explicit kitty title `worker-{hash}`, hard input block, and visually distinct display.
3. **Worker owns the working directory during a task.** No file locks; coordination is by design (Mind doesn't run competing edits).
4. **No daemon.** Worker is a normal Pi process. Clean termination on `/stop-worker` (legacy) or via launcher kill (reset).
5. **One pair per cwd.** Prevents socket collisions and race conditions.
6. **Ctrl+C is cooperative abort.** Never orphans a running subprocess.

---

## 11. Decisions Reference

| # | Question | Decision |
|---|----------|----------|
| 1 | Architecture | Mind = main interactive model, Worker = subprocess-like peer over socket |
| 2 | Model selection | User selects manually per instance (Mind and Worker are independent Pi sessions). **[LAUNCHER PATH]** On reset, role-default models from config (`mindModel`, `workerModel`) are applied automatically. See `mind-worker-reset-design.md §8`. |
| 3 | Invocation | Persistent interactive instances, not ephemeral subprocesses. **[LAUNCHER PATH]** Launcher spawns both instances via `--mind-worker-role` flag. See `mind-worker-reset-design.md §2.2`. |
| 4 | Worker tools | Full default Pi tools |
| 5 | Workflow loop | Iterative step-by-step with Mind review between steps |
| 6 | Reviewer | Mind reviews Worker output directly (no third instance) |
| 7 | Communication | Unix socket, line-delimited JSON |
| 8 | Data flow | Plan file on disk + socket messages + context string |
| 9 | Kitty visibility | Kitty splits for monitoring; socket is the actual wire |
| 10 | Tool interface | Single `delegate` tool with `task`, `step`, `plan`, `context` params. `reset` param **[REMOVED -- DEPRECATED]** -- superseded by hard respawn model. See `mind-worker-reset-design.md §4`. |
| 11 | Timeout handling | Configurable bash timeout (120s default); Worker returns TIMEOUT error |
| 12 | Error handling | Pass structured errors to Mind; Mind decides retry/ask-user |
| 13 | Negative review | Mind iterates with corrections (new delegate call) |
| 14 | Configuration | Global `~/.pi/agent/mind-worker.json` |
| 15 | Temp files | Plan file in `~/.pi/agent/mindworker/` (persistent); ephemeral outputs in `/tmp` |
| 16 | Plan format | Markdown numbered steps |
| 17 | Socket creation | Mind creates, Worker polls |
| 18 | System prompt injection | Explicit workflow protocol via `before_agent_start` |
| 19 | Session resume | Track plan file path + phase; restore on `/be-mind` **[LEGACY ONLY]** -- launcher path does fresh boot with `--session-dir` flag. See `mind-worker-reset-design.md §5.2`. |
| 20 | Context extraction | Auto-injected snapshot (`tree`, `git status`) on mind startup |
| 21 | Gather timing | Mind delegates explicit explore tasks when needed |
| 22 | Mind-only direct answers | Smart router: Mind answers facts directly, delegates implementation |
| 23 | Blocking vs async | `delegate` blocks until result; live status updates in TUI footer |
| 24 | Stop commands | `/stop-mind`, `/stop-worker`; peer detects disconnect and waits. **[LEGACY ONLY]** -- launcher path uses `/mind-reset` or kitty shortcut to invoke orchestrator kill+spawn. |
| 25 | Worker TUI display | Normal Pi streaming behavior; task injected as user message. **[LAUNCHER PATH]** Worker pane is **monitor-only** with hard input block and explicit kitty title `worker-{hash}`. See `mind-worker-reset-design.md §7`. |
| 26 | Auto-review | Mind reviews after every code-change step; can skip for trivial tasks |
| 27 | Multi-step delegation | Step-by-step, not monolithic |
| 28 | Bash streaming | Worker streams bash stdout via `status` messages in real time |
| 29 | Plan persistence | Plan file written to disk by extension; survives turns and resume |
| 30 | Worker plan visibility | Worker receives current step via task + full plan file path for context |
| 31 | Worker history reset | Optional `reset: true` on delegate to clear worker session. **[REMOVED -- DEPRECATED]** Hard respawn on launcher path deletes entire worker session dir. See `mind-worker-reset-design.md §4.4`. |
| 32 | Plan file format | Markdown (human readable); `currentStep` index passed via JSON |
| 33 | Discovery mechanism | Deterministic socket path; Worker polls until connected. **[LAUNCHER PATH]** Adds generation fencing via manifest JSON -- worker validates generation on connect. See `mind-worker-reset-design.md §3.3`. |
| 34 | Role transition | Mutate in-place with role marker message; preserve prior chat history. **[LEGACY ONLY]** -- launcher path spawns fresh instances per role. |
| 35 | Compaction safety | Mind sends `context` summary on every delegate; survives worker compaction |
| 36 | Plan file location | `~/.pi/agent/mindworker/{hash}-plan.md` (state, not temp) |
| 37 | Mind writes plan | Extension extracts `plan` param from `delegate` and writes to disk |
| 38 | Protocol schema | Line-delimited JSON: `task`, `status`, `result`, `error`, `abort`, `ping`/`pong` |

---

## 12. Open Implementation Details

The following are agreed-upon but require concrete implementation in the extension code:

- Exact extension event hooks (`before_agent_start`, `tool_call`, `input`, etc.) to intercept and mutate behavior.
- How to override `sessionManager` path from within an extension command (`/be-mind`).
- Custom rendering for `delegate` tool calls in the Mind TUI (show "Delegating to worker..." instead of raw JSON).
- How the Worker extension suppresses keyboard input without breaking Pi's TUI event loop.
- Exact regex/heuristic for detecting "incomplete" worker turns (question detection).
- ~~Session compaction for Worker (`reset: true`)~~ **[MOOT]** — `delegate.reset` was removed from the public schema. Hard respawn via launcher supersedes this; launcher deletes the entire worker session dir on reset. See `mind-worker-reset-design.md §4.4`.

### Launcher-Specific Implementation Details

Items marked **[SPECIFIED]** are now concrete in `mind-worker-reset-design.md`.

- ~~Launcher socket ready-check mechanism~~ **[SPECIFIED]** — polling interval 200ms, probe TCP connect, manifest state + generation check. See reset-design.md §2.6.
- ~~Manifest JSON schema / field ownership / refresh~~ **[SPECIFIED]** — full field ownership table, state enum, and lifecycle across reset. See reset-design.md §3.2.
- ~~Generation counter allocation~~ **[SPECIFIED]** — launcher allocates, mind confirms via state change. Counter held in launcher memory across cleanup. See reset-design.md §3.2–§3.3, §4.4.
- Supervisor process: exact implementation (shell wrapper around `pi`, or dedicated node process?).
- ~~Supervisor control file protocol~~ **[SPECIFIED]** — full JSON schema, command/status enums, polling interval 200ms, stop sequence. See reset-design.md §6.2.
- ~~`/mind-reset` command handler~~ **[SPECIFIED]** — mind extension invokes launcher directly, control file used for busy check. See reset-design.md §4.1, §6.2.
- Kitty shortcut binding: exact key combo, script path.
- Worker pane creation: `kitty @ launch` args, split direction, title, cwd. (Titles and position spec'd in reset-design.md §2.4–§2.5; exact CLI args depend on implementation.)
- Focus management after reset: how to programmatically focus mind pane in kitty.
- Monitor-only worker TUI: how to suppress keyboard input at TUI level (Pi event loop integration).
- ~~`realpath` canonicalization~~ **[SPECIFIED]** — runs in launcher before cwd hash computation. See reset-design.md §3.1.
- Legacy session_start role restore gating: how the extension detects presence/absence of `--mind-worker-role` flag.
- Failure reporting: how launcher communicates failure back to user (notification in mind TUI? terminal stderr?).

---

## 13. Launcher Path Quick Reference

The launcher-based model (see `mind-worker-reset-design.md` for full detail) replaces the legacy command-based startup/reset. Key differences:

| Aspect | Legacy | Launcher |
|--------|--------|----------|
| Role assignment | `/be-mind` / `/be-worker` commands | `--mind-worker-role mind\|worker` flag |
| Session isolation | Extension-side sessionManager override | `--session-dir` flag from launcher |
| Startup | User runs commands in split panes | Launcher spawns both |
| Reset | `/stop-mind` + `/be-mind` | `/mind-reset` or kitty shortcut -- hard respawn |
| Worker visibility | Normal Pi streaming | Monitor-only + explicit title + input blocked |
| Mind lifecycle | Direct pi process | Supervisor wrapper |
| Session continuity | Role restore on resume | Fresh boot on role-flag start |
| Artifact cleanup | Manual | Delete all pair-scoped artifacts |
| Generation tracking | None | Manifest JSON with counter |
| Worker disconnect | Mind waits, prints message | Worker exits immediately; mind stays up |

---

*End of plan -- see also `mind-worker-reset-design.md` for launcher path source of truth.*
