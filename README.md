# pi coding agent config

Clone to `~/.pi/agent` and pi reads settings, extensions, skills, prompt templates, and themes automatically.

## Quick start

```bash
git clone <this-repo> ~/.pi/agent
pi
```

## Mind-worker launcher

`bin/mind-worker-launcher` is the supported pair launcher. It supports the `hc` (Herdr core) and `tmux` terminal backends. The backend is selected by `--backend hc|tmux`, then `terminalBackend` in `mind-worker.json`, then `hc`; the tracked config keeps `terminalBackend: "hc"` for backward compatibility, while the dotfiles `tmux-mind` entrypoint explicitly passes `--backend tmux`.

`PI_CODING_AGENT_DIR` relocates the agent dir (state, config, sessions and the cleanup guard's scan) together, following pi's `getAgentDir`: a literal `~` or `~/` expands and the value is never trimmed. A relative or `file://` value is refused before anything is written or scanned.

On tmux, the launcher is the root pane's direct program and runs in the invoking tmux session. The dotfiles `tmux-mind` entrypoint creates the Mind window; all static and burst workers share one `workers` window. A tmux pool is identified by a v3 record that carries the canonical root plus its exact tmux server, session and root-pane proof; global `pane-exited`, `after-kill-pane` and `window-unlinked` hooks invoke a cleanup guard that proves ownership before sweeping. The tmux backend never adopts or converts a v2/hc record, or a record from another server, session or root; it refuses instead of guessing.

The legacy Kitty pair launcher has been retired. Manual `/be-mind` / `/be-worker` role restore remains available, and the optional burst-worker Kitty path is unchanged.

## Authentication

Pi supports OAuth (`/login`) or API keys. Credentials are stored in `auth.json` — never commit this file.

```bash
pi
/login
# or
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

## Secrets

- `auth.json` — API keys / OAuth tokens (gitignored)
- `telegram.json` — Telegram bot tokens (gitignored)

Do not commit either file.

## Packages

Third-party extensions, skills, and prompts are declared in `settings.json` under `packages`. Pi auto-installs missing packages on startup when referenced from project `.pi/settings.json`. For global reinstall after a fresh clone:

```bash
pi install npm:pi-web-access
pi install npm:@codexstar/pi-listen
pi install npm:pi-nvim
pi install npm:@llblab/pi-telegram
```

Installed package caches live in `git/` and `npm/` — both gitignored.

## Ignored files

| Pattern | Reason |
|---------|--------|
| `auth.json`, `telegram.json` | Secrets |
| `git/`, `npm/` | Reinstallable package caches |
| `sessions/` | Conversation history (runtime state) |
| `tmp/` | Temp artifacts |
| `locks.json` | Runtime lock |
| `run-history.jsonl` | Runtime log |

## Local models

`models.json` defines an `lm-studio` provider pointing at `http://localhost:1234/v1`. The API key in that config is a dummy placeholder — LM Studio is a local server and ignores the key.
