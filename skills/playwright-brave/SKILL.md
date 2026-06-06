---
name: playwright-brave
description: Controls Brave browser via playwright-cli for manual UI testing. Use when user needs to interact with a web app in Brave — inspect pages, click elements, fill forms, capture state, verify UI behavior. Requires playwright-cli and Playwright Extension installed in Brave. Handles attach-to-existing-tab workflow and follow-up browser commands.
compatibility: playwright-cli (>=0.1), Playwright Extension (mmlmfjhmonkocbjadbfplnigmagldckm) installed in Brave, Brave browser running
---

# Playwright + Brave Browser Control

## Requirements

- `playwright-cli` available on PATH
- [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) installed in Brave
- Brave must be running with the extension enabled
- **Brave Nightly** (or non-standard channels) requires two env vars before attach:

  ```bash
  export PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/brave-browser-nightly
  export PLAYWRIGHT_MCP_BROWSER=brave
  ```

  Adjust the executable path for your Brave install location.


## Workflow

### 1. Attach to Running Brave (preferred)

Use when user already has a browser tab open with the target app.

Export the required env vars (especially needed for Brave Nightly):

```bash
export PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/brave-browser-nightly
export PLAYWRIGHT_MCP_BROWSER=brave
playwright-cli attach --extension=brave
```

Output shows session name (default: `brave`) and current tab info.

If it fails, ask user to restart Brave and retry. Do not install or modify anything without explicit approval.

### 2. After Attach

All follow-up commands use the session flag:

```bash
playwright-cli -s=brave <command>
```

### 3. Follow-Up Commands

| Goal | Command |
|------|---------|
| Navigate to URL | `playwright-cli -s=brave goto <url>` |
| Full page snapshot | `playwright-cli -s=brave snapshot` |
| Partial snapshot | `playwright-cli -s=brave snapshot <selector>` |
| Click element | `playwright-cli -s=brave click <selector>` |
| Fill text field | `playwright-cli -s=brave fill <selector> <text>` |
| Select option | `playwright-cli -s=brave select <selector> <value>` |
| Check/radio | `playwright-cli -s=brave check <selector>` |
| Type text | `playwright-cli -s=brave type <text>` |
| Evaluate JS | `playwright-cli -s=brave eval '<code>'` |
| Run Playwright code | `playwright-cli -s=brave run-code <code>` |
| List tabs | `playwright-cli -s=brave tab-list` |
| Switch tab | `playwright-cli -s=brave tab-select <index>` |
| Save screenshot | `playwright-cli -s=brave screenshot` |
| List requests | `playwright-cli -s=brave requests` |
| Get response body | `playwright-cli -s=brave response-body <index>` |
| Console messages | `playwright-cli -s=brave console` |

### 4. Custom Playwright Code (`run-code`)

The function receives `page` as its single argument:

```javascript
playwright-cli -s=brave run-code 'async (page) => {
  const title = await page.title();
  return title;
}'
```

Load code from a file:

```bash
playwright-cli -s=brave run-code --filename script.js
```

### 5. Iframe Access

When elements are inside cross-origin iframes (common in MFEs), use `run-code`:

```javascript
playwright-cli -s=brave run-code 'async (page) => {
  const frames = page.frames();
  const iframe = frames[1]; // second frame is the iframe
  const text = await iframe.locator("selector").textContent();
  return text;
}'
```

### 6. Error Recovery

| Error | Action |
|-------|--------|
| `Playwright Extension not found` | Ask user to verify extension installed in Brave, restart Brave, retry. If using Brave Nightly, the extension profile lookup may need a symlink from `~/.config/google-chrome` to the Brave profile dir (e.g. `~/.config/BraveSoftware/Brave-Browser-Nightly/`). Do not auto-install anything. |
| `Browser not installed` | Report blocker to user. Ask user how to proceed. Do not install without explicit approval. |
| `Unsupported channel` | Brave channel not mapped in Playwright internals. Inform user. |

### 7. Safety Rules

- Never navigate away from user's current tab without explicit permission.
- If page context is unclear, ask user to hand off the correct tab.
- Do not save, submit, or mutate live app state until user approves.
- Read-only inspection and snapshotting are always safe.
- If terminal access is restricted, delegate browser commands to a worker via `delegate`.

## Example Session

```bash
# Set env vars for Brave Nightly (adjust path for your install)
export PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/brave-browser-nightly
export PLAYWRIGHT_MCP_BROWSER=brave

# Attach to already-open Brave
playwright-cli attach --extension=brave
# Session: brave

# Inspect current page
playwright-cli -s=brave snapshot

# Click a button by text
playwright-cli -s=brave click 'button:has-text("Edit")'

# Run custom code for iframe interaction
playwright-cli -s=brave run-code 'async (page) => {
  const frames = page.frames();
  const iframe = frames[1];
  const buttons = await iframe.locator("button").all();
  return buttons.length;
}'
```
