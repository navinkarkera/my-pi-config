# Mind-Worker Reset & Launcher Design

**Status:** Ratified — resolved in mind-worker grilling session 2.

**Supersedes:** Legacy command-based role switching (`/be-mind`, `/be-worker`, etc.) for startup/reset lifecycle. Core protocol (socket, delegate tool, workflow steps) remains unchanged.

**See also:**
- `mind-worker-architecture.md` — core protocol, tools, workflow (still authoritative for those domains)
- `design-mind-worker.md` — session 1 design (gather/implement/review flow)

---

## 1. Overview

This document defines the **launcher-based startup/reset model** for mind-worker pairs. An external orchestrator (launcher) owns the lifecycle of both instances: spawns them, monitors them, and hard-respawns them on reset. This replaces the earlier model where `/be-mind` in-session commands handled role switching.

### 1.1 Terminology

| Term | Definition |
|------|------------|
| **Launcher / Orchestrator** | External process (shell script + TS helper) that spawns, kills, monitors, and resets mind-worker pairs. |
| **Mind instance** | Pi process launched with `--mind-worker-role mind`. Plans, delegates, reviews. |
| **Worker instance** | Pi process launched with `--mind-worker-role worker`. Executes delegated tasks. |
| **Supervisor** | Process wrapping the mind Pi instance. Manages mind lifecycle via control file + signals. |
| **Generation** | Monotonically increasing integer in the manifest, bumped on each reset. Used for fencing. |
| **Manifest** | JSON file per cwd hash: pid, generation, pane IDs, role, timestamps. |
| **Session dir** | Role-specific directory passed via `--session-dir`, isolating mind session from worker session. |
| **cwd hash** | Stable hash of `realpath(cwd)`. Identity for socket path, manifest, session dirs, artifacts. |

### 1.2 Two Paths

| Path | Status | How started |
|------|--------|-------------|
| **Legacy manual** | Deprecated. Kept for backward compatibility. | User runs `/be-mind` in Pi session. Auto-spawns worker if `KITTY_LISTEN_ON` set. |
| **Launcher** | Current. All new development. | External orchestrator spawns both instances with role flags. |

This document describes only the **launcher path**. Legacy details remain in `mind-worker-architecture.md`.

---

## 2. Launcher Architecture

### 2.1 Orchestrator

A thin shell wrapper over a shared TypeScript helper. It:

1. Canonicalizes `cwd` via `realpath`.
2. Computes cwd hash.
3. Reads/writes the manifest JSON.
4. Spawns mind (with supervisor) → waits for ready → spawns worker.
5. Handles reset signal from `/mind-reset` command or kitty shortcut.

**Location:** `~/.pi/agent/bin/mind-worker-launcher` (or similar project path).

### 2.2 Startup Role Flag

Pi processes accept a CLI flag:

```
--mind-worker-role mind|worker
```

When present, launcher-mode behavior activates:

- **Fresh boot** — no restore of old session or chat history for this cwd.
- **Session path** — overridden by `--session-dir` (see §2.3).
- **`--mind-worker-role worker`** — enables monitor-only TUI mode with hard input block.
- **`--mind-worker-role mind`** — uses supervisor wrapper (not direct pi).
- **Never auto-spawns the peer** — launcher handles both sides.
- **`session_start` role restore is skipped** — the legacy code path (reading `mind-worker-role` from session metadata to re-instate tools/server/socket) only fires when `--mind-worker-role` is absent.

### 2.3 Session Dir Flag

```
--session-dir /path/to/role-specific-session
```

Mind receives `--session-dir ~/.pi/agent/sessions/mind-{hash}`.
Worker receives `--session-dir ~/.pi/agent/sessions/worker-{hash}`.

This enforces split sessions at the launcher level rather than relying on extension-side session manager override. The session dirs are **Pi session directories** managed by Pi's SessionManager, not just `.jsonl` files.

### 2.4 Kitty Layout

Kitty terminal multiplexer only (v1). Layout:

```
┌─────────────────────┬─────────────────────┐
│   Mind Pane (left)  │  Worker Pane (right)│
│   supervisor wraps  │  direct pi          │
│   pi mind process   │  monitor-only       │
│                     │  input blocked      │
└─────────────────────┴─────────────────────┘
```

- Worker split on the right.
- Mind pane uses supervisor/wrapper.
- Worker pane is direct `pi` (no supervisor).
- Both panes get explicit kitty titles (see §2.5).

### 2.5 Kitty Pane Titles

