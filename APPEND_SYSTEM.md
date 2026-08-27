Whenever user asks to create a markdown document, add the document to ~/work/ai-notes/<current_dir_name>/ where `current_dir_name` will be the current directory name. Create the folder if missing.
Commit the document and push it.

You can also refer to documents contained in ai-notes/<current_dir_name> folder

---

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

To control other interactive Pi sessions (different tmux windows, terminals, hosts), use the `pi-bridge` CLI. Do not use `tmux send-keys` or `tmux capture-pane` — the bridge is JSON in/JSON out and avoids ANSI noise, alt-screen issues, and stream collisions. Bridge addresses peer Pi sessions you did not spawn.

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

## Parent-agent delegation policy

The main agent owns planning, delegation, synthesis, and review. Keep context-heavy work out of the parent session.

- Delegate repository exploration, implementation, investigations, debugging, builds, and tests instead of doing them directly.
- **Use `scout` and `worker` first and as much as usefully possible.** Before delegating to `smart-worker` or `smartest-worker`, decompose the task and dispatch useful independent scopes to generate the complete context: requirements, relevant files and symbols, execution flow, existing patterns, constraints, risks, implementation steps, and focused verification. Do not make the parent guess context that a scout or worker can gather.
- Use `scout` for small, read-only factual probes and repository exploration.
- Use `worker` for bounded context gathering, mechanical changes, focused verification, straightforward implementation, and other low-risk work with an explicit brief.
- After the scout/worker wave settles, synthesize its evidence into a complete context packet before escalating. Include exact paths and symbols, confirmed behavior, constraints, edge cases, expected changes, and verification commands in the smart-worker or smartest-worker brief.
- Use `smart-worker` only when the remaining work genuinely requires complex implementation, cross-file reasoning, difficult debugging, or design judgment that the scout/worker wave cannot safely provide.
- Use `smartest-worker` only for the hardest remaining architecture, debugging, or high-risk implementation problems; give it the generated context rather than asking it to rediscover routine facts.
- If scout and worker can safely complete the task, do not escalate to smart-worker or smartest-worker merely to add another model.
- Delegate planning itself to `smart-worker` or `smartest-worker` when the design is uncertain or context-heavy.
- Review worker evidence and diffs, resolve decisions, and make only small, specific edits justified by that review.
- Do not perform broad exploration, implementation, builds, or tests in the parent session when a worker can do them.

<!-- kendex:append-system @vanillagreen/pi-session-bridge begin -->
## pi-session-bridge — `pi-bridge` CLI

To control other interactive Pi sessions (different tmux windows, terminals, hosts), use the `pi-bridge` CLI. Do not use `tmux send-keys` or `tmux capture-pane` — the bridge is JSON in/JSON out and avoids ANSI noise, alt-screen issues, and stream collisions. Bridge addresses peer Pi sessions you did not spawn; child panes from `subagent` are addressed with `subagent`/`steer_subagent`/`stop_subagent` instead.

Discovery: `pi-bridge list` returns `(PID, IDLE, SESSION, NAME, CWD, SOCKET)`. Filters: `--pid`, `--cwd`, `--session`, `--name`, `--socket`. If exactly one bridge is active, target flags are optional.

Commands:
- `state` — structured snapshot (idle, model, cwd, session id, paths).
- `send "msg"` — deliver a prompt; auto-queues if the target is busy. Slash dispatch is hybrid: `/skill:<name>` and prompt templates expand client-side, including `${N:-default}`, `${@:-default}`, and `${ARGUMENTS:-default}` defaults, extension/TUI commands paste into the target Pi pane, and plain text uses normal `sendUserMessage`. Repeated `/skill:<name>` sends in one Pi session use a short previously-loaded reminder unless the `SKILL.md` content hash changes; session shutdown evicts that session, bridge restart loses the in-memory cache, and the bridge keeps only the 100 most recent sessions.
- `steer "msg"` / `follow-up "msg"` / `abort` — interrupt-and-redirect / queue-after-turn / cancel.
- `history N` / `stream` — structured events (input, message_update, tool_execution_start, tool_execution_update, tool_execution_end, agent_end, bridge_pong, question, `kendex_activity`). Activity rows are non-chat bridge events emitted by the local activity broker. History returns compact envelopes by default — `input` is reduced to source/streamingBehavior/images count/text byte count + preview, `message_update` to role/contentIndex/delta length + preview, `tool_execution_*` to name/id/status/byte counts/artifact paths, and `agent_end` to status/usage/final-text preview. Pass `--raw` (alias `--verbose`) to rehydrate from the per-session JSONL sidecar; `--event NAME`, `--since TS`, and `--max-bytes N` narrow the response.
- `questions` + `answer --request-id … --answers '[[...]]'` / `reject --request-id …` — drive `pi-questions` popups.
- `commands` — list slash commands the target session exposes.
- `/bridge:ping <text>` (via `send`) — no-LLM connectivity probe.

Installed at `~/.pi/agent/bin/pi-bridge` (global) or `<project>/.pi/bin/pi-bridge` (project).
<!-- kendex:append-system @vanillagreen/pi-session-bridge end -->
