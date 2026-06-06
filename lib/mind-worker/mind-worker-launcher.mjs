#!/usr/bin/env node

// mind-worker-launcher.mjs — Launcher core for mind-worker pair startup/reset.
// Direct kitty launch model: spawns pi directly in kitty splits for both mind
// and worker using PI_MIND_WORKER_ROLE env vars. No supervisor process in
// live flow. Reset uses kitty window close + PID kill with escalation.
//
// Thin shell wrapper (bin/mind-worker-launcher) delegates here.

import { realpathSync, existsSync, readFileSync, mkdirSync, accessSync, writeFileSync, renameSync, unlinkSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { createKittyAdapter } from "./kitty-adapter.mjs";

// --------------------------------------------------------------------------
// Exit codes
// --------------------------------------------------------------------------

const EXIT = {
  SUCCESS: 0,
  MIND_READY_TIMEOUT: 10,
  WORKER_CONNECT_TIMEOUT: 11,
  WORKER_GEN_MISMATCH: 12,
  RESET_STOP_FAILED: 13,
  RESET_NO_MANIFEST: 3,
  KITTY_FAILED: 15,
  GENERIC_FATAL: 20,
};

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

const AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT_DIR, "mindworker");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");

function getCwdHash(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function getControlFilePath(cwd) {
  return join(STATE_DIR, `${getCwdHash(cwd)}-mind-control.json`);
}

function getSocketPath(cwd) {
  return join(STATE_DIR, `${getCwdHash(cwd)}.sock`);
}

// --------------------------------------------------------------------------
// Manifest store
// --------------------------------------------------------------------------

function getManifestPath(cwd) {
  return join(STATE_DIR, `${getCwdHash(cwd)}-manifest.json`);
}

function writeManifestAtomic(path, data) {
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function createInitialManifest(cwd, hash, mindSessionDir, workerSessionDir) {
  return {
    cwd,
    cwdHash: hash,
    generation: 1,
    mindPid: null,
    // Backward compat fields — kept for existing manifests
    mindSupervisorPid: null,
    mindChildPid: null,
    workerPid: null,
    mindPaneId: null,
    workerPaneId: null,
    mindRole: "mind",
    workerRole: "worker",
    mindSessionDir,
    workerSessionDir,
    workerCount: 1,
    state: "starting",
    lastUpdated: Date.now(),
    startedAt: Date.now(),
  };
}

// --------------------------------------------------------------------------
// Config (best-effort, missing fields use defaults)
// --------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  timeout: 120,
  statusStream: true,
  autoSpawnWorker: true,
  workerTaskStrictness: "strict",
  notifyOnMindIdle: false,
  ntfyTopic: "",
  ntfyServer: "https://ntfy.sh",
  mindModel: "openai-codex/gpt-5.5",
  workerModel: "opencode-go/deepseek-v4-flash",
  resetTimeout: 5,
  kittyEnabled: true,
  workerCount: 3,
  workerModels: undefined,
};

function loadConfig() {
  const configPath = join(AGENT_DIR, "mind-worker.json");
  try {
    if (!existsSync(configPath)) {
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
      console.warn(`[mind-worker-launcher] Created ${configPath} with defaults.`);
      const wc = DEFAULT_CONFIG.workerCount;
      const fallback = [];
      for (let i = 0; i < wc; i++) {
        fallback.push({ model: DEFAULT_CONFIG.workerModel, tier: "flash" });
      }
      return {
        kittyEnabled: true, resetTimeout: 5,
        mindModel: DEFAULT_CONFIG.mindModel, workerModel: DEFAULT_CONFIG.workerModel,
        timeout: 120, workerCount: wc,
        workerModelsResolved: fallback,
      };
    }

    const raw = JSON.parse(readFileSync(configPath, "utf-8"));

    const kittyEnabled = raw.kittyEnabled !== false;
    const resetTimeout = typeof raw.resetTimeout === "number" && raw.resetTimeout > 0
      ? raw.resetTimeout : 5;
    const mindModel = typeof raw.mindModel === "string" && raw.mindModel.trim()
      ? raw.mindModel.trim() : DEFAULT_CONFIG.mindModel;
    const workerModel = typeof raw.workerModel === "string" && raw.workerModel.trim()
      ? raw.workerModel.trim() : DEFAULT_CONFIG.workerModel;
    const timeout = typeof raw.timeout === "number" ? raw.timeout : 120;
    const workerCount = typeof raw.workerCount === "number" && raw.workerCount >= 1 && raw.workerCount <= 10
      ? raw.workerCount : DEFAULT_CONFIG.workerCount;

    // Resolve workerModels into flat list of {model, tier}
    let workerModelsResolved = [];
    if (Array.isArray(raw.workerModels) && raw.workerModels.length > 0) {
      let valid = true;
      for (const entry of raw.workerModels) {
        if (typeof entry.model !== "string" || !entry.model.trim()) { valid = false; break; }
        if (typeof entry.count !== "number" || entry.count < 1 || entry.count > 10) { valid = false; break; }
        const tier = entry.tier || "flash";
        if (tier !== "flash" && tier !== "strong") { valid = false; break; }
      }
      if (valid) {
        const total = raw.workerModels.reduce((sum, e) => sum + e.count, 0);
        if (total >= 1 && total <= 10) {
          for (const entry of raw.workerModels) {
            const tier = entry.tier || "flash";
            for (let i = 0; i < entry.count; i++) {
              workerModelsResolved.push({ model: entry.model.trim(), tier });
            }
          }
        }
      }
      if (workerModelsResolved.length === 0) {
        console.warn("[mind-worker-launcher] workerModels validation failed — falling back to legacy config");
      }
    }
    if (workerModelsResolved.length === 0) {
      for (let i = 0; i < workerCount; i++) {
        workerModelsResolved.push({ model: workerModel, tier: "flash" });
      }
    }

    return { kittyEnabled, resetTimeout, mindModel, workerModel, timeout, workerCount, workerModelsResolved };
  } catch {
    console.warn(`[mind-worker-launcher] mind-worker.json invalid — using defaults.`);
    const fbCount = DEFAULT_CONFIG.workerCount;
    const fallback = [];
    for (let i = 0; i < fbCount; i++) {
      fallback.push({ model: DEFAULT_CONFIG.workerModel, tier: "flash" });
    }
    return { kittyEnabled: true, resetTimeout: 5, mindModel: DEFAULT_CONFIG.mindModel, workerModel: DEFAULT_CONFIG.workerModel, timeout: 120, workerCount: fbCount, workerModelsResolved: fallback };
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Check if a process is alive by sending signal 0. */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Collect unique known PIDs from manifest with dedup. Returns array of { pid, label }. */
function collectKnownPids(manifest) {
  const seen = new Set();
  const result = [];

  // Static candidate keys (backward compat)
  const staticKeys = ["mindPid", "workerPid", "mindSupervisorPid", "mindChildPid"];
  for (const key of staticKeys) {
    const pid = manifest[key];
    if (pid && !seen.has(pid)) {
      seen.add(pid);
      result.push({ pid, label: key });
    }
  }

  // Dynamic workerPid_N keys from multi-worker manifest
  for (const key of Object.keys(manifest)) {
    const m = key.match(/^workerPid_(\d+)$/);
    if (m) {
      const pid = manifest[key];
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        result.push({ pid, label: key });
      }
    }
  }

  return result;
}

// --------------------------------------------------------------------------
// Pair-alive check
// --------------------------------------------------------------------------

/** Returns true if a pair for this cwd appears to be running.
 *  Conservative — checks control file status, manifest state, and socket.
 *  Any one signal triggers "live" to avoid races during startup/teardown. */
function isPairLive(cwd) {
  const socketPath = getSocketPath(cwd);
  const hash = getCwdHash(cwd);
  const controlPath = getControlFilePath(cwd);
  const manifestPath = join(STATE_DIR, `${hash}-manifest.json`);

  // 1. Control file status indicates live pair (most reliable for running pairs)
  try {
    if (existsSync(controlPath)) {
      const raw = JSON.parse(readFileSync(controlPath, "utf-8"));
      if (raw.status === "ready" || raw.status === "busy" || raw.status === "starting") return true;
    }
  } catch { /* ignore */ }

  // 2. Manifest exists with running or starting state
  try {
    if (existsSync(manifestPath)) {
      const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (m.state === "running" || m.state === "starting") return true;
    }
  } catch { /* ignore */ }

  // 3. Socket file exists (may be stale, but conservative)
  if (existsSync(socketPath)) return true;

  return false;
}

// --------------------------------------------------------------------------
// Wait for mind readiness — polls manifest state + socket liveness
// --------------------------------------------------------------------------

function waitForMindReady(cwd, hash, generation, manifestPath, timeoutSec) {
  const socketPath = getSocketPath(cwd);
  const deadline = Date.now() + timeoutSec * 1000;
  let settled = false;
  let pollCount = 0;

  return new Promise((resolve, reject) => {
    function done(err) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    }

    function poll() {
      if (settled) return;
      pollCount++;

      // Check manifest: state === "running" AND generation matches
      const manifest = readManifest(manifestPath);
      if (manifest) {
        const genOk = manifest.generation === generation;
        const stateOk = manifest.state === "running";
        if (genOk && stateOk) {
          // Verify socket is connectable
          if (existsSync(socketPath)) {
            const sock = createConnection(socketPath, () => {
              sock.destroy();
              done();
              return;
            });
            sock.on("error", () => { });
            sock.setTimeout(500, () => sock.destroy());
          }
        }
      }

      if (pollCount % 10 === 0) {
        console.error(`[waitForMindReady] manifest state="${manifest?.state}", gen=${manifest?.generation}, socket=${existsSync(socketPath)}`);
      }

      if (Date.now() >= deadline) {
        done(new Error(`Mind did not become ready within ${timeoutSec}s (hash: ${hash})`));
        return;
      }

      setTimeout(poll, 200);
    }
    poll();
  });
}

// --------------------------------------------------------------------------
// Wait for worker-connected status in control file
// --------------------------------------------------------------------------

function waitForWorkerConnected(cwd, hash, generation, startedAt, timeoutSec, expectedWorkers) {
  const controlPath = getControlFilePath(cwd);
  const deadline = Date.now() + timeoutSec * 1000;
  let settled = false;
  let lastRaw = null;

  return new Promise((resolve, reject) => {
    function done(err) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    }

    function poll() {
      if (settled) return;
      try {
        if (existsSync(controlPath)) {
          const raw = JSON.parse(readFileSync(controlPath, "utf-8"));
          lastRaw = raw;
          if (
            raw.status === "worker-connected" &&
            raw.generation === generation &&
            raw.lastUpdated >= startedAt &&
            raw.connectedWorkers !== undefined &&
            raw.connectedWorkers >= expectedWorkers
          ) {
            done();
            return;
          }
          if (
            raw.status === "error" &&
            raw.generation === generation &&
            raw.lastUpdated >= startedAt
          ) {
            done(new Error(`Mind rejected worker: ${raw.message || "handshake error"}`));
            return;
          }
        }
      } catch { /* ignore parse errors */ }

      if (Date.now() >= deadline) {
        const connected = lastRaw?.connectedWorkers ?? 0;
        done(new Error(`Worker did not connect within ${timeoutSec}s (hash: ${hash}) — connected ${connected}/${expectedWorkers}`));
        return;
      }

      setTimeout(poll, 200);
    }
    poll();
  });
}

