Labels: needs-triage

## What to build

Build the Manifest Store module and the startup success-gate verification. The manifest JSON (`~/.pi/agent/mindworker/{hash}-manifest.json`) is the single source of truth for generation, pids, pane IDs, state, and session dirs for a cwd-hash pair. The success gate verifies both mind and worker are live and on the same generation before declaring startup successful.

**Manifest Store** — TS module encapsulating all manifest operations:
- Write initial manifest on spawn with state `"starting"`, allocated generation, and role-specific session dirs.
- Field ownership enforcement: launcher writes `cwd`, `cwdHash`, `generation` (initial), `mindSupervisorPid`, `mindPaneId`, `mindRole`, `mindSessionDir`, `state` (initial), `startedAt`. Mind extension writes `generation` (confirms) and flips `state` to `"running"`. Supervisor writes `mindChildPid`. Launcher writes `workerPid`, `workerPaneId`, `workerRole`, `workerSessionDir`.
- State machine: `starting` → `running` → `stopped`. Invalid transitions rejected.
- Generation counter: starts at 1, incremented by launcher on each reset. Held in launcher memory between cleanup and spawn.
- Atomic writes (`.tmp` + `rename`) for crash safety.

**Success gate** — Verification that startup succeeded:
- Launcher polls every 200ms (default 30s timeout) checking:
  - Socket file exists at `~/.pi/agent/mindworker/{hash}.sock` and is connectable (probe open-close, no data).
  - Manifest `state` is `"running"` and `generation` matches the generation launcher allocated.
- After worker spawn, launcher polls control file (up to 10s) for status `"worker-connected"` with matching generation.
- Both conditions must hold: mind ready + worker connected, same generation.

## Acceptance criteria

- [ ] Manifest JSON written on spawn at `~/.pi/agent/mindworker/{hash}-manifest.json` with all required fields and state `"starting"`
- [ ] Field ownership enforced — launcher, mind extension, and supervisor each write only their owned fields; writes to unowned fields rejected
- [ ] State transitions enforced: `starting` → `running` → `stopped`; invalid transitions (e.g. `running` → `starting`) rejected
- [ ] Generation counter starts at 1, monotonically incremented on each reset, held in launcher memory across cleanup-spawn gap
- [ ] Success gate passes only when: (a) socket is connectable, (b) manifest state is `"running"` with correct generation, (c) control file shows `"worker-connected"` with same generation
- [ ] Manifest writes are atomic — reader always sees a complete JSON object or nothing
- [ ] 30s default timeout for mind-ready check, 10s for worker-connected check — both configurable

## Blocked by

- `002-thin-launcher-spawns-canonical-kitty-pair.md`
