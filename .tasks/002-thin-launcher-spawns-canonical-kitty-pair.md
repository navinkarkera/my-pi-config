Labels: needs-triage

## What to build

Build the launcher orchestrator — a thin shell script (`mind-worker-launcher`) wrapping a shared TypeScript helper that owns the spawn lifecycle. The launcher:

1. Reads `realpath(process.cwd())` to canonicalize the working directory before any identity computation.
2. Computes a stable 16-char hex hash of the canonical cwd.
3. Spawns the mind instance (wrapped in a supervisor process) in the left kitty split with `--mind-worker-role mind --session-dir ~/.pi/agent/sessions/mind-{hash}`.
4. Waits for the mind to be ready (socket listening + manifest generation match — the polling mechanism is defined in issue 003; this issue covers the spawn orchestration and the kitty CLI invocations).
5. Spawns the worker instance in the right kitty split with `--mind-worker-role worker --session-dir ~/.pi/agent/sessions/worker-{hash}`.
6. Sets explicit kitty pane titles: `mind-{hash}` and `worker-{hash}`.
7. On first launch, opens a new kitty window/tab. On subsequent launch (pair already exists), resets in-place using the reset protocol (defined in issue 006).

The launcher is at `~/.pi/agent/bin/mind-worker-launcher`. The TS helper core is at a path resolved by the shell script. The shell wrapper is kept thin — all protocol logic lives in the TS core so it is testable independently of shell orchestration.

## Acceptance criteria

- [ ] Launcher canonicalizes cwd via `realpath` before hashing — symlinks replaced with real paths
- [ ] Launcher spawns mind in left kitty split with explicit title `mind-{hash}`, `--mind-worker-role mind`, and `--session-dir ~/.pi/agent/sessions/mind-{hash}`
- [ ] Launcher spawns worker in right kitty split with explicit title `worker-{hash}`, `--mind-worker-role worker`, and `--session-dir ~/.pi/agent/sessions/worker-{hash}`
- [ ] Mind is spawned first; launcher waits for ready (socket + generation match) before spawning worker
- [ ] First launch opens a new kitty window/tab (does not take over current pane)
- [ ] Subsequent launch when a pair exists triggers in-place reset (reset protocol implementation in issue 006)
- [ ] Shell script is thin — delegates core logic to a shared TypeScript module
- [ ] `kittyEnabled` config flag (default true) controls whether kitty CLI is called; when false, launcher prints instructions instead

## Blocked by

- `001-role-flag-fresh-boot-with-session-dir-isolation.md`
