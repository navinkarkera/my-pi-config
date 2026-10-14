# Implementation Order — Mind-Worker Launcher/Reset

## Dependency Graph

```
001 (none)
  └─→ 002
        └─→ 003
              ├─→ 004
              └─→ 005
                    └─→ 006 ─┬─→ 007
                              ├─→ 008
                              └─→ 009
```

## Critical Path

**001 → 002 → 003 → (004 + 005 in parallel) → 006 → (007 + 008 + 009 in parallel)**

## Execution Order

### Phase 1: Foundation (sequential)

- [ ] **001** — `001-role-flag-fresh-boot-with-session-dir-isolation.md`
  - `--mind-worker-role` flag, `--session-dir`, skip legacy restore on boot
  - **Why first:** All subsequent slices depend on role-flag instances existing.
  - **No blockers.**

- [ ] **002** — `002-thin-launcher-spawns-canonical-kitty-pair.md`
  - Launcher shell script + TS helper, realpath cwd, kitty pane management, mind-first spawn
  - **Why second:** Needs role-flag instances (001) to spawn. Produces the pair framework.
  - **Blocked by:** 001.

- [ ] **003** — `003-manifest-backed-startup-success-gate.md`
  - Manifest JSON store, field ownership, state machine, generation counter, success-gate polling
  - **Why third:** Needs launcher (002) to write manifest. Both 004 and 005 depend on manifest.
  - **Blocked by:** 002.

### Phase 2: Parallel Lanes (can be done concurrently)

- [ ] **004** — `004-monitor-only-worker-pane-lifecycle.md`
  - Worker input block, generation validation on connect, exit-on-disconnect, mind-stays-up
  - **Why here:** Needs manifest (003) for generation validation. Independent of supervisor (005).
  - **Blocked by:** 003.

- [ ] **005** — `005-supervisor-control-file-protocol-with-atomic-generation-fencing.md`
  - Supervisor process, control file JSON, polling, stop sequence, atomic writes, status ownership
  - **Why here:** Needs manifest (003) for generation fencing. Independent of worker lifecycle (004).
  - **Blocked by:** 003.

### Phase 3: Integration (sequential, needs both parallel lanes)

- [ ] **006** — `006-mind-reset-does-fenced-clean-respawn.md`
  - Full reset protocol: stop → cleanup → spawn → verify, `/mind-reset` command
  - **Why here:** Needs worker lifecycle (004) for worker pane management during reset AND supervisor (005) for stop protocol.
  - **Blocked by:** 004 + 005.

### Phase 4: Parallel Outputs (can be done concurrently)

- [ ] **007** — `007-kitty-reset-shortcut-restores-mind-focus.md`
  - Kitty keybinding, injectable pane adapter, programmatic focus-mind after reset
  - **Blocked by:** 006.

- [ ] **008** — `008-deterministic-spawn-failure-recovery.md`
  - Failure handling for all spawn/reset scenarios, distinct exit codes, user-visible error reporting
  - **Blocked by:** 006.

- [ ] **009** — `009-config-defaults-and-legacy-path-parity.md`
  - Extended config schema, backward compat, legacy command preservation, model selection on reset
  - **Blocked by:** 006.

## Parallelization Strategy

| Phase | Issues | Parallel? | Why |
|-------|--------|-----------|-----|
| 1 | 001, 002, 003 | No | Strict chain — each produces input for next |
| 2 | 004, 005 | **Yes** | Independent modules (worker lifecycle vs supervisor/control) |
| 3 | 006 | No | Integrates both 004 and 005 |
| 4 | 007, 008, 009 | **Yes** | Independent concerns (shortcut vs failure vs config) |

## Recommended First Grab

**001** (`001-role-flag-fresh-boot-with-session-dir-isolation.md`) — no blockers, unblocks everything. Modify `mind-worker.ts` to add `--mind-worker-role` and `--session-dir` flag handling + gate `session_start` restore.