// --------------------------------------------------------------------------
// Kitty adapter (module-level, set in main after config loads)
// --------------------------------------------------------------------------

let kitty = null;

/** Absolute path to pi, resolved once from PATH at startup. */
const PI_PATH = resolvePiPath();

function resolvePiPath() {
  const pathDirs = (env.PATH || "").split(":");
  for (const dir of pathDirs) {
    const candidate = join(dir, "pi");
    try {
      accessSync(candidate);
      return candidate;
    } catch { /* try next */ }
  }
  return "pi"; // fallback — hope PATH resolves in spawned context
}

// --------------------------------------------------------------------------
// Manual instructions (kittyEnabled === false)
// --------------------------------------------------------------------------

function printManualInstructions(cwd, hash, mindSessionDir, workerSessionDir) {
  const config = loadConfig();
  const resolvedWorkers = config.workerModelsResolved || [];
  const wc = resolvedWorkers.length;
  const lines = [
    "",
    "# Mind-Pair Launcher (kitty disabled in mind-worker.json)",
    "#",
    "# Start mind first, then start each worker in a separate terminal:",
    "",
    `  # Terminal 1 — Mind (start this first, wait until ready):`,
    `  PI_MIND_WORKER_ROLE=mind PI_MIND_WORKER_GENERATION=1 ${PI_PATH} --session-dir "${mindSessionDir}"`,
  ];
  for (let i = 0; i < wc; i++) {
    const entry = resolvedWorkers[i];
    lines.push("");
    lines.push(`  # Terminal ${i + 2} — Worker ${i} [${entry.tier}] (start after mind is ready):`);
    lines.push(`  PI_MIND_WORKER_ROLE=worker PI_MIND_WORKER_GENERATION=1 PI_MIND_WORKER_ID=worker-${i} PI_MIND_WORKER_TIER=${entry.tier} ${PI_PATH} --model ${entry.model} --session-dir "${join(SESSIONS_DIR, `worker-${hash}-${i}`)}"`);
  }
  lines.push("");
  lines.push(`# Working directory: ${cwd}`);
  lines.push(`# Pair hash: ${hash}`);
  lines.push(`# Worker count: ${wc}`);
  console.log(lines.join("\n"));
}

