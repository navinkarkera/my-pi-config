Labels: needs-triage

## What to build

Build the mind supervisor process and the control file protocol that governs communication between launcher, supervisor, and mind extension during normal operation and resets.

**Supervisor process:**
- A dedicated process (not a shell wrapper) that wraps the mind Pi instance on the launcher path.
- The supervisor spawns the mind child process, relays its I/O transparently.
- The supervisor polls the control file every 200ms for incoming commands.
- On receiving `command: "stop"`, the supervisor kills the mind child (SIGTERM → SIGKILL after 3s grace), waits for exit, and writes `status: "child-stopped"` to the control file.
- The supervisor also handles unexpected mind child crashes: writes `status: "error"` with crash detail in `message`.

**Control file schema:**
- Path: `~/.pi/agent/mindworker/{hash}-mind-control.json`
- Fields: `generation` (number), `command` (string — `"stop"` or `""`), `status` (string — `"waiting"` / `"ready"` / `"busy"` / `"child-stopped"` / `"worker-connected"` / `"error"` / `""`), `message` (string), `lastUpdated` (epoch ms).

**Status ownership switching:**
- During normal operation (command empty): mind extension owns `status`. Supervisor writes `"waiting"` once at startup only.
- During stopping (command set to `"stop"`): supervisor owns `status` exclusively. Mind extension must stop writing.
- The launcher signals the phase transition by writing `command`. Before reading `status`, launcher confirms phase via `command` + `generation`.

**Generation fencing:**
- Every control file write includes the current `generation`.
- Readers (launcher, supervisor) check the generation matches their current generation before acting on `command` or `status`.
- Stale writes from prior reset cycles are silently ignored.

**Atomic writes:**
- All control file writes use `.tmp` + `rename()` pattern so readers always see a complete JSON object.

## Acceptance criteria

- [ ] Supervisor process wraps mind Pi instance on launcher path — spawned by launcher, manages mind child lifecycle
- [ ] Supervisor polls control file every 200ms for `command` — responds to `"stop"` within one poll cycle
- [ ] Supervisor stop sequence: kills mind child (SIGTERM → SIGKILL, 3s grace), writes `status: "child-stopped"` with correct generation
- [ ] Supervisor writes `status: "error"` on unexpected mind child crash with crash detail in `message`
- [ ] Control file reads and writes are generation-fenced — stale commands/status from prior generations silently ignored
- [ ] Status ownership switches by phase: mind extension during normal, supervisor during stop
- [ ] All control file writes are atomic (`.tmp` + `rename`) — partial writes never visible to readers
- [ ] Mind extension writes `status: "ready"`, `"busy"`, `"worker-connected"` during normal operation

## Blocked by

- `003-manifest-backed-startup-success-gate.md`
