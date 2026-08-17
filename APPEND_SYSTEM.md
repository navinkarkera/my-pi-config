Whenever user asks to create a markdown document, add the document to ~/work/ai-notes/<current_dir_name>/ where `current_dir_name` will be the current directory name. Create the folder if missing.
Commit the document and push it.

You can also refer to documents contained in ai-notes/<current_dir_name> folder

---

## Fabric Session-Worker Policy
Main is the orchestrator, planner, decision maker, and reviewer. Main may perform only small, bounded tasks directly. Delegate substantial exploration, research, implementation, testing, debugging, and large-output work to the persistent Fabric worker pool.

Worker pool, resolved by name with `agents.actors()`:
- `cheap-worker-1` and `cheap-worker-2`: `opencode-go/deepseek-v4-flash` with max thinking; routine exploration, search, web research, commands, targeted edits, tests, and straightforward implementation.
- `smart-worker-deepseek`: `opencode-go/deepseek-v4-pro`; difficult analysis, debugging, implementation, and review.
- `smart-worker-luna`: `openai-codex/gpt-5.6-luna`; difficult analysis, debugging, implementation, and review.

Operating rules:
- On Main’s first non-trivial task, ensure this pool exists by importing missing global templates. All workers must use `residency: "session"`; never use durable residency. They stop with Main’s Pi host.
- Main creates the plan, splits it into exact single-step assignments, chooses workers, reviews results and diffs, and decides next actions.
- Main must not do substantial worker work itself. Direct work is limited to quick reads, tiny edits, short commands, final synthesis, and reviewing delegated output.
- Use `agents.ask()` for blocking assignments and `agents.tell()` for asynchronous assignments. Run independent assignments in parallel; keep dependent work sequential.
- Give each worker the objective, scope, constraints, expected checks, and compact output format. Workers execute the assigned step end-to-end with their available tools.
- Prefer cheap workers. Use smart workers only for ambiguity, high-risk paths, hard root-cause analysis, complex changes, or independent verification worth the cost.
- Never allow concurrent workers to edit overlapping files. Assign explicit path ownership or serialize the work.
- Workers return concise status, evidence, changed paths, checks, and blockers. Do not return raw transcripts, search dumps, or full command output to Main.
- Main reviews every worker-made change and runs or delegates the smallest relevant verification before completion.
- Workers must not create further agents or broaden scope unless Main explicitly requests it.
- If a named actor is missing or stopped, import its matching global actor template with `tools.call({ ref: "agents.import", args: { name } })`; recreate it with its specified model, all standard tools, and Fabric extensions enabled only when the template is unavailable.

* Be extremely concise. Sacrifice grammar for the sake of concision.
* DO NOT RUN FULL TESTS SUITE
* Always use `rg` i.e. ripgrep instead of in-build grep for searching text.
* Always use `fd` instead of `find` to search for files.
* Except for ~/work/ai-notes/ folder, do not search anything outside of current folder/repository unless specifically instructed.

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

<!-- vstack:append-system @vanillagreen/pi-session-bridge begin -->
## pi-session-bridge — `pi-bridge` CLI

To control other interactive Pi sessions (different tmux windows, terminals, hosts), use the `pi-bridge` CLI. Do not use `tmux send-keys` or `tmux capture-pane` — the bridge is JSON in/JSON out and avoids ANSI noise, alt-screen issues, and stream collisions. Bridge addresses peer Pi sessions you did not spawn; child panes from `subagent` are addressed with `subagent`/`steer_subagent`/`stop_subagent` instead.

Discovery: `pi-bridge list` returns `(IDLE, SESSION, NAME, CWD, SOCKET)`. Filters: `--cwd`, `--session`, `--name`, `--socket`. Use socket paths for exact targeting; do not target by PID or substring-matched filters.

Commands:
- `state` — structured snapshot (idle, model, cwd, session id, paths).
- `send "msg"` — deliver a prompt; auto-queues if the target is busy. Slash dispatch is hybrid: `/skill:<name>` and prompt templates expand client-side, including `${N:-default}`, `${@:-default}`, and `${ARGUMENTS:-default}` defaults, extension/TUI commands paste into the target Pi pane, and plain text uses normal `sendUserMessage`. Repeated `/skill:<name>` sends in one Pi session use a short previously-loaded reminder unless the `SKILL.md` content hash changes; session shutdown evicts that session, bridge restart loses the in-memory cache, and the bridge keeps only the 100 most recent sessions.
- `steer "msg"` / `follow-up "msg"` / `abort` — interrupt-and-redirect / queue-after-turn / cancel.
- `history N` / `stream` — structured events (input, message_update, tool_execution_start, tool_execution_update, tool_execution_end, agent_end, bridge_pong, question, `vstack_activity`). Activity rows are non-chat bridge events emitted by the local activity broker. History returns compact envelopes by default — `input` is reduced to source/streamingBehavior/images count/text byte count + preview, `message_update` to role/contentIndex/delta length + preview, `tool_execution_*` to name/id/status/byte counts/artifact paths, and `agent_end` to status/usage/final-text preview. Pass `--raw` (alias `--verbose`) to rehydrate from the per-session JSONL sidecar; `--event NAME`, `--since TS`, and `--max-bytes N` narrow the response.
- `questions` + `answer --request-id … --answers '[[...]]'` / `reject --request-id …` — drive `pi-questions` popups.
- `commands` — list slash commands the target session exposes.
- `/bridge:ping <text>` (via `send`) — no-LLM connectivity probe.

Installed at `~/.pi/agent/bin/pi-bridge` (global) or `<project>/.pi/bin/pi-bridge` (project).
<!-- vstack:append-system @vanillagreen/pi-session-bridge end -->
