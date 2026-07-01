#!/usr/bin/env node

// herdr-launcher.mjs — Launch mind + TUI workers via herdr panes.
// Called by bin/mind-worker-launcher when terminalBackend == "herdr".
// Workers run as TUI (not --mode rpc). Mind-worker extension
// (PI_MIND_WORKER_ROLE env) handles lifecycle via control-file protocol.
//
// Uses only herdr-skill-documented commands: pane list, pane split, pane run, pane close.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  unlinkSync, rmSync, readdirSync, realpathSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";

// ── Guard ──
if (env.HERDR_ENV !== "1") {
  console.error("ERROR: herdr-launcher must run inside a herdr-managed pane (HERDR_ENV=1)");
  process.exit(1);
}

// ── Paths ──
const AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT_DIR, "mindworker");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const CONFIG_FILE = join(AGENT_DIR, "mind-worker.json");
const PI_BIN = env.PI_BIN || "pi";

// ── Helpers ──

/** SHA-256 hash of cwd, first 16 hex chars. Matches JS launcher. */
function getCwdHash(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

const getManifestPath = (h) => join(STATE_DIR, `${h}-manifest.json`);
const getControlPath  = (h) => join(STATE_DIR, `${h}-mind-control.json`);
const workerSessDir   = (h, i) => join(SESSIONS_DIR, `worker-${h}-${i}`);
const ensureDir       = (p) => { if (!existsSync(p)) mkdirSync(p, { recursive: true }); };

// ponytail: single-quote wrapper for target-pane shell escaping.
// Wraps value in single quotes; escapes any embedded single quotes.
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Wrap mkdir in a promise so we don't need extra imports. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── herdr CLI (spawnSync, no local shell) ──

function herdr(args, opts = {}) {
  const r = spawnSync("herdr", args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout ?? 15000,
    encoding: "utf-8",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || "").trim() || `exit code ${r.status}`;
    throw new Error(`herdr ${args[0]}: ${msg}`);
  }
  return (r.stdout || "").trim();
}

function herdrPaneSplit(targetPane, direction) {
  const raw = herdr(["pane", "split", targetPane, "--direction", direction, "--no-focus"]);
  return JSON.parse(raw).result.pane.pane_id;
}

function herdrPaneRun(paneId, command) {
  herdr(["pane", "run", paneId, command], { timeout: 10000 });
}

function herdrPaneClose(paneId) {
  try { herdr(["pane", "close", paneId], { timeout: 5000 }); } catch { /* best-effort */ }
}

// ── Find focused pane ──

function deepFindFocused(obj) {
  if (obj && typeof obj === "object") {
    if (obj.focused || obj.is_focused || obj.current) {
      const pid = obj.pane_id || obj.id || obj.paneId;
      if (pid) return pid;
      // focused marker object without pane id — recurse into children
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = deepFindFocused(item);
        if (r) return r;
      }
    } else {
      for (const v of Object.values(obj)) {
        const r = deepFindFocused(v);
        if (r) return r;
      }
    }
  }
  return null;
}

function findFocusedPane() {
  if (env.HERDR_PANE_ID) return env.HERDR_PANE_ID;
  try {
    const raw = herdr(["pane", "list"]);
    const data = JSON.parse(raw);
    return deepFindFocused(data);
  } catch { /* fall through */ }
  return null;
}

// ── Config ──

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return { mindModel: "", workerModel: "opencode-go/deepseek-v4-flash", workerCount: 3, workerModels: null };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { mindModel: "", workerModel: "opencode-go/deepseek-v4-flash", workerCount: 3, workerModels: null };
  }
}

function resolveWorkers(cfg) {
  const resolved = [];
  if (Array.isArray(cfg.workerModels) && cfg.workerModels.length > 0) {
    for (const e of cfg.workerModels) {
      for (let i = 0; i < e.count; i++) resolved.push({ model: e.model, tier: e.tier || "flash" });
    }
  } else {
    const wc = cfg.workerCount || 3;
    const wm = cfg.workerModel || "opencode-go/deepseek-v4-flash";
    for (let i = 0; i < wc; i++) resolved.push({ model: wm, tier: "flash" });
  }
  return resolved;
}

// ── Manifest / Control ──

function writeManifest(path, cwd, hash, gen, wc) {
  const wsDir = workerSessDir(hash, 0);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({
    cwd, cwdHash: hash, generation: gen, workerCount: wc,
    state: "starting", lastUpdated: Date.now(), startedAt: Date.now(),
    mindPid: null, mindSupervisorPid: null, mindChildPid: null, workerPid: null,
    mindPaneId: null, workerPaneId: null,
    mindRole: "mind", workerRole: "worker",
    mindSessionDir: "", workerSessionDir: wsDir,
  }, null, 2));
  renameSync(tmp, path);
}

function writeControl(path, gen, status = "") {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({
    status, generation: gen, lastUpdated: Date.now(),
  }, null, 2));
  renameSync(tmp, path);
}

