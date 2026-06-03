# pi coding agent config

Clone to `~/.pi/agent` and pi reads settings, extensions, skills, prompt templates, and themes automatically.

## Quick start

```bash
git clone <this-repo> ~/.pi/agent
pi
```

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

## Mind-worker launcher

`bin/mind-worker-launcher` and its runtime files (`mind-worker-launcher.mjs`,
`kitty-adapter.mjs`, `supervisor.mjs`) are vendored under
`lib/mind-worker/` — safe to commit and portable across clones.

The `git/mind-worker-rebuild/` directory is a reinstalled package cache.
Scripts that hardcode paths into `git/` will break on a fresh clone.
All tracked runtime paths resolve under `lib/` instead.

## Ignored files

| Pattern | Reason |
|---------|--------|
| `auth.json`, `telegram.json` | Secrets |
| `git/`, `npm/` | Reinstallable package caches |
| `sessions/` | Conversation history (runtime state) |
| `tmp/` | Temp artifacts |
| `locks.json` | Runtime lock |
| `run-history.jsonl` | Runtime log |
| `mindworker/*.{sock,mind-control,manifest,plan,pending}*` | Worker ephemeral state |

`mind-worker.json` at repo root is portable config — not ignored.

## Local models

`models.json` defines an `lm-studio` provider pointing at `http://localhost:1234/v1`. The API key in that config is a dummy placeholder — LM Studio is a local server and ignores the key.
