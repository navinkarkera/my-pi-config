# PRD: Launcher-Based Mind-Worker Startup/Reset

## Problem Statement

The current mind-worker extension relies on in-session commands (`/be-mind`, `/be-worker`) and manual pane management for startup, role switching, and reset. This legacy approach has several pain points:

- Users must manually run `/be-mind` then `/be-worker` in separate kitty splits — a multi-step startup ritual that breaks flow.
- Role switching mutates the Pi session in-place, carrying stale chat history and tool state across boundaries, causing context pollution and tool-misconfiguration bugs.
- Resetting a pair requires a fragile sequence: `/stop-mind`, kill the worker pane, re-split, re-run `/be-mind`, re-run `/be-worker`. Any missed step leaves the pair in a half-broken state.
- The legacy path provides no generation tracking or fencing — stale sockets and orphaned worker processes from prior sessions silently collide with new ones.
- No unified lifecycle management exists. The extension, the kitty terminal, and the user all share responsibility for process lifecycle, leading to edge-case failures (zombie processes, stuck sockets, session corruption).
- Layout constraints (kitty only) and monitor-mode enforcement are weakly documented, making the system fragile across terminal configurations.

The result: startup is unreliable, reset is error-prone, and the system has no deterministic recovery path.

## Solution

Replace the in-session command-based lifecycle with an external orchestrator (launcher) that owns the full lifecycle of both mind and worker Pi instances. The launcher:

- Spawns both instances with explicit role flags (`--mind-worker-role mind|worker`), ensuring each boots clean with role-specific tools, session directories, and no legacy restore.
- Writes and refreshes a per-cwd-hash manifest JSON that tracks pids, pane IDs, generation counter, and state.
- Wraps the mind instance in a supervisor process that manages mind-pane lifecycle during resets and relays control-file commands.
- Provides a unified reset protocol: `/mind-reset` command or kitty shortcut → hard kill of both instances → full artifact cleanup → fresh spawn of both — all within strict sequential phase barriers.
- Uses generation fencing (monotonically increasing counter per reset) to reject stale connections, stale sockets, and stale control-file reads.
- Enforces monitor-only worker pane with hard input block and explicit kitty titles.
- Retains the existing socket protocol, delegate tool interface, and workflow steps unchanged — only the startup/reset layer changes.

The legacy command path (`/be-mind`, `/be-worker`, `/stop-mind`, `/stop-worker`) is kept for backward compatibility but marked deprecated.

## User Stories

1. As a developer using mind-worker pairs, I want to start a fresh pair with a single shortcut, so that I don't have to manually spawn and configure two Pi instances.

2. As a developer, I want the launcher to canonicalize the working directory and compute a stable hash before any identity lookup, so that symlink differences between panes don't cause socket or session mismatch.

3. As a developer, I want the launcher to spawn the mind instance first and wait until it is fully ready (socket listening, generation acknowledged) before spawning the worker, so that the worker never connects to a half-initialized mind.

4. As a developer, I want the launcher to poll the manifest state and probe the Unix socket every 200ms during the ready-check, so that I get fast startup without busy-looping.

5. As a developer, I want a configurable startup timeout (default 30s) for the ready-check, so that slow-booting models don't cause false failures.

6. As a developer, I want the launcher to write a manifest JSON at `~/.pi/agent/mindworker/{hash}-manifest.json` on spawn, so that the orchestrator has a single source of truth for pids, pane IDs, generation, and session dirs.

7. As a developer, I want the manifest to include a `state` field with enum values (`starting`, `running`, `stopped`), so that the launcher can distinguish "not yet ready" from "ready, generation confirmed" during startup.

8. As a developer, I want the manifest to track both `mindSupervisorPid` and `mindChildPid`, so that the launcher can signal the supervisor (which wraps the mind) during reset instead of killing the mind child directly.

9. As a developer, I want the launcher to increment a generation counter on every reset, so that stale worker connections, sockets, and control-file reads from prior generations are explicitly rejected.

10. As a developer, I want the mind process to acknowledge the generation by writing it into the manifest once the socket is listening, so that the launcher can verify generation match before spawning the worker.

11. As a developer, I want the worker to validate the generation on connect and reject servers from a different generation, so that a slow-to-connect worker from a prior reset never corrupts a fresh pair.

12. As a developer, I want the launcher to verify the success gate (mind ready + worker connected, same generation) before declaring startup successful, so that I never get a partially-initialized pair.

13. As a developer, I want the mind extension to write `"worker-connected"` to the control file when the worker handshake completes, so that the launcher can detect worker connection via polling rather than relying on fragile timing.