| Pane | Title |
|------|-------|
| Mind | `mind-{cwd-hash}` (set via `kitty @ launch --title`) |
| Worker | `worker-{cwd-hash}` (set via `kitty @ launch --title`) |

### 2.6 Spawn Order

1. **Mind first** — launcher spawns mind (with supervisor).
2. **Wait for ready** — launcher polls every **200ms** (up to timeout, default 30s) checking both:
   - **Socket live:** file exists at `~/.pi/agent/mindworker/{hash}.sock` **and** launcher can connect to the Unix socket (probe open-close, no data sent).
   - **Generation match:** manifest `state` is `"running"` **and** `generation` equals the generation the launcher allocated for this spawn.
3. **Then worker** — spawn worker in right split via `kitty @ launch`.

### 2.7 Success Gate

Reset/startup is successful only when both hold:

- **Mind ready** (socket listening, generation matched — detected via §2.6 ready-check).
- **Worker connected** to mind over the socket for the same generation. Detected by launcher polling the control file (§6.2) for status `"worker-connected"`, timeout 10s after worker spawn.

If the gate fails (worker never connects or connects with wrong generation), the launcher reports failure. Mind stays up in mind role (see §9).

### 2.8 First Launch vs In-Place Reuse

- **First shortcut launch** — opens a fresh pair in a new kitty window/tab. Does not take over the user's current pane.
- **Subsequent launch when pair already exists** — resets in-place (kills old, spawns new in same panes).

---

## 3. Identity & Generation Fencing

### 3.1 CWD Canonicalization

Before any identity computation, the cwd is canonicalized:

```javascript
cwd = realpath(process.cwd())
```

This eliminates symlink mismatches between panes (e.g., `/home/user/proj` vs `/home/user/link-to-proj`).

### 3.2 Manifest JSON

Single manifest file per cwd hash:

```
~/.pi/agent/mindworker/{hash}-manifest.json
```

```json
{
  "cwd": "/home/user/project",
  "cwdHash": "a1b2c3d4",
  "generation": 7,
  "mindSupervisorPid": 12344,
  "mindChildPid": 12345,
  "workerPid": 12346,
  "mindPaneId": "kitty-pane-abc",
  "workerPaneId": "kitty-pane-def",
  "mindRole": "mind",
  "workerRole": "worker",
  "mindSessionDir": "/home/user/.pi/agent/sessions/mind-a1b2c3d4",
  "workerSessionDir": "/home/user/.pi/agent/sessions/worker-a1b2c3d4",
  "state": "running",
  "lastUpdated": 1715000000000,
  "startedAt": 1715000000000
}
```

- Written by launcher on spawn.
- Refreshed by both mind and worker processes (pid metadata updated). The supervisor writes its own pid and the mind child pid.
- Read by launcher on reset to identify pids, pane IDs, and session dirs to clean.
- Includes role-specific session dir paths so cleanup phase knows exactly which directories to delete.
- Generation starts at 1, incremented by launcher on each reset.

#### Field Ownership

| Field | Owner | When written |
|-------|-------|-------------|
| `cwd` | Launcher | On spawn, before mind starts |
| `cwdHash` | Launcher | On spawn |
| `generation` | Launcher (initial), Mind (confirms) | Launcher writes on spawn; mind refreshes once socket listening |
| `mindSupervisorPid` | Launcher | After supervisor created |
| `mindChildPid` | Supervisor | After mind child spawned |
| `workerPid` | Launcher | After worker spawned |
| `mindPaneId` | Launcher | On spawn |
| `workerPaneId` | Launcher | On worker spawn (empty during mind-only phase) |
| `mindRole` | Launcher | On spawn, constant |
| `workerRole` | Launcher | On spawn, constant |
| `mindSessionDir` | Launcher | On spawn |
| `workerSessionDir` | Launcher | On spawn |
| `state` | Launcher (initial), Mind (signals ready) | Launcher sets `"starting"`; mind sets `"running"` once socket listening |
| `lastUpdated` | Any writer | On every manifest write |
| `startedAt` | Launcher | On spawn, immutable |

#### State Enum

| State | Meaning |
|-------|--------|
| `starting` | Manifest written, supervisor/mind launched. Not yet ready. |
| `running` | Mind listening on socket, generation confirmed. Worker may or may not be connected. |
| `stopped` | Pair has been stopped/killed. Manifest will be deleted by cleanup. |

#### Manifest Lifecycle Across Reset

