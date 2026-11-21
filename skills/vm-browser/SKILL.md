---
name: vm-browser
description: Drive the dedicated Brave profile on the Arch host through the VM's vm-browser MCP (mcp__vm_browser__*). Use when testing or inspecting a web app from inside the VM — listing tabs, snapshotting pages, clicking, filling forms, checking UI state. Not for everyday Brave, playwright-cli, extension attach, or browser setup.
---

# VM browser (dedicated Brave on the Arch host)

The `vm-browser` MCP server is the only browser channel. It drives a **dedicated, persistent Brave profile launched on the Arch host** by the host-side bridge session — not your everyday Brave. The browser reaches the **VM's localhost** through that bridge, so guest URLs like `http://local.openedx.io/` or `http://127.0.0.1:<port>` open from the host browser.

Tools are the Playwright MCP set, prefixed `mcp__vm_browser__` (e.g. `browser_tabs`, `browser_snapshot`, `browser_navigate`, `browser_click`, `browser_fill_form`, `browser_take_screenshot`, `browser_console_messages`).

## Workflow

1. **Inspect tabs first.** Call `browser_tabs` before acting. The bridge user usually has the app already open; drive that tab instead of opening a new one.
2. **Confirm when ambiguous.** If no tab clearly matches the app or page you need, ask which tab to use. Never navigate an existing tab away without explicit permission.
3. **Ask before mutating live state.** Read-only inspection (snapshot, screenshot, console, evaluate reads) is always fine. Clicking Save/Submit/Delete, enrolling, publishing, or anything that changes data needs the user's approval first.
4. **Work from snapshots.** Take `browser_snapshot` and target elements by role/name from it, rather than guessing selectors.
5. **Bridge down → stop and report.** If the `mcp__vm_browser__` tools are missing or calls fail to connect, say so plainly: the host-side bridge session is not running or lost its connection. Ask the user to start or reconnect it on the Arch host (`bash pi-vm-browser-bridge.sh start --alias <vm-alias>`) and wait. Do not retry in a loop.

## Don't

- No `playwright-cli`, no Playwright extension attach, no `notify-send` alerts.
- No fallback to the user's everyday Brave or any other browser.
- Don't launch, close, or reconfigure a browser yourself; don't install or set up anything (MCP entry, bridge, profile). The bridge session owns the browser lifecycle.
- Don't use this skill for unrelated setup work — SSH, ports, `mcp.json`, the bridge script itself.

## Example: inspect an already-open VM app tab

User: "what's on the catalog page right now?"

1. `mcp__vm_browser__browser_tabs` → see `http://local.openedx.io/...` tabs open.
2. Pick the matching tab and select it (or ask, if two could match).
3. `mcp__vm_browser__browser_snapshot` → read the page structure and report what is visible.
4. Only if the user asks for a change, confirm, then act (`browser_click`, `browser_fill_form`), and re-snapshot to verify.

Report the tab's URL and what you observed; note anything that looked stale or disconnected.
