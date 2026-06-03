Labels: needs-triage

## What to build

Implement deterministic failure handling for all spawn and reset scenarios. The launcher must not silently degrade — it reports failures clearly and stops, with one exception: mind-without-worker is a valid operational state.

**Failure scenarios and behaviour:**

| Scenario | Behaviour |
|----------|-----------|
| **Worker spawn fails after mind is ready** | Mind stays up in mind role. Clear failure message shown in mind TUI. No auto-retry. |
| **Mind spawn fails** | Abort immediately. Do NOT spawn worker. Show failure message. No auto-retry. |
| **Worker connects with wrong generation** | Worker rejected. Kill worker pane. Show error. Retry or stop (configurable). |
| **Mind socket never becomes ready** | Timeout after 30s. Kill mind. Show failure. Stop. No half-initialized pair. |
| **Reset kill phase fails** | Log error. Force SIGKILL on supervisor and worker. If SIGKILL impossible, abort reset with error. |
| **Worker exits unexpectedly after success gate** | Mind detects disconnect (issue 004). Shows "Worker disconnected". Stays up. No auto-respawn. |
| **Mind crashes during normal operation** | Supervisor detects exit (issue 005). Writes `"error"` status. Launcher notified (or user notified via mind pane). |

**Error reporting mechanism:**
- Launcher writes error details to stderr.
- For launcher-triggered actions (reset), failure messages appear in the mind TUI via a control file status write.
- For `/mind-reset` triggered failures, the launcher exit code and stderr are captured by the mind extension and shown in the TUI footer.
- The launcher returns non-zero exit codes for all failure scenarios, with distinct exit codes by failure type.

## Acceptance criteria

- [ ] Worker spawn failure after mind ready: mind stays up in mind role, failure message shown, no auto-retry
- [ ] Mind spawn failure: aborted immediately, no worker attempted, clear failure message
- [ ] Worker connects with wrong generation: rejected, worker pane killed, error shown
- [ ] Mind socket timeout (30s): mind killed, failure shown, no half-initialized pair
- [ ] Reset kill phase failure: forced SIGKILL, abort on impossible, error logged
- [ ] Worker exits unexpectedly after success gate: mind shows "Worker disconnected", stays up in mind role
- [ ] Mind crashes during normal operation: supervisor detects and reports via control file `status: "error"`
- [ ] All errors produce distinct non-zero exit codes from launcher
- [ ] Failure messages are user-visible (mind TUI footer or terminal stderr)

## Blocked by

- `006-mind-reset-does-fenced-clean-respawn.md`