```
1. Launcher reads old manifest → captures generation N
2. Launcher increments to N+1   → held in memory
3. Stop phase                   → processes killed
4. Cleanup phase                → old manifest deleted
5. Spawn phase                  → launcher writes new manifest with gen N+1, state "starting"
6. Mind boots                   → reads manifest, writes pid, changes state to "running"
7. Launcher detects ready       → sees state "running" + generation N+1
```

The generation counter is held in launcher process memory between cleanup and spawn. It is never stored outside the manifest file.

### 3.3 Generation Fencing

- Every reset increments the **generation counter** in the manifest.
- The mind instance writes its generation into the manifest once the socket is listening.
- The launcher, before spawning worker, reads the manifest to confirm the generation.
- The worker, on connect, validates it is talking to the right generation.
- Stale workers connecting to a new-generation mind are rejected.
- Stale socket files from prior generations are cleaned during the cleanup phase of reset.

---

## 4. Reset Protocol

### 4.1 Trigger Sources

Two trigger sources, same orchestrator:

| Source | Mechanism | Behavior |
|--------|-----------|----------|
| `/mind-reset` command | Mind extension directly invokes launcher script: `mind-worker-launcher --reset --cwd {cwd}`. Launcher reads manifest, proceeds with reset protocol (§4.2–§4.4). | Calls orchestrator with current cwd. |
| Kitty shortcut | Keybinding invokes orchestrator script directly | Always starts fresh pair (or resets in-place if pair exists) |

### 4.2 Hard Phase Barriers

Reset proceeds through strict sequential phases — no overlap:

```
┌─────────────────┐
│ 1. Stop phase   │  SIGTERM → SIGKILL fallback to both processes
├─────────────────┤
│ 2. Cleanup      │  Delete all artifacts for this cwd hash
├─────────────────┤
│ 3. Spawn        │  Mind (supervisor) → wait ready → Worker
├─────────────────┤
│ 4. Verify       │  Success gate: both connected, same generation
└─────────────────┘
```

### 4.3 Stop Phase

Control file `command` field is the **primary trigger** for the supervisor. Signals are **escalation only** after timeout.

1. Read pids from manifest (`mindSupervisorPid`, `mindChildPid`, `workerPid`).
2. Write `{ command: "stop", generation: N }` to control file (§6.2).
3. Send **SIGTERM** to worker (`workerPid`) directly (no supervisor).
4. Poll control file up to `resetTimeout` (default 5s) for `status == "child-stopped"` (§6.2 supervisor stop sequence).
   - If observed: supervisor acknowledged, mind child stopped.
   - On timeout: send **SIGTERM** to supervisor (`mindSupervisorPid`) as escalation. Poll briefly (1s). If still no ack, send **SIGKILL** to supervisor.
5. If worker still alive after `resetTimeout`, send **SIGKILL** to worker.
6. Close kitty pane for worker (old pane destroyed, new one created in spawn phase).
7. Proceed to cleanup phase (§4.4).

### 4.4 Cleanup Phase

Delete **all** artifacts scoped to this cwd hash:

| Artifact | Path Pattern |
|----------|-------------|
| Socket | `~/.pi/agent/mindworker/{hash}.sock` |
| Plan file | `~/.pi/agent/mindworker/{hash}-plan.md` |
| Manifest | `~/.pi/agent/mindworker/{hash}-manifest.json` |
| Temp outputs | `/tmp/mindworker-{hash}-*.json` |
| Mind session dir | Entire `~/.pi/agent/sessions/mind-{hash}/` |
| Worker session dir | Entire `~/.pi/agent/sessions/worker-{hash}/` |

**Delete entire role-specific session dirs** (not just contents) — ensures fresh boot semantics. Old chat history, tool state, and session metadata are gone. The new session dir is created fresh by the launcher on spawn.

#### Generation Lifecycle Across Cleanup

The manifest (including generation counter) is deleted during cleanup, but the generation is **not lost**:

1. Before cleanup, launcher reads old manifest → captures generation N.
2. Launcher increments to N+1 in memory.
3. Cleanup deletes old manifest.
4. At spawn phase, launcher writes a new manifest with generation N+1.

The generation counter is held in launcher process memory between cleanup and spawn. See §3.2 for the full manifest lifecycle.

### 4.5 Busy During Reset

If mind is mid-task when `/mind-reset` is triggered:

1. Show confirmation: "Mind is busy. Reset anyway?"
2. If confirmed, proceed with stop → cleanup → spawn (same path).

---

## 5. Session Model

### 5.1 Role-Specific Sessions