14. As a developer, I want to type `/mind-reset` in the mind TUI to trigger a complete hard respawn of both instances, so that I can recover from stuck tasks or corrupted state without manual process management.

15. As a developer, I want a kitty shortcut binding that invokes the launcher directly, so that I can start or reset a pair without typing any command.

16. As a developer, I want the launcher to follow strict sequential phase barriers (stop → cleanup → spawn → verify) during reset, so that old artifacts are never visible to new instances.

17. As a developer, I want the stop phase to write `{ command: "stop" }` to the control file as the primary trigger, then poll for supervisor acknowledgement (`"child-stopped"`) before resorting to signals, so that the supervisor has a chance to shut down gracefully.

18. As a developer, I want signals (SIGTERM → SIGKILL) used only as escalation when the supervisor fails to acknowledge within `resetTimeout`, so that we never kill the supervisor before it can clean up the mind child.

19. As a developer, I want the cleanup phase to delete the entire mind session directory, worker session directory, socket file, plan file, manifest, and temp outputs for this cwd hash, so that new instances boot with absolutely fresh state.

20. As a developer, I want the generation counter held in launcher process memory between cleanup and spawn, so that it survives manifest deletion and the new manifest starts at the correct generation.

21. As a developer, I want the spawn phase to write a new manifest with the incremented generation before the mind instance boots, so that generation fencing is active from the first moment of the new pair.

22. As a developer, I want the mind instance to use a supervisor wrapper process on the launcher path, so that the supervisor can kill and report child exit during resets without losing the mind kitty pane.

23. As a developer, I want the supervisor to poll the control file every 200ms for incoming commands, so that it responds to `"stop"` within a polling cycle.

24. As a developer, I want the supervisor to handle unexpected mind child crashes, so that I can detect and potentially restart a failed mind.

25. As a developer, I want the worker pane to be monitor-only with hard input block and explicit kitty title `worker-{hash}`, so that I can watch worker progress without accidentally typing into it.

26. As a developer, I want the role-flag worker to exit immediately on disconnect from the mind, so that orphaned worker processes don't accumulate after a reset or mind crash.

27. As a developer, I want the role-flag mind to stay up if the worker disconnects, so that I can continue working in the mind role or trigger a reset without losing context.

28. As a developer, I want after-reset focus to return to the mind pane automatically, so that I can immediately start typing without manually switching panes.

29. As a developer, I want the launcher to apply role-default models from `~/.pi/agent/mind-worker.json` (`mindModel`, `workerModel`) on reset, so that each reset produces a pair with the correct model assignment.

30. As a developer, I want worker spawn failure (after mind is ready) to leave the mind running in mind role with a clear failure message, so that I can debug or retry without losing the mind session.

31. As a developer, I want mind spawn failure to abort immediately without spawning a worker, so that I get a clear failure signal rather than a half-initialized pair.

32. As a developer, I want the control file to use generation fencing so that commands and status from a prior reset cycle are silently ignored, so that stale control-file writes never cause spurious actions.

33. As a developer, I want the control file written atomically (`.tmp` + `rename`), so that readers always see a complete JSON object.

34. As a developer, I want `status` ownership to switch by protocol phase (mind extension during normal operation, supervisor during stop), so that no two writers ever write `status` concurrently.

35. As a developer, I want the legacy `/be-mind`, `/be-worker`, `/stop-mind`, `/stop-worker` commands to continue working for backward compatibility, so that existing workflows are not broken during the migration.

36. As a developer, I want the launcher to be a thin shell wrapper over a shared TypeScript helper, so that the core protocol logic is testable independently of shell orchestration.

37. As a developer, I want the config schema extended with `resetTimeout` (default 5) and `kittyEnabled` (default true), so that timeout and terminal-specific behaviour are user-configurable.

38. As a developer, I want an explicit `--session-dir` flag passed by the launcher to both instances, so that mind and worker have fully isolated Pi session directories without relying on extension-side session manager overrides.

39. As a developer, I want the `session_start` role-restore hook to fire only when `--mind-worker-role` is absent, so that the launcher path gets a guaranteed fresh boot while the legacy path keeps its resume behaviour.

40. As a developer, I want the supervisor to write `"child-stopped"` to the control file after the mind child exits, so that the launcher can reliably distinguish "child exited normally" from "supervisor unresponsive."

## Implementation Decisions

### Modules to Build/Modify