// --------------------------------------------------------------------------
// Reset protocol phases
// --------------------------------------------------------------------------

/** Delete all artifacts for a given cwd hash. */
function deleteHashArtifacts(cwd, hash) {
  const files = [
    getSocketPath(cwd),
    getControlFilePath(cwd),
    getManifestPath(cwd),
    join(STATE_DIR, `${hash}-plan.md`),
    join(STATE_DIR, `${hash}-pending-task.json`),
    join(STATE_DIR, `${hash}-pending-role.json`),
  ];
  for (const f of files) {
    try { unlinkSync(f); } catch { /* may not exist */ }
  }

  // Delete any remaining ${hash}* files in state dir
  try {
    const entries = readdirSync(STATE_DIR);
    for (const entry of entries) {
      if (entry.startsWith(hash)) {
        try { unlinkSync(join(STATE_DIR, entry)); } catch { /* ignore */ }
      }
    }
  } catch { /* state dir may not exist */ }

  // Session dirs
  for (const d of [
    join(SESSIONS_DIR, `mind-${hash}`),
    join(SESSIONS_DIR, `worker-${hash}`),
  ]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* may not exist */ }
  }
  // Delete per-worker session dirs (worker-${hash}-0, worker-${hash}-1, ...)
  try {
    const entries = readdirSync(SESSIONS_DIR);
    for (const entry of entries) {
      if (entry.startsWith(`worker-${hash}-`)) {
        try { rmSync(join(SESSIONS_DIR, entry), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* sessions dir may not exist */ }
}

/**
 * Stop phase: close kitty windows, kill PIDs directly, poll for disappearance,
 * escalate to SIGKILL on timeout.
 *
 * Returns true only when both windows are gone AND all known PIDs are dead
 * after escalation. Returns false if anything still appears alive.
 *
 * Does NOT use control-file stop command or supervisor — direct kitty window
 * management + process signals.
 */
async function stopPair(cwd, hash, manifest) {
  const generation = manifest.generation;
  const config = loadConfig();
  const workerCount = manifest.workerCount || 1;
  const resetTimeoutMs = config.resetTimeout * 1000;
  const pollInterval = 200;
  const mindTitle = `mind-${hash}`;

  console.log(`Stop phase: closing mind/${workerCount} worker windows, killing PIDs (generation ${generation})...`);

  // Collect unique known PIDs with dedup
  const pidsToKill = collectKnownPids(manifest);
  if (pidsToKill.length > 0) {
    console.log(`  Known PIDs: ${pidsToKill.map(p => `${p.label}=${p.pid}`).join(", ")}`);
  }

  // 1. Close kitty windows first (primary termination path)
  //    Kitty sends SIGHUP/SIGTERM to the process tree when closing a window.
  const workerTitles = [];
  for (let i = 0; i < workerCount; i++) {
    workerTitles.push(`worker-${hash}-${i}`);
  }
  for (const t of workerTitles) {
    await kitty.closeByTitle(t);
  }
  await kitty.closeByTitle(mindTitle);

  // 2. SIGTERM all known PIDs (backup — pi process may survive kitty close)
  for (const { pid, label } of pidsToKill) {
    try {
      process.kill(pid, "SIGTERM");
    } catch { /* may already be dead */ }
  }

  // 3. Poll for windows + PIDs to clear
  const deadline = Date.now() + resetTimeoutMs;
  let allClear = false;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const mindWin = await kitty.findWindowByTitle(mindTitle);
    let anyWorkerWin = false;
    for (const t of workerTitles) {
      const w = await kitty.findWindowByTitle(t);
      if (w) { anyWorkerWin = true; break; }
    }
    const anyPidAlive = pidsToKill.some(p => isPidAlive(p.pid));

    if (!mindWin && !anyWorkerWin && !anyPidAlive) {
      allClear = true;
      break;
    }
  }

  // 4. Escalate on timeout
  if (!allClear) {
    console.error("  Stop timeout — windows or PIDs still alive. Escalating to force close + SIGKILL...");

    for (const t of workerTitles) {
      await kitty.closeByTitle(t);
    }
    await kitty.closeByTitle(mindTitle);

    for (const { pid, label } of pidsToKill) {
      try {
        process.kill(pid, "SIGKILL");
      } catch { /* already dead */ }
    }

    await sleep(500);

    // Final check after escalation
    const mindWin = await kitty.findWindowByTitle(mindTitle);
    let anyWorkerWin = false;
    for (const t of workerTitles) {
      const w = await kitty.findWindowByTitle(t);
      if (w) { anyWorkerWin = true; break; }
    }
    const anyPidAlive = pidsToKill.some(p => isPidAlive(p.pid));

    if (mindWin || anyWorkerWin || anyPidAlive) {
      const alivePids = pidsToKill.filter(p => isPidAlive(p.pid)).map(p => `${p.label}=${p.pid}`).join(",");
      console.error(`  Escalation done — windows=${!!mindWin}, workers=${anyWorkerWin}, PIDsAlive=[${alivePids}]. Stop FAILED.`);
      console.log("  Stop failed.");
      return false;
    }

    console.log("  Escalation successful — all clear.");
  } else {
    console.log("  Windows and PIDs cleared.");
  }

  console.log("  Stop complete.");
  return true;
}

/** Cleanup phase: delete artifacts. Generation stays in memory. */
function cleanupPhase(cwd, hash) {
  console.log("Cleanup phase: deleting artifacts...");
  deleteHashArtifacts(cwd, hash);
  console.log("  Cleanup complete.");
}

/**
 * Spawn + verify phase. Writes fresh manifest with incremented generation,
 * spawns pi directly in kitty for mind (tab) and worker (right split),
 * waits for ready + worker-connected.
 *
 * No supervisor — pi runs directly in kitty window with PI_MIND_WORKER_ROLE
 * and PI_MIND_WORKER_GENERATION env vars.
 */
async function spawnPhase(cwd, hash, generation) {
  const config = loadConfig();
  const resolvedWorkers = config.workerModelsResolved || [];
  const workerCount = resolvedWorkers.length;
  const mindSessionDir = join(SESSIONS_DIR, `mind-${hash}`);

  ensureDir(STATE_DIR);
  ensureDir(mindSessionDir);

  // Create per-worker session dirs
  const workerSessionDirs = [];
  for (let i = 0; i < workerCount; i++) {
    const d = join(SESSIONS_DIR, `worker-${hash}-${i}`);
    ensureDir(d);
    workerSessionDirs.push(d);
  }

  const manifestPath = getManifestPath(cwd);
  const startedAt = Date.now();

  // Write fresh manifest
  const manifest = createInitialManifest(cwd, hash, mindSessionDir, workerSessionDirs[0]);
  manifest.generation = generation;
  manifest.startedAt = startedAt;
  manifest.workerCount = workerCount;
  writeManifestAtomic(manifestPath, manifest);
  console.log(`  Manifest written (generation ${generation}, ${workerCount} workers)`);

  // Initialize fresh control file
  const controlPath = getControlFilePath(cwd);
  writeManifestAtomic(controlPath, { status: "", generation, lastUpdated: startedAt });

  // Spawn pi directly in kitty tab for mind
  const mindTitle = `mind-${hash}`;
  console.log(`  Spawning mind (gen ${generation})...`);
  const mindCmd = [
    "--env", `PI_MIND_WORKER_ROLE=mind`,
    "--env", `PI_MIND_WORKER_GENERATION=${generation}`,
    "--env", `PATH=${env.PATH}`,
    PI_PATH,
  ];
  if (config.mindModel) mindCmd.push("--model", config.mindModel);
  mindCmd.push("--session-dir", mindSessionDir);
  await kitty.launchTab(mindTitle, cwd, mindCmd);

  // Record mind pane/pid (best-effort)
  try {
    const win = await kitty.findWindowByTitle(mindTitle);
    if (win) {
      const m = readManifest(manifestPath);
      if (m && m.generation === generation) {
        m.mindPaneId = win.id;
        m.mindPid = win.pid;
        m.mindSupervisorPid = win.pid; // backward compat
        m.lastUpdated = Date.now();
        writeManifestAtomic(manifestPath, m);
      }
    }
  } catch { /* best-effort */ }

  // Wait for mind ready
  const readyTimeout = 30;
  console.log("  Waiting for mind to be ready...");
  try {
    await waitForMindReady(cwd, hash, generation, manifestPath, readyTimeout);
    console.log("  Mind is ready.");
  } catch (err) {
    await kitty.closeByTitle(mindTitle);
    throw new Error(`Mind did not become ready: ${err.message}`);
  }

  // Spawn all workers concurrently from mind pane (single focus, parallel launches)
  console.log(`  Spawning ${workerCount} workers (${resolvedWorkers.map(w => w.tier).join(", ")}) concurrently...`);
  const workerTitles = [];
  for (let i = 0; i < workerCount; i++) {
    workerTitles.push(`worker-${hash}-${i}`);
  }
  await kitty.focusByTitle(mindTitle);

  const launchPromises = workerTitles.map((title, i) => {
    const entry = resolvedWorkers[i];
    const workerCmd = [
      "--env", `PI_MIND_WORKER_ROLE=worker`,
      "--env", `PI_MIND_WORKER_GENERATION=${generation}`,
      "--env", `PI_MIND_WORKER_ID=worker-${i}`,
      "--env", `PI_MIND_WORKER_TIER=${entry.tier}`,
      "--env", `PATH=${env.PATH}`,
      PI_PATH,
    ];
    if (entry.model) workerCmd.push("--model", entry.model);
    workerCmd.push("--session-dir", workerSessionDirs[i]);
    return kitty.launchSplit(title, cwd, workerCmd);
  });

  await Promise.all(launchPromises);

  // Record worker panes/pids (best-effort, sequential write to avoid manifest race)
  for (let i = 0; i < workerCount; i++) {
    try {
      const win = await kitty.findWindowByTitle(workerTitles[i]);
      if (win) {
        const m = readManifest(manifestPath);
        if (m && m.generation === generation) {
          const pidKey = `workerPid_${i}`;
          const paneKey = `workerPaneId_${i}`;
          m[pidKey] = win.pid;
          m[paneKey] = win.id;
          m.lastUpdated = Date.now();
          writeManifestAtomic(manifestPath, m);
        }
      }
    } catch { /* best-effort */ }
  }

  // Wait for all workers to connect
  const workerTimeout = 10 + (workerCount * 2); // more time for more workers
  console.log(`  Waiting for ${workerCount} workers to connect...`);
  try {
    await waitForWorkerConnected(cwd, hash, generation, startedAt, workerTimeout, workerCount);
    console.log(`  ${workerCount} worker(s) connected.`);
  } catch (err) {
    const isGenError = err.message.includes("Mind rejected worker");
    const exitCode = isGenError ? EXIT.WORKER_GEN_MISMATCH : EXIT.WORKER_CONNECT_TIMEOUT;
    console.error(`ERROR: ${err.message}`);
    for (const t of workerTitles) {
      await kitty.closeByTitle(t);
    }
    throw Object.assign(new Error(err.message), { exitCode });
  }

  await kitty.focusByTitle(mindTitle);
  console.log(`\nMind-worker pair started (generation ${generation}, ${workerCount} workers).`);
  return { mindTitle, workerTitles };
}

/** Full reset protocol: stop → cleanup → spawn → verify. */
async function executeReset(cwd) {
  const hash = getCwdHash(cwd);
  const manifestPath = getManifestPath(cwd);

  const manifest = readManifest(manifestPath);
  if (!manifest) {
    console.error(`No manifest found for hash ${hash} — nothing to reset.`);
    process.exit(EXIT.RESET_NO_MANIFEST);
  }

  const oldGeneration = manifest.generation;
  const newGeneration = oldGeneration + 1;

  console.log(`\n=== Reset (generation ${oldGeneration} → ${newGeneration}) ===`);

  const stopped = await stopPair(cwd, hash, manifest);
  if (!stopped) {
    console.error("Reset aborted: stop phase failed — windows or processes still alive.");
    process.exit(EXIT.RESET_STOP_FAILED);
  }
  cleanupPhase(cwd, hash);
  const { mindTitle, workerTitles } = await spawnPhase(cwd, hash, newGeneration);

  console.log(`  Mind:   ${mindTitle}`);
  console.log(`  Workers: ${workerTitles.join(", ")}`);
  console.log(`  Cwd:    ${cwd}`);
  console.log("=== Reset complete ===");
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  // Parse CLI args
  const argv = process.argv.slice(2);
  let resetFlag = false;
  let explicitCwd = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reset") resetFlag = true;
    if (argv[i] === "--cwd" && i + 1 < argv.length) explicitCwd = argv[++i];
  }

  // Canonicalize cwd
  const cwd = realpathSync(explicitCwd || process.cwd());
  const hash = getCwdHash(cwd);
  const config = loadConfig();

  // Initialize kitty adapter
  kitty = createKittyAdapter(config.kittyEnabled);

  const mindSessionDir = join(SESSIONS_DIR, `mind-${hash}`);
  const workerSessionDir = join(SESSIONS_DIR, `worker-${hash}`);

  // --reset flag → full reset protocol
  if (resetFlag) {
    try {
      await executeReset(cwd);
    } catch (err) {
      console.error(`Reset failed: ${err.message}`);
      process.exit(err.exitCode || EXIT.GENERIC_FATAL);
    }
    return;
  }

  ensureDir(STATE_DIR);
  ensureDir(mindSessionDir);
  ensureDir(workerSessionDir);

  if (!config.kittyEnabled) {
    printManualInstructions(cwd, hash, mindSessionDir, workerSessionDir);
    return;
  }

  // Preflight — if pair exists, auto-reset
  if (isPairLive(cwd)) {
    console.log(`Pair already running for hash ${hash}. Running reset...`);
    await executeReset(cwd);
    return;
  }

  // Fresh start — spawn pair via spawnPhase with generation 1
  console.log(`\n=== Fresh start (hash: ${hash}) ===`);
  const { mindTitle, workerTitles } = await spawnPhase(cwd, hash, 1);

  console.log(`  Mind:   ${mindTitle}`);
  console.log(`  Workers: ${workerTitles.join(", ")}`);
  console.log(`  Cwd:    ${cwd}`);
}

main().catch((err) => {
  const msg = err.message || "";
  const isKittyErr = msg.includes("kitty failed") || msg.includes("kitty spawn failed");
  console.error(`FATAL: ${msg}`);
  process.exit(err.exitCode || (isKittyErr ? EXIT.KITTY_FAILED : EXIT.GENERIC_FATAL));
});