Mind and worker have separate session directories, passed via `--session-dir`:

```
~/.pi/agent/sessions/mind-{hash}/   (mind's session)
~/.pi/agent/sessions/worker-{hash}/ (worker's session)
```

These are full Pi session directories managed by Pi's SessionManager.

### 5.2 Fresh Boot Semantics

On launcher-mediated start:

- **No restore** of old session (session dir freshly created).
- **No `session_start` role restore** (legacy code path skipped when `--mind-worker-role` is set).
- **Clean tools, clean socket, clean state.**

The `session_start` hook that reads `mind-worker-role` from session metadata and re-instates delegate tool, socket listener, etc. fires **only** on the legacy path (no `--mind-worker-role` flag).

### 5.3 Legacy Restore (Manual Path Only)

The existing `session_start` role restore is kept **only** for the legacy manual path:

- User runs `/be-mind` in a previously mind-active session.
- Extension reads `mind-worker-role` entry from session metadata.
- Re-creates delegate tool, socket listener, and server state.

On the launcher path this restore is explicitly skipped.

---

## 6. Mind Supervisor

### 6.1 Purpose

The mind pane is wrapped by a supervisor because:

- On reset, the old mind must exit before cleanup runs. Supervisor kills child and reports clean exit.
- Supervisor maintains the mind pane across resets — launcher kills old mind, supervisor acknowledges, launcher spawns new mind (same or new pane depending on reset type).
- Supervisor detects unexpected mind exit and either restarts or reports.

### 6.2 Control Mechanism

Supervisor communicates with launcher and mind extension via a JSON control file.

**Path:** `~/.pi/agent/mindworker/{hash}-mind-control.json`

#### Schema

```json
{
  "generation": 7,
  "command": "",
  "status": "",
  "message": "",
  "lastUpdated": 1715000000000
}
```

| Field | Type | Written by | Description |
|-------|------|------------|-------------|
| `generation` | number | Any writer | Generation counter from manifest. Fences stale control files from prior resets. |
| `command` | string | Launcher | Pending action for supervisor. Empty string when idle. |
| `status` | string | Supervisor / Mind extension | Current state of mind/supervisor. |
| `message` | string | Any writer | Human-readable detail (error info, reason). Optional. |
| `lastUpdated` | number | Any writer | Unix epoch ms of last write. |

#### Command Values (launcher → supervisor)

Written into `command` field:

| Command | Meaning |
|---------|--------|
| `"stop"` | Supervisor: kill your mind child process. Do not restart. |
| `""` (empty string) | No pending command. |

#### Status Values (supervisor / mind extension → launcher)

Written into `status` field:

| Status | Source | Meaning |
|--------|--------|---------|
| `"waiting"` | Supervisor | Supervisor alive, child running normally. |
| `"ready"` | Mind extension | Mind listening on socket, generation acknowledged. Equivalent to manifest state `"running"`. |
| `"busy"` | Mind extension | Mind processing a delegate task. Reset requires user confirmation (§4.5). |
| `"child-stopped"` | Supervisor | Mind child has exited (expected or crash). Acknowledges launcher's `"stop"` command. |
| `"worker-connected"` | Mind extension | Worker connected over socket with correct generation. Used for success gate (§2.7). |
| `"error"` | Either | Something went wrong. `message` field carries details. |
| `""` (empty string) | Startup | Not yet initialized. |

#### Status Ownership Stages

To prevent concurrent writes to `status`, ownership switches by protocol phase:

| Phase | Owner | Details |
|-------|-------|--------|
| **Normal** (`command` empty) | Mind extension | Supervisor writes `"waiting"` once at startup only (before mind extension begins writing). Mind extension owns all operational statuses (`"ready"`, `"busy"`, `"worker-connected"`). |
| **Stopping** (`command` = `"stop"`) | Supervisor only | Once launcher writes `command: "stop"`, mind extension **must stop writing** `status`. Supervisor writes `"child-stopped"` after child exits. |
| **Error** | Either | Rare/exceptional. Race acceptable; launcher treats any observed `"error"` as terminal. |

The launcher signals phase transition by writing `command`. Before reading `status`, the launcher always confirms the phase via `command` + `generation` to ensure it sees status from the correct owner.

#### Polling

- **Launcher** polls control file every **200ms** when waiting for supervisor/mind acknowledgement ("child-stopped", "worker-connected").
- **Supervisor** polls control file every **200ms** for incoming commands.
- **Mind extension** writes status updates on relevant events (ready, busy, worker-connected).
- Default timeout for any poll: **5s** (matching `resetTimeout`) unless otherwise noted.

