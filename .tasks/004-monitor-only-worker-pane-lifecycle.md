Labels: needs-triage

## What to build

Implement the monitor-only worker pane lifecycle. When a Pi instance is launched with `--mind-worker-role worker`, its TUI becomes read-only — all keyboard input is suppressed while output remains visible. The worker also manages its own lifecycle: it validates the generation on connect, exits immediately on socket disconnect from the mind, and has an explicit kitty title.

**Monitor-only TUI:**
- All keyboard input in the worker pane is ignored (no keystrokes reach Pi's event loop).
- Worker output (status messages, tool results, bash stdout) is rendered normally for the user to watch.
- The pane has an explicit kitty title `worker-{hash}` set by the launcher (from issue 002). The extension does not override this.

**Generation validation on connect:**
- When the worker connects to the mind's Unix socket, it reads the current generation from the manifest and sends it as part of the handshake.
- If the generation does not match what the worker expects (passed by the launcher), the connection is rejected and the worker exits with an error message.
- This prevents a slow-to-start worker from a prior reset accidentally connecting to a new mind.

**Disconnect behaviour:**
- The role-flag worker monitors the socket for disconnect. On EOF or error from the mind socket, the worker exits immediately (calls `process.exit(0)` or similar).
- It does NOT enter a poll-retry loop — the launcher handles respawn if needed.
- The role-flag mind, by contrast, stays up if the worker disconnects. It shows "Worker disconnected" in the TUI footer and continues in mind role (no auto-respawn).

## Acceptance criteria

- [ ] Worker pane with `--mind-worker-role worker` suppresses all keyboard input — keystrokes ignored, output still visible
- [ ] Worker pane shows explicit title `worker-{hash}` (set by launcher, not overridden by extension)
- [ ] Worker validates generation on socket connect — rejects mismatched generation with error message and exit
- [ ] Worker exits immediately (within 1s) on mind socket disconnect — no poll-retry loop
- [ ] Mind instance stays up on worker disconnect — shows "Worker disconnected" status, retains mind role and delegate tool
- [ ] Legacy path (no `--mind-worker-role`) keeps old behaviour: worker enters poll-retry loop on disconnect

## Blocked by

- `003-manifest-backed-startup-success-gate.md`
