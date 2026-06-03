Labels: needs-triage

## What to build

Add a `--mind-worker-role mind|worker` CLI flag and `--session-dir <path>` flag to Pi so that when the launcher spawns an instance, it boots fresh with role-specific behavior, isolated session storage, and no legacy restore.

When `--mind-worker-role` is present:
- The `session_start` role-restore hook (which normally re-instates delegate tool, socket listener, and server state from session metadata) is **skipped entirely** — the instance boots with zero old state.
- The provided `--session-dir` overrides the session storage path, replacing the default cwd-based session path.
- Legacy `/be-mind` and `/be-worker` paths (no flag) continue to use `session_start` restore as before.

When `--mind-worker-role worker` is present, the extension also enables monitor-only input suppression (note: hard input block itself is tracked in issue 004; this issue covers only the detection of `--mind-worker-role` and the gating of worker-specific hooks).

When `--mind-worker-role mind` is present, the extension writes `"ready"` to the control file once the delegate tool and socket listener are initialized (the control file schema is tracked in issue 005; this issue covers only the status-write call site).

The flag check lives in the existing `mind-worker.ts` extension, modifying the `before_agent_start` and `session_start` hook implementations.

## Acceptance criteria

- [ ] `--mind-worker-role mind` causes extension to skip `session_start` role restore — no delegate tool or socket re-created from old session metadata
- [ ] `--mind-worker-role worker` causes extension to skip `session_start` role restore — no worker listener re-created from old session
- [ ] Both roles use `--session-dir` value for their Pi session store instead of the default cwd-based path
- [ ] Fresh boot shows zero old chat history, tool state, or socket state — clean session dir
- [ ] Legacy path (no `--mind-worker-role` flag) continues to fire `session_start` role restore exactly as before — no regression
- [ ] Missing `--session-dir` falls back to default session path (backward compat)

## Blocked by

None — can start immediately