#### Write Safety

- **Atomicity:** control file is written atomically (write to `{path}.tmp`, `rename()` to final path). Readers see a complete JSON object or nothing.
- **Generation fencing:** both launcher and supervisor check the `generation` field matches their current generation before acting on `command` or `status`. This prevents stale reads from prior reset cycles.
- **Stage-based ownership:** `status` ownership switches by protocol phase (see Status Ownership Stages above). During Normal phase only mind extension writes; during Stopping phase only supervisor writes. This ensures no concurrent writes to `status` despite two possible writers.

#### Supervisor Stop Sequence

The control file `command` field is the **primary trigger**. Signals are **escalation only** when the supervisor fails to acknowledge in time.

```
1. Launcher writes { command: "stop", generation: N } to control file.
2. Launcher polls for status == "child-stopped" (200ms interval, up to resetTimeout).
3. Normal path:
   a. Supervisor polls control file, reads "stop" command.
   b. Supervisor kills mind child (SIGTERM → SIGKILL, 3s grace).
   c. Supervisor waits for child exit, writes { status: "child-stopped", generation: N }.
   d. Launcher observes "child-stopped" → proceeds to cleanup.
4. Timeout path (no "child-stopped" after resetTimeout):
   a. Launcher sends SIGTERM to supervisor (mindSupervisorPid) as escalation.
   b. Poll briefly (1s) — supervisor may still write "child-stopped" after signal.
   c. If still no acknowledgement, send SIGKILL to supervisor.
   d. Proceed to cleanup.
```

**Key invariant:** the supervisor must read `command` and write `status` before it handles any signal. The launcher always polls first and signals only on timeout.

#### Reset Trigger Sequence (`/mind-reset`)

```
1. User types /mind-reset in mind TUI.
2. Mind extension checks control file status. If "busy", shows confirmation dialog (§4.5).
3. If confirmed (or not busy), mind extension invokes launcher script directly:
   mind-worker-launcher --reset --cwd {cwd}
4. Launcher reads manifest, proceeds with stop/cleanup/spawn per §4.2–§4.4.
```

### 6.3 Lifecycle

- **First boot:** Launcher creates supervisor process → supervisor spawns `pi --mind-worker-role mind --session-dir ...`.
- **Normal operation:** Supervisor is transparent — output and input pass through.
- **Reset signal:** Launcher tells supervisor → supervisor kills child → reports done → launcher spawns new mind.
- **Mind crashes:** Supervisor exits with child (unless explicit reset/relaunch in progress).
- **All launcher-created mind panes use supervisor** from first boot onward.

---

## 7. Worker Lifecycle

- Worker pane is **direct `pi`** (no supervisor).
- Worker lifecycle for reset: **close old worker pane → create fresh right split** with new worker.
- Worker pane is **monitor-only / read-only**:
  - Hard input block (keyboard input ignored).
  - Visually distinct with explicit title `worker-{hash}`.
  - User watches worker progress, cannot type into it.
- **Role-flag worker exits immediately on disconnect** from mind.
- **Role-flag mind stays up** if worker disconnects (shows "Worker disconnected" message, continues in mind role).

---

## 8. Model Selection on Reset

On reset, both instances use their **role-default models from config** (`~/.pi/agent/mind-worker.json`):

- `mindModel` → applied to mind instance.
- `workerModel` → applied to worker instance.

Applied as `--model` or through default model config on the spawned pi process.

---

## 9. Failure Policy

| Scenario | Behavior |
|----------|----------|
| **Worker spawn fails after mind started** | Mind stays up in mind role. Show failure message. Stop. |
| **Mind spawn fails** | Show failure message. Stop. No worker attempt. |
| **Worker connects with wrong generation** | Worker rejected. Show error. Kill worker pane. Retry or stop. |
| **Mind socket never becomes ready** | Timeout. Show failure. Kill mind. Stop. |
| **Reset kill phase fails** | Log error. Force SIGKILL. If impossible, abort reset. |

**General principle:** show failure and stop. Do not silently fall back to degraded mode (except mind-without-worker, which is a valid state).

---

## 10. Focus After Reset

After a successful reset (both panes ready), focus is returned to the **mind pane** so the user can immediately start typing.

---

## 11. Deprecated Features (Legacy Path)

These features from the original design are kept for backward compatibility but **not** used in the launcher path:

