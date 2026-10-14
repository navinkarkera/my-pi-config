Labels: needs-triage

## What to build

Implement the `/mind-reset` command and the full reset protocol: stop → cleanup → spawn → verify. This is the core orchestrator logic that hard-respawns a mind-worker pair with generation fencing, atomic phase barriers, and full artifact cleanup.

**Trigger:** The `/mind-reset` command in the mind TUI invokes the launcher script directly:
```
mind-worker-launcher --reset --cwd {cwd}
```

**Reset protocol (strict sequential phases):**

1. **Stop phase:**
   - Read manifest for pids and pane IDs.
   - Write `{ command: "stop", generation: N }` to control file.
   - Send SIGTERM to worker pid directly.
   - Poll control file up to `resetTimeout` (default 5s) for `status == "child-stopped"`.
   - On timeout: escalate SIGTERM → SIGKILL to supervisor.
   - If worker alive after timeout: SIGKILL worker.
   - Close old worker kitty pane.

2. **Cleanup phase:**
   - Delete all artifacts for this cwd hash: socket, plan file, manifest, temp outputs, entire mind session dir, entire worker session dir.
   - Generation counter N held in launcher memory (not deleted).

3. **Spawn phase:**
   - Increment generation to N+1 (in memory).
   - Write new manifest with generation N+1, state `"starting"`.
   - Spawn mind (with supervisor) in left kitty pane (reuse pane if available, else new).
   - Wait for ready (socket + generation match — same poll as issue 003).
   - Spawn worker in new right kitty split.

4. **Verify phase (success gate):**
   - Both mind ready + worker connected, same generation N+1.
   - Success: focus mind pane.
   - Failure: report error per failure policy (issue 008).

**Busy handling:** If mind is mid-task (`status: "busy"` in control file), show confirmation dialog before proceeding.

**After-reset focus:** Focus returns to mind pane.

## Acceptance criteria

- [ ] `/mind-reset` in mind TUI invokes launcher with `--reset --cwd {cwd}` — exact command verified
- [ ] Reset follows strict sequential phases: stop → cleanup → spawn → verify — no overlap between phases
- [ ] Stop phase uses control file `command: "stop"` as primary trigger, polls for `"child-stopped"`, escalates to SIGTERM→SIGKILL on timeout (5s default)
- [ ] Cleanup deletes all artifacts for this cwd hash: socket, plan file, manifest, temp outputs, both session dirs
- [ ] Generation counter survives cleanup in launcher memory, incremented to N+1 before new manifest written
- [ ] New manifest written with generation N+1 and state `"starting"` before mind boots
- [ ] Old worker pane closed, fresh right split created for new worker
- [ ] Busy mind shows confirmation dialog before reset proceeds
- [ ] After successful reset, focus returns to mind pane

## Blocked by

- `004-monitor-only-worker-pane-lifecycle.md`
- `005-supervisor-control-file-protocol-with-atomic-generation-fencing.md`
