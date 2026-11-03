# pi coding agent config

Clone to `~/.pi/agent` and pi reads settings, extensions, skills, prompt templates, and themes automatically.

## Quick start

```bash
git clone <this-repo> ~/.pi/agent
pi
```

## Mind-worker hosting (mindmux)

Mind and its workers are hosted by `mindmux`, a separate Go supervisor that is not part of this
repository: this repo carries only the Pi extension. Install the binary on `PATH` (it is built from
`~/work/mindmux` and currently lives at `~/.local/share/go/bin/mindmux`) and bind it in tmux. The
dotfiles binding is `C-a p` in the invoking pane's session (`tmux.conf:73`):

```tmux
bind p run-shell -c '#{pane_current_path}' 'TMUX_PANE=#{pane_id} mindmux start >/dev/null'
```

- `mindmux start [--force]` starts or focuses the one Mind for that tmux session.
- `printf '%s' "$TEXT" | mindmux send` appends to that Mind's editor draft and never submits it.
- `mindmux check-stopped --cwd "$PWD"` is the read-only worktree/directory-removal safety guard: it
  answers whether this directory may be removed, and stops nothing itself.

`mindmux` owns placement, generations and process lifetime, and passes `MINDMUX_*` plus the
`PI_MIND_WORKER_*` role identity into every process it launches. The extension keeps what it always
did — task scheduling, delegation to workers and their results — and speaks the adapter socket plus
the private draft socket. There is no `hc` (Herdr core) or launcher-managed `tmux` fallback in the
TypeScript: with no adapter env, no pool is pinned and burst spawns are refused.

Manual `/be-mind` / `/be-worker` role restore remains available. The remaining legacy files are
intentional remnants: `bin/mind-worker-launcher` is only a `mindmux` compatibility shim, and
`tmux-cleanup.mjs` is only a read-only legacy removal guard.

Pools started by the retired launcher are not adopted: quit their Mind normally, then start the
session with `mindmux start`. Nothing in this repo stops or kills a process for you.

`PI_CODING_AGENT_DIR` relocates the agent dir (state, config, sessions) together, following pi's
`getAgentDir`: a literal `~` or `~/` expands and the value is never trimmed. A relative or
`file://` value is refused before anything is written.

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