| Feature | Status | Replacement |
|---------|--------|-------------|
| `/be-mind` command | Deprecated | Launcher spawns both roles |
| `/be-worker` command | Deprecated | Launcher spawns both roles |
| `/stop-mind` command | Deprecated | `/mind-reset` or launcher kill |
| `/stop-worker` command | Deprecated | `/mind-reset` or launcher kill |
| `autoSpawnWorker` config | Deprecated | Launcher handles both |
| `delegate.reset` param | Removed from public docs/schema | Hard respawn supersedes |
| `session_start` role restore | Kept, legacy-only | Only fires when `--mind-worker-role` absent |
| Role transition (in-place mutate) | Kept, legacy-only | Fresh instances via launcher |

---

## 12. Configuration Additions

Additions to `~/.pi/agent/mind-worker.json`:

```json
{
  "mindModel": "anthropic/claude-opus-4-5",
  "workerModel": "anthropic/claude-sonnet-4",
  "timeout": 120,
  "resetTimeout": 5,
  "kittyEnabled": true
}
```

- `resetTimeout`: seconds to wait before SIGKILL during reset kill phase (default 5).
- `kittyEnabled`: false if user does not use kitty (v1 only currently).

---

## 13. Summary of Resolved Decisions

| # | Decision |
|---|----------|
| 1 | **Explicit role flag:** `--mind-worker-role mind\|worker` passed by launcher on spawn. |
| 2 | **Hard respawn reset:** kill both, clean, re-spawn fresh. No in-process re-init. |
| 3 | **Fresh boot semantics:** role-flag boot ignores old restore and chat history for this cwd. |
| 4 | **Split sessions via flag:** launcher passes role-specific `--session-dir`. |
| 5 | **External orchestrator:** launcher script owns reset/start. Scoped to current cwd pair only. |
| 6 | **Unified trigger:** `/mind-reset` and kitty shortcut call same orchestrator. |
| 7 | **Graceful kill:** SIGTERM first, SIGKILL fallback. Full pair-scoped artifact delete before respawn. |
| 8 | **Failure policy:** show failure and stop. Worker spawn fails → mind stays up in mind role. |
| 9 | **PID + pane tracking:** single manifest JSON per cwd hash. Generation fencing. |
| 10 | **Metadata refresh:** both launcher and processes update pid metadata in manifest. |
| 11 | **Terminal:** kitty-only v1. |
| 12 | **Focus:** mind pane after respawn. |
| 13 | **Model on reset:** role-default models from config applied to fresh instances. |
| 14 | **Busy handling:** confirm then reset anyway. |
| 15 | **Cleanup scope:** delete entire role-specific session dirs for this cwd hash, not just content. |
| 16 | **No auto-spawn:** role-flag boot never auto-spawns worker. Launcher spawns both directly. |
| 17 | **Legacy commands kept but deprecated:** `/be-mind`, `/be-worker`, `/stop-mind`, `/stop-worker`. |
| 18 | **Session restore:** legacy-only. Fires only when `--mind-worker-role` is absent. |
| 19 | **`delegate.reset` removed:** no longer part of public schema or doc story. |
| 20 | **Worker pane monitor-only:** hard input block, explicit kitty title, visually distinct. |
| 21 | **Disconnect:** role-flag worker exits immediately on disconnect. Role-flag mind stays up. |
| 22 | **Kitty titles:** `mind-{hash}` and `worker-{hash}` set via `--title`. |
| 23 | **Launcher form:** thin shell wrapper over shared TS helper. |
| 24 | **Shortcut:** always starts fresh pair (or resets in-place if pair exists). |
| 25 | **Phase barriers:** strict sequential: old pair exits → cleanup finishes → new pair starts. |
| 26 | **Worker pane:** direct `pi` (no supervisor). |
| 27 | **Mind pane:** supervisor/wrapper from first boot for all launcher-created instances. |
| 28 | **Supervisor lifecycle:** exits with child unless explicit reset/relaunch. |
| 29 | **CWD identity:** canonicalize with `realpath` before hashing. |
| 30 | **Worker position:** right split. |
| 31 | **First launch:** opens new pair. In-place reuse only after pair already exists. |
| 32 | **Spawn order:** mind first, wait until socket live + manifest generation matches, then spawn worker. |
| 33 | **Success gate:** mind ready + worker connected, same generation. |
| 34 | **Mind supervisor control:** control file + signal. Supervisor owns whole mind-side reset. |
| 35 | **Worker reset lifecycle:** close old worker pane, create fresh right split. |
