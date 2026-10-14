Labels: needs-triage

## What to build

Extend the `~/.pi/agent/mind-worker.json` config schema with the new launcher-path fields while preserving full backward compatibility with the legacy command-based path. Ensure all legacy commands continue to work unchanged.

**Config schema additions (`mind-worker.json`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mindModel` | string | `"anthropic/claude-opus-4-5"` | Default model for mind instance on reset |
| `workerModel` | string | `"anthropic/claude-sonnet-4"` | Default model for worker instance on reset |
| `resetTimeout` | number | 5 | Seconds before SIGKILL escalation during reset stop phase |
| `kittyEnabled` | boolean | true | Whether to use kitty CLI for pane management |

**Backward compatibility:**
- Existing config files (with only `timeout`, `statusStream`, `autoSpawnWorker`, `workerTaskStrictness`, `notifyOnMindIdle`, `ntfyTopic`) load without error — missing fields use defaults.
- All four legacy commands (`/be-mind`, `/be-worker`, `/stop-mind`, `/stop-worker`) continue to work exactly as before. They do NOT depend on the new fields.
- The `autoSpawnWorker` field is deprecated but still honoured for the legacy path. The launcher path ignores it.

**Config loading:**
- Config loader reads `mind-worker.json` from `~/.pi/agent/`. If file is missing, creates it with all defaults and notifies user.
- Config is validated on load — invalid field types produce a logged warning and fallback to defaults.
- The launcher reads the config to determine `mindModel`, `workerModel`, `resetTimeout`, and `kittyEnabled` before spawn/reset.

**Integration with reset:**
- On reset (issue 006), the launcher applies `mindModel` to the new mind instance and `workerModel` to the new worker instance, passed via `--model` flag or default model selection.
- `resetTimeout` controls the stop phase escalation timeout.
- `kittyEnabled` controls whether the launcher calls kitty CLI or prints manual instructions.

## Acceptance criteria

- [ ] Config schema extended with `mindModel`, `workerModel`, `resetTimeout` (default 5), `kittyEnabled` (default true)
- [ ] Existing config files (without new fields) load with defaults — no crash, no error
- [ ] Missing `mind-worker.json` creates file with all defaults and notifies user
- [ ] All four legacy commands (`/be-mind`, `/be-worker`, `/stop-mind`, `/stop-worker`) work unchanged — no regression
- [ ] Legacy path ignores `mindModel`, `workerModel`, `resetTimeout`, `kittyEnabled` — only launcher path reads them
- [ ] Launcher reads config before spawn/reset and applies `mindModel`/`workerModel` to spawned instances
- [ ] `resetTimeout` controls stop-phase SIGTERM→SIGKILL escalation timeout in reset protocol
- [ ] `kittyEnabled` controls whether launcher invokes kitty CLI or prints manual instructions
- [ ] Invalid config field types produce logged warning with fallback to defaults

## Blocked by

- `006-mind-reset-does-fenced-clean-respawn.md`