**Launcher / Orchestrator** — A new shell script (`mind-worker-launcher`) wrapping a shared TypeScript helper. Responsible for: canonicalizing cwd, computing hash, reading/writing manifest, spawning supervisor (for mind) and direct pi (for worker), executing the reset protocol (stop → cleanup → spawn → verify), handling success-gate checks, and reporting failures. Designed as a thin shell wrapper over a testable core.

**Manifest Store** — A module encapsulating all manifest JSON operations: read, write, field updates, field ownership enforcement, state transitions (`starting` → `running` → `stopped`), and generation counter management. Must handle atomic writes and enforce the per-field ownership rules from the design doc.

**Supervisor / Control Protocol** — A supervisor process (wrapper around the mind Pi instance) plus a TypeScript module implementing the control-file JSON schema: command interpretation (`"stop"`), status reporting (`"waiting"`, `"child-stopped"`, `"error"`), polling loop (200ms interval), generation fencing, and atomic file writes. The supervisor must kill the mind child on `"stop"` and report completion before handling signals.

**Mind Command Integration** — Modifications to the existing `mind-worker.ts` extension to: recognize the `--mind-worker-role` CLI flag, skip the `session_start` role-restore path when the flag is present, use the provided `--session-dir` for session isolation, and write status updates (`"ready"`, `"busy"`, `"worker-connected"`) to the control file during normal operation. The `/mind-reset` command handler in the extension must invoke the launcher script directly.

**Worker Monitor-Mode Enforcement** — Modifications to the worker side of the extension (or the Pi TUI integration) to suppress all keyboard input when launched with `--mind-worker-role worker`. The worker pane displays output only; all user keystrokes are ignored. The worker exits immediately on socket disconnect.

**Kitty Pane Adapter** — A module that abstracts kitty terminal operations: launching a new window/tab with two splits, setting explicit pane titles (`mind-{hash}`, `worker-{hash}`), splitting the worker pane on the right, closing the worker pane on reset, and returning focus to the mind pane after reset. Should be injectable so it can be stubbed or replaced if kitty is not available (`kittyEnabled` config flag).

**Config Loader** — Extension of the existing `mind-worker.json` config schema to include `mindModel`, `workerModel`, `resetTimeout`, and `kittyEnabled`. The launcher reads this config to determine role-default models and timing parameters. Backward compatible with the existing config shape.

**Communications Between Modules**

| Caller | Callee | Mechanism |
|--------|--------|-----------|
| Launcher | Manifest Store | Function calls (TypeScript module) |
| Launcher | Control File | JSON file read/write via fs |
| Supervisor | Control File | JSON file poll/read/write via fs |
| Mind extension | Control File | JSON file write via fs |
| Launcher | Kitty Pane Adapter | spawn/exec of kitty CLI |
| Mind extension | Launcher | subprocess spawn of launcher script |
| Mind | Worker | Unix socket (unchanged from legacy) |

### Schema Changes

- **Manifest JSON** (`{hash}-manifest.json`): new file, schema defined in reset-design.md §3.2. Fields: `cwd`, `cwdHash`, `generation`, `mindSupervisorPid`, `mindChildPid`, `workerPid`, `mindPaneId`, `workerPaneId`, `mindRole`, `workerRole`, `mindSessionDir`, `workerSessionDir`, `state` (enum: `starting`/`running`/`stopped`), `lastUpdated`, `startedAt`.
- **Control File JSON** (`{hash}-mind-control.json`): new file, schema defined in reset-design.md §6.2. Fields: `generation`, `command`, `status`, `message`, `lastUpdated`.
- **Config** (`mind-worker.json`): extended with `mindModel`, `workerModel`, `resetTimeout`, `kittyEnabled`.

### Key Architectural Decisions

- The control file `command` field is the primary trigger for supervisor actions. Signals (SIGTERM/SIGKILL) are escalation only after the supervisor fails to acknowledge within `resetTimeout`.
- `status` ownership switches by protocol phase: mind extension owns it during normal operation, supervisor owns it during stop. The `command` field signals the phase transition.
- The launcher holds the generation counter in process memory between cleanup and spawn. It is never stored outside the manifest file.
- The launcher path uses `--session-dir` for session isolation; the extension does not override `sessionManager`. The legacy path continues to use the override mechanism.
- The supervisor is a separate process that wraps the mind Pi instance. It is not a shell script wrapper — it is a purpose-built process that relays I/O and manages the control file protocol.
- The legacy commands (`/be-mind`, etc.) are preserved but deprecated. The extension uses the presence of `--mind-worker-role` to select the launcher path vs. legacy path.
- Kitty is the only supported terminal multiplexer (v1). Future terminal support would require a new pane adapter.

## Testing Decisions

