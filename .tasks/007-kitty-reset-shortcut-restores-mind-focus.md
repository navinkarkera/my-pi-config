Labels: needs-triage

## What to build

Add a kitty keyboard shortcut that invokes the launcher directly (bypassing the mind TUI) to start or reset a mind-worker pair, and ensure focus returns to the mind pane after the reset completes.

**Kitty shortcut:**
- A keybinding in kitty config that runs the launcher script with the current working directory.
- The shortcut launches a fresh pair if none exists, or resets in-place if a pair already exists.
- Unlike `/mind-reset`, this shortcut does NOT check the control file for busy status (it's an external kill-and-restart). The launcher reads the manifest to detect existing pair.

**Focus after reset:**
- After the reset protocol completes (stop → cleanup → spawn → verify), the launcher (or the kitty pane adapter module) explicitly focuses the mind pane.
- Focus is restored programmatically via `kitty @ focus-window --match title:mind-{hash}` or similar kitty remote control command.
- The user sees the mind pane active with cursor ready for input immediately after reset.

**Pane management:**
- The kitty pane adapter module abstracts all kitty CLI operations: launching windows/tabs, splitting panes, setting titles, closing panes, focusing panes.
- The adapter is injectable so it can be stubbed in tests or replaced if `kittyEnabled` is false.
- On in-place reset, the adapter reuses the existing mind pane (the supervisor holds it) and replaces the worker pane with a fresh right split.

## Acceptance criteria

- [ ] Kitty shortcut binding invokes launcher with current cwd — fresh pair if none, reset in-place if pair exists
- [ ] Shortcut works when typed in any kitty pane (not just mind pane)
- [ ] After reset, focus programmatically returns to mind pane via kitty remote control
- [ ] Mind pane is active with cursor ready — user can type immediately
- [ ] Kitty pane adapter module abstracts all kitty CLI operations: launch, split, close, focus, set-title
- [ ] Adapter is injectable — can be stubbed for tests or when `kittyEnabled` is false
- [ ] On in-place reset: old mind pane reused (supervisor stays), old worker pane closed, new worker pane created

## Blocked by

- `006-mind-reset-does-fenced-clean-respawn.md`
