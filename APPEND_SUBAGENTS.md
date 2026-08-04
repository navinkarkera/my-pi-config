The Main agent should act as the orchestrator and decision maker. Split the tasks into smaller pieces and delegate to subagents (in parallel if required) with precise instructions.
Main-session subagent policy:
- Use `read` directly only for small local checks.
- Use `write` directly only if you have already come up with the full text.
- Use `edit` directly only if you have already come up with the full text..
- Use `subagent` for context-heavy exploration, tests, implementation, review, and any bash/edit/write work.
- Use `light-worker` for simple edits, small commands, targeted config/docs tweaks, and straightforward commits.
- Use `worker` only for more complex implementation tasks.
- Use `scout` for code discovery, `planner` for plans, `tester` for targeted checks, and `reviewer` only when an additional eye is worth the cost.
- Main agent self-reviews by default. Use `reviewer` for large/risky/unfamiliar diffs, security/auth/payment/data-loss paths, migrations, worker-made changes the main agent did not deeply inspect, failing/flaky tests, or when the user asks for review.
- Use `deep-reviewer` only for explicitly requested deep/exhaustive review, or for exceptionally high-stakes, broad changes where independent multi-angle investigation is warranted. Use `reviewer` for all other delegated reviews.
- When using `reviewer` or `deep-reviewer`, ask for blocking correctness/security issues only; avoid style/nit reviews.
- Prefer workflow prompts when useful: `/scout-and-plan`, `/implement`, `/implement-and-review`.
- If a task needs unavailable tools, delegate instead of saying you cannot do it.
- Use `investigater` (`agents/investigater.md`) for hard-to-find bug root-cause investigations; it uses `openai-codex/gpt-5.6-luna:high` and may delegate to scout, light-worker, worker, or tester.

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

Discovery: `pi-bridge list` returns `(PID, IDLE, SESSION, NAME, CWD, SOCKET)`. Filters: `--pid`, `--cwd`, `--session`, `--name`, `--socket`. If exactly one bridge is active, target flags are optional.

Commands:
- `state` — structured snapshot (idle, model, cwd, session id, paths).
- `send "msg"` — deliver a prompt; auto-queues if the target is busy. Slash dispatch is hybrid: `/skill:<name>` and prompt templates expand client-side, including `${N:-default}`, `${@:-default}`, and `${ARGUMENTS:-default}` defaults, extension/TUI commands paste into the target Pi pane, and plain text uses normal `sendUserMessage`. Repeated `/skill:<name>` sends in one Pi session use a short previously-loaded reminder unless the `SKILL.md` content hash changes; session shutdown evicts that session, bridge restart loses the in-memory cache, and the bridge keeps only the 100 most recent sessions.
- `steer "msg"` / `follow-up "msg"` / `abort` — interrupt-and-redirect / queue-after-turn / cancel.
- `history N` / `stream` — structured events (input, message_update, tool_execution_start, tool_execution_update, tool_execution_end, agent_end, bridge_pong, question, `vstack_activity`). Activity rows are non-chat bridge events emitted by the local activity broker. History returns compact envelopes by default — `input` is reduced to source/streamingBehavior/images count/text byte count + preview, `message_update` to role/contentIndex/delta length + preview, `tool_execution_*` to name/id/status/byte counts/artifact paths, and `agent_end` to status/usage/final-text preview. Pass `--raw` (alias `--verbose`) to rehydrate from the per-session JSONL sidecar; `--event NAME`, `--since TS`, and `--max-bytes N` narrow the response.
- `questions` + `answer --request-id … --answers '[[...]]'` / `reject --request-id …` — drive `pi-questions` popups.
- `commands` — list slash commands the target session exposes.
- `/bridge:ping <text>` (via `send`) — no-LLM connectivity probe.

Installed at `~/.local/bin/pi-bridge` (global).
<!-- vstack:append-system @vanillagreen/pi-session-bridge end -->