A good test for this system verifies external behaviour through process boundaries: spawn, signal, file state, socket state. Tests should not assert internal call sequences or private function calls. Each test should start from a known-clean filesystem state and verify the resulting files, processes, socket liveness, and exit codes.

**Candidate test boundaries:**

| Module | What to test | How |
|--------|-------------|-----|
| **Manifest Store** | Read/write round-trip, field ownership (reject launcher-only field writes from mind, etc.), state transitions (invalid transitions rejected), generation increment, atomic-write crash safety | Unit tests against a temp directory; inject fs mock or use real temp dir |
| **Control Protocol** | Supervisor reads `"stop"` command, kills child, writes `"child-stopped"`; launcher poll observes it; generation fencing rejects stale commands; timeout escalates to SIGTERM/SIGKILL | Integration tests: spawn supervisor + fake child process in temp dir, write commands, verify status transitions within timeouts |
| **Launcher Orchestrator** | Full reset cycle: stop running pair → cleanup artifacts → spawn new pair → verify success gate; failure scenarios (worker never connects, socket never ready) | Process-level integration: launcher script invoked with known cwd, mock mind exits, verify manifest + control file state after each phase |
| **Mind Role Flag** | Extension skips session_start restore when `--mind-worker-role` is set; uses provided `--session-dir`; writes control file `"ready"` after socket listen | Unit tests against extension hooks; verify sessionManager is not overridden when flag present |
| **Worker Monitor Mode** | Hard input block active; process exits on socket disconnect; TUI output visible but keyboard ignored | TUI-level integration testing via pseudo-terminal |
| **Kitty Pane Adapter** | Spawns correct kitty command with correct title, split direction, cwd; focus-mind after reset | Unit test with kitty CLI mocked; verify command arguments |
| **Config Loader** | Extended schema accepted; legacy config (without new fields) loads with defaults; missing file creates default | Unit tests against temp config files |

**Prior art in this repo:** No test directory, test configuration, or test runner configuration was found in `/home/navin/.pi/agent/`. The existing `mind-worker.ts` and `surface-worker-result.ts` have no corresponding test files. This will be the first test suite in the project.

## Out of Scope

- Changes to the socket protocol (task/result/status/error/abort/ping-pong messages) or the `delegate` tool interface — these remain as documented in `mind-worker-architecture.md`.
- Gather/implement/review workflow (session 1 design) — the delegate workflow is orthogonal to the startup/reset layer.
- Non-kitty terminal multiplexer support. Only kitty v1 is targeted. Future work may add wezterm, tmux, or native splits.
- In-process re-init or soft reset (hot reload). All resets are hard respawns.
- Windows support. The supervisor, signal handling, and kitty integration are Unix-specific.
- Remote/multi-machine pairs. Both mind and worker run on the same machine.
- Monitoring dashboard or historical reset logs. The launcher reports failures but does not persist a reset history.
- Migration script for existing legacy sessions. Users transition by adopting the launcher path for new work; old sessions remain usable via the legacy path.

## Further Notes

**Documentation sources.** This PRD synthesises three existing design documents:

- `mind-worker-reset-design.md` — ratified launcher/reset specification (source of truth for this feature).
- `mind-worker-architecture.md` — core protocol, tools, workflow (unchanged by this work, but cross-referenced for socket protocol and delegate interface).
- `design-mind-worker.md` — session 1 raw notes on gather/implement/review (background context only).

**No issue tracker integration available.** The current environment provides no tooling (GitHub CLI, linear CLI, Jira integration, or Pi issue-tracker skill) to publish this PRD to an external issue tracker. This document is stored as a markdown file at `mind-worker-launcher-reset.prd.md` in the agent directory. To use with an issue tracker, a maintainer must manually create issues from the user stories section or add the appropriate issue-tracker tooling to this environment.

**Existing config.** The current `~/.pi/agent/mind-worker.json` contains `timeout: 6000`, `statusStream: true`, `autoSpawnWorker: true`, `workerTaskStrictness: "strict"`, `notifyOnMindIdle: true`, and `ntfyTopic`. The extended config (`mindModel`, `workerModel`, `resetTimeout`, `kittyEnabled`) will be additive — the existing fields remain unchanged and functional for the legacy path.

**Existing extension code.** The `mind-worker.ts` extension at `~/.pi/agent/extensions/mind-worker.ts` implements the legacy command-based path. It will be modified (not replaced) to add `--mind-worker-role` handling, control-file writes, and the `/mind-reset` command, while preserving all legacy functionality. The `surface-worker-result.ts` extension is independent and unaffected.