function storePaneId(path, key, paneId) {
  try {
    const m = JSON.parse(readFileSync(path, "utf-8"));
    m[key] = paneId;
    m.lastUpdated = Date.now();
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(m, null, 2));
    renameSync(tmp, path);
  } catch { /* best-effort */ }
}

function readManifestField(path, key, def = 0) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"))[key] ?? def;
  } catch {
    return def;
  }
}

// ── Liveness ──

function isPairLive(hash) {
  const cp = getControlPath(hash);
  const mp = getManifestPath(hash);
  const sock = join(STATE_DIR, `${hash}.sock`);

  if (existsSync(cp)) {
    try {
      const s = JSON.parse(readFileSync(cp, "utf-8")).status;
      if (s === "ready" || s === "busy" || s === "starting" || s === "worker-connected") return true;
    } catch { /* ignore */ }
  }
  if (existsSync(mp)) {
    try {
      const s = JSON.parse(readFileSync(mp, "utf-8")).state;
      if (s === "running" || s === "starting") return true;
    } catch { /* ignore */ }
  }
  return existsSync(sock);
}

// ── Reset cleanup ──

function closeManifestPanes(mp) {
  if (!existsSync(mp)) return;
  try {
    const m = JSON.parse(readFileSync(mp, "utf-8"));
    const ids = [];
    for (const k of Object.keys(m)) {
      if (k.startsWith("workerPaneId_")) ids.push(m[k]);
    }
    if (m.mindPaneId) ids.push(m.mindPaneId);
    for (const id of ids) herdrPaneClose(id);
  } catch { /* best-effort */ }
}

function cleanupArtifacts(hash) {
  try { unlinkSync(getManifestPath(hash)); } catch {}
  try { unlinkSync(getControlPath(hash)); } catch {}
  try { unlinkSync(join(STATE_DIR, `${hash}.sock`)); } catch {}
  // hash-* files in state dir
  try {
    for (const e of readdirSync(STATE_DIR)) {
      if (e.startsWith(hash)) {
        try { unlinkSync(join(STATE_DIR, e)); } catch {}
      }
    }
  } catch {}
  // worker-<hash>-* session dirs
  try {
    for (const e of readdirSync(SESSIONS_DIR)) {
      if (e.startsWith(`worker-${hash}-`)) {
        try { rmSync(join(SESSIONS_DIR, e), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
  // burst-flash-<hash>-* session dirs
  try {
    for (const e of readdirSync(SESSIONS_DIR)) {
      if (e.startsWith(`burst-flash-${hash}-`)) {
        try { rmSync(join(SESSIONS_DIR, e), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}

// ── Command builders (env-prefixed for target-pane shell) ──

function buildMindCmd(cwd, gen, model) {
  let cmd = `cd ${shellQuote(cwd)} && env PI_MIND_WORKER_ROLE=mind PI_MIND_WORKER_GENERATION=${gen} ${shellQuote(PI_BIN)}`;
  if (model) cmd += ` --model ${shellQuote(model)}`;
  return cmd;
}

function buildWorkerCmd(cwd, gen, workerId, tier, model, sessionDir) {
  return `cd ${shellQuote(cwd)} && env PI_MIND_WORKER_ROLE=worker PI_MIND_WORKER_GENERATION=${gen} PI_MIND_WORKER_ID=${workerId} PI_MIND_WORKER_TIER=${tier} PI_MIND_WORKER_SESSION_DIR=${shellQuote(sessionDir)} ${shellQuote(PI_BIN)} --model ${shellQuote(model)} --session-dir ${shellQuote(sessionDir)}`;
}

// ── Wait helpers ──

async function waitMindReady(hash, gen, timeoutSec = 60) {
  const cp = getControlPath(hash);
  const sock = join(STATE_DIR, `${hash}.sock`);
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    if (existsSync(cp)) {
      try {
        const d = JSON.parse(readFileSync(cp, "utf-8"));
        if (d.generation === gen && (d.status === "ready" || d.status === "worker-connected")) {
          if (existsSync(sock)) {
            try {
              await new Promise((resolve, reject) => {
                const s = createConnection(sock, () => { s.destroy(); resolve(); });
                s.on("error", reject);
                s.setTimeout(2000, () => { s.destroy(); reject(new Error("timeout")); });
              });
              return;
            } catch { /* socket not connectable yet, keep polling */ }
          }
        }
      } catch { /* parse error, keep polling */ }
    }
    await sleep(500);
  }
  throw new Error(`Mind did not become ready within ${timeoutSec}s (hash: ${hash})`);
}

async function waitWorkersConnected(hash, gen, expected, timeoutSec = 60) {
  const cp = getControlPath(hash);
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    if (existsSync(cp)) {
      try {
        const d = JSON.parse(readFileSync(cp, "utf-8"));
        if (d.generation === gen && d.status === "worker-connected") {
          if ((d.connectedWorkers || 0) >= expected) return;
        }
      } catch { /* keep polling */ }
    }
    await sleep(500);
  }
  throw new Error(`Not all workers connected within ${timeoutSec}s (hash: ${hash})`);
}

// ── Main ──

async function main() {
  const argv = process.argv.slice(2);
  let resetFlag = false;
  let explicitCwd = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reset") resetFlag = true;
    if (argv[i] === "--cwd" && i + 1 < argv.length) explicitCwd = argv[++i];
  }

  const cwd = realpathSync(explicitCwd || process.cwd());
  const hash = getCwdHash(cwd);

  ensureDir(STATE_DIR);
  ensureDir(SESSIONS_DIR);

  const cfg = loadConfig();
  const mindModel = cfg.mindModel || "";
  const workers = resolveWorkers(cfg);
  const workerCount = workers.length;

  const mp = getManifestPath(hash);
  const cp = getControlPath(hash);

  // ── Auto-reset if pair already live ──
  if (!resetFlag && isPairLive(hash)) {
    console.log(`Pair already running for hash ${hash}. Running reset...`);
    resetFlag = true;
  }

  // ── Determine generation (before cleanup so it keeps climbing) ──
  let generation = 1;
  if (existsSync(mp)) {
    generation = readManifestField(mp, "generation", 0);
    generation++;
  }

  // ── Reset path ──
  if (resetFlag) {
    console.log("=== Reset (herdr) ===");
    console.log(`  Previous generation: ${generation - 1}`);
    closeManifestPanes(mp);
    await sleep(1000);
    cleanupArtifacts(hash);
  }

  console.log("=== Mind-Pair Launcher (herdr) ===");
  console.log(`  CWD:     ${cwd}`);
  console.log(`  Hash:    ${hash}`);
  console.log(`  Gen:     ${generation}`);
  console.log(`  Workers: ${workerCount}`);

  // ── Write manifest + control ──
  writeManifest(mp, cwd, hash, generation, workerCount);
  writeControl(cp, generation, "");

  // ── Worker session dirs ──
  for (let i = 0; i < workerCount; i++) ensureDir(workerSessDir(hash, i));

  // ── Get current pane ──
  const myPane = findFocusedPane();
  if (!myPane) {
    console.error("ERROR: Could not determine current herdr pane. Is HERDR_ENV=1?");
    process.exit(1);
  }
  console.log(`  Launcher pane: ${myPane}`);

  // ── Spawn mind pane ──
  console.log("  Spawning mind pane...");
  let mindPane;
  try {
    mindPane = herdrPaneSplit(myPane, "right");
  } catch (err) {
    console.error(`ERROR: Failed to create mind pane: ${err.message}`);
    process.exit(1);
  }
  storePaneId(mp, "mindPaneId", mindPane);

  try {
    herdrPaneRun(mindPane, buildMindCmd(cwd, generation, mindModel));
  } catch (err) {
    console.error(`ERROR: Failed to run mind in pane: ${err.message}`);
    herdrPaneClose(mindPane);
    process.exit(1);
  }

  // ── Wait for mind ready ──
  console.log("  Waiting for mind to be ready...");
  try {
    await waitMindReady(hash, generation, 60);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    herdrPaneClose(mindPane);
    process.exit(1);
  }
  console.log("  Mind is ready.");

  // ── Spawn worker panes ──
  console.log(`  Spawning ${workerCount} worker panes...`);
  const workerPanes = [];

  try {
    for (let i = 0; i < workerCount; i++) {
      const { model, tier } = workers[i];
      const wLabel = `worker-${i}`;

      const wPane = herdrPaneSplit(mindPane, "right");
      storePaneId(mp, `workerPaneId_${i}`, wPane);
      herdrPaneRun(wPane, buildWorkerCmd(cwd, generation, wLabel, tier, model, workerSessDir(hash, i)));
      workerPanes.push(wPane);
      console.log(`    Worker ${i}: ${wPane} (${tier})`);
    }
  } catch (err) {
    console.error(`ERROR: Worker spawn failed: ${err.message}`);
    herdrPaneClose(mindPane);
    for (const wp of workerPanes) herdrPaneClose(wp);
    process.exit(1);
  }

  // ── Wait for workers connected ──
  const waitTimeout = 10 + workerCount * 5;
  console.log(`  Waiting for ${workerPanes.length} workers to connect (timeout ${waitTimeout}s)...`);
  try {
    await waitWorkersConnected(hash, generation, workerPanes.length, waitTimeout);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    herdrPaneClose(mindPane);
    for (const wp of workerPanes) herdrPaneClose(wp);
    process.exit(1);
  }

  console.log(`=== Mind-pair started (herdr, gen ${generation}) ===`);
  console.log(`  Mind:    ${mindPane}`);
  console.log(`  Workers: ${workerPanes.join(", ")}`);
  console.log(`  Cwd:     ${cwd}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
