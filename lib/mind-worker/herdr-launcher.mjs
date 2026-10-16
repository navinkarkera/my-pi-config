#!/usr/bin/env node

// herdr-launcher.mjs — Launch mind + TUI workers via herdr panes.
// Called by bin/mind-worker-launcher when terminalBackend == "herdr".
// Workers run as TUI (not --mode rpc). Mind-worker extension
// (PI_MIND_WORKER_ROLE env) handles lifecycle via control-file protocol.
//
// Foreground mode runs Mind in this process's terminal; this process supervises
// readiness, workers, reset, cleanup, and Mind's exit. Background starts are rejected.
// Uses herdr CLI commands only; no direct socket API.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  unlinkSync, rmSync, readdirSync, realpathSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, constants as osConstants } from "node:os";
import { basename, join } from "node:path";
import { env } from "node:process";

// ── Guard: verify herdr is reachable (herdr function is hoisted) ──
try {
  herdr(["pane", "list"]);
} catch (err) {
  console.error(`ERROR: herdr is not reachable — mind-pair launcher requires a running herdr instance.
  ${err.message}`);
  process.exit(1);
}

// ── Paths ──
const AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT_DIR, "mindworker");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const CONFIG_FILE = join(AGENT_DIR, "mind-worker.json");
const PI_BIN = env.PI_BIN || "pi";
const LAUNCHER_TOKEN = randomBytes(16).toString("hex");
let activeMind = null;
let activeMindExit = null;
let activeGeneration = null;
let activeHash = null;
let activeInstance = null;
let resetRequested = false;
let shutdownSignal = null;

// ── Helpers ──

/** SHA-256 hash of cwd, first 16 hex chars. Matches JS launcher. */
function getCwdHash(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

const getManifestPath = (h) => join(STATE_DIR, `${h}-manifest.json`);
const getControlPath  = (h) => join(STATE_DIR, `${h}-mind-control.json`);
const workerSessDir   = (h, i) => join(SESSIONS_DIR, `worker-${h}-${i}`);
const WORKER_HERDR_SESSION = "pi-workers";
const workerHerdrSession = () => WORKER_HERDR_SESSION;
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

function herdrFor(session, args, opts = {}) {
  return session ? herdr(["--session", session, ...args], opts) : herdr(args, opts);
}

function herdrPaneSplit(targetPane, direction, opts = {}) {
  const { ratio, focus = false } = opts;
  const args = ["pane", "split", targetPane, "--direction", direction];
  args.push(focus ? "--focus" : "--no-focus");
  if (ratio !== undefined) args.push("--ratio", String(ratio));
  const raw = herdrFor(opts.session, args);
  return JSON.parse(raw).result.pane.pane_id;
}

function herdrPaneRun(paneId, command, session = null) {
  herdrFor(session, ["pane", "run", paneId, command], { timeout: 10000 });
}

function herdrPaneClose(paneId, session = null) {
  try { herdrFor(session, ["pane", "close", paneId], { timeout: 5000 }); return true; } catch { return false; }
}

function herdrTabCreate(workspaceId, label, session = null) {
  const args = ["tab", "create", "--workspace", workspaceId, "--no-focus"];
  if (label) args.push("--label", label);
  const raw = herdrFor(session, args, { timeout: 10000 });
  const parsed = JSON.parse(raw);
  return {
    tabId: parsed.result.tab.tab_id || parsed.result.tab.id,
    rootPaneId: parsed.result.root_pane.pane_id || parsed.result.root_pane.id,
  };
}

function herdrTabClose(tabId, session = null) {
  try { herdrFor(session, ["tab", "close", tabId], { timeout: 5000 }); return true; } catch { return false; }
}

function herdrWorkspaceCreate(session, label) {
  const args = ["workspace", "create", "--no-focus"];
  if (label) args.push("--label", label);
  const raw = herdrFor(session, args, { timeout: 10000 });
  const parsed = JSON.parse(raw);
  const workspace = parsed.result?.workspace || parsed.workspace || parsed.result;
  return String(workspace.workspace_id || workspace.id);
}

function herdrWorkspaceExists(workspaceId, session) {
  try {
    const parsed = JSON.parse(herdrFor(session, ["workspace", "list"], { timeout: 5000 }));
    const workspaces = parsed.workspaces || parsed.result?.workspaces;
    if (!Array.isArray(workspaces)) return null;
    return workspaces.some(workspace => String(workspace.workspace_id || workspace.id) === workspaceId);
  } catch { return null; }
}

function herdrWorkspaceClose(workspaceId, session = null) {
  try { herdrFor(session, ["workspace", "close", workspaceId], { timeout: 5000 }); return true; }
  catch { return herdrWorkspaceExists(workspaceId, session) === false; }
}

function stopDeleteHerdrSession(session) {
  if (!session || session === WORKER_HERDR_SESSION) return true;
  let stopped = true;
  try { herdr(["session", "stop", session], { timeout: 5000 }); } catch { stopped = false; }
  try { herdr(["session", "delete", session], { timeout: 5000 }); } catch { stopped = false; }
  return stopped;
}

async function ensureHerdrSession(session) {
  try {
    herdrFor(session, ["workspace", "list"], { timeout: 2000 });
    return;
  } catch { /* start below */ }

  const child = spawn("herdr", ["--session", session, "server"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      herdrFor(session, ["workspace", "list"], { timeout: 2000 });
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Herdr worker session did not become ready: ${session}`);
}

// ── Config ──

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return { mindModel: "", workerModel: "openai/gpt-6-luna", workerCount: 3, workerModels: null };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { mindModel: "", workerModel: "openai/gpt-6-luna", workerCount: 3, workerModels: null };
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
    const wm = cfg.workerModel || "openai/gpt-6-luna";
    for (let i = 0; i < wc; i++) resolved.push({ model: wm, tier: "flash" });
  }
  return resolved;
}

// ── Manifest / Control ──

function writeManifest(path, cwd, hash, gen, wc, instance = null) {
  const wsDir = workerSessDir(hash, 0);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({
    cwd, cwdHash: hash, generation: gen, workerCount: wc,
    instance: instance || null,
    ...(instance ? { label: `${basename(cwd) || cwd} (${instance})` } : {}),
    state: "starting", lastUpdated: Date.now(), startedAt: Date.now(),
    mindPid: null, mindSupervisorPid: process.pid, mindChildPid: null, workerPid: null,
    launcherPid: process.pid, mindInPlace: true,
    launcherTokenHash: createHash("sha256").update(LAUNCHER_TOKEN).digest("hex"),
    mindPaneId: env.HERDR_PANE_ID || null, workerPaneId: null,
    mindRole: "mind", workerRole: "worker",
    workerTabId: null, mindSessionDir: "", workerSessionDir: wsDir,
    workerHerdrSession: workerHerdrSession(hash), workerWorkspaceId: null,
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

function storePaneId(path, key, paneId, required = false) {
  try {
    const m = JSON.parse(readFileSync(path, "utf-8"));
    m[key] = paneId;
    m.lastUpdated = Date.now();
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(m, null, 2));
    renameSync(tmp, path);
    return true;
  } catch (error) {
    if (required) throw error;
    return false;
  }
}

function readManifest(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function updateManifest(path, updates, generation) {
  const manifest = readManifest(path);
  if (!manifest || manifest.generation !== generation) return;
  Object.assign(manifest, updates, { lastUpdated: Date.now() });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8");
  renameSync(tmp, path);
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

function closeManifestPanes(mp, generation, resources = null) {
  if (!existsSync(mp)) return generation === undefined;
  const m = readManifest(mp);
  if (!m || (generation !== undefined && m.generation !== generation)) return false;
  try {
    const workerSession = m.workerHerdrSession || resources?.session || null;
    const workerTabId = m.workerTabId || resources?.tabId;
    const workerWorkspaceId = m.workerWorkspaceId || resources?.workspaceId;
    const workerPaneIds = new Set([
      ...Object.keys(m).filter(key => key.startsWith("workerPaneId_")).map(key => m[key]),
      ...(resources?.panes || []),
    ].filter(Boolean));
    let closed;
    if (workerWorkspaceId) {
      // The workspace owns its tab and panes; close it once to avoid stale tab IDs on retry.
      closed = herdrWorkspaceClose(workerWorkspaceId, workerSession);
    } else if (workerTabId) {
      closed = herdrTabClose(workerTabId, workerSession);
    } else {
      closed = true;
      for (const paneId of workerPaneIds) closed = herdrPaneClose(paneId, workerSession) && closed;
    }
    if (workerSession) closed = stopDeleteHerdrSession(workerSession) && closed;
    if (!m.mindInPlace && m.mindPaneId) closed = herdrPaneClose(m.mindPaneId) && closed;
    return closed;
  } catch { return false; }
}

function cleanupArtifacts(hash, generation) {
  const manifestPath = getManifestPath(hash);
  const verifyGeneration = () => {
    if (generation === undefined) return true;
    return readManifest(manifestPath)?.generation === generation;
  };
  if (!verifyGeneration()) return false;
  const removePath = path => {
    try { rmSync(path, { recursive: true, force: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  try {
    // Keep the manifest as the retry record until every other artifact is gone.
    for (const entry of readdirSync(STATE_DIR)) {
      const path = join(STATE_DIR, entry);
      if (entry.startsWith(hash) && path !== manifestPath) removePath(path);
    }
    for (const entry of readdirSync(SESSIONS_DIR)) {
      if (entry.startsWith(`worker-${hash}-`) || entry.startsWith(`burst-flash-${hash}-`)) {
        removePath(join(SESSIONS_DIR, entry));
      }
    }
    if (!verifyGeneration()) return false;
    removePath(manifestPath);
    return true;
  } catch (error) {
    console.error("Reset cleanup failed; ownership manifest retained: " + error.message);
    return false;
  }
}

async function cleanupGeneration(hash, generation, resources = null) {
  const manifestPath = getManifestPath(hash);
  if (!closeManifestPanes(manifestPath, generation, resources)) {
    throw new Error("Reset cleanup refused: pane closure failed or manifest generation changed.");
  }
  await sleep(1000);
  if (!cleanupArtifacts(hash, generation)) {
    throw new Error("Reset cleanup refused: pane closure failed or manifest generation changed.");
  }
}

function getResetRequestPath(hash) {
  return join(STATE_DIR, `${hash}-reset-request.json`);
}

function writeResetRequest(hash, request) {
  const path = getResetRequestPath(hash);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(request), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

async function requestInPlaceReset(hash, manifest) {
  const pid = Number(env.PI_MIND_WORKER_LAUNCHER_PID);
  const generation = Number(env.PI_MIND_WORKER_GENERATION);
  const token = env.PI_MIND_WORKER_LAUNCHER_TOKEN || "";
  const recovery = "If Mind remains open, exit it in its original pane, then relaunch bin/mind-worker-launcher.";
  if (
    !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid ||
    !Number.isSafeInteger(generation) || !/^[a-f0-9]{32}$/.test(token) ||
    !manifest?.mindInPlace || !["starting", "running"].includes(manifest.state) ||
    manifest.launcherPid !== pid || manifest.generation !== generation ||
    manifest.launcherTokenHash !== createHash("sha256").update(token).digest("hex")
  ) {
    throw new Error("Cannot authenticate reset request. " + recovery);
  }
  try { process.kill(pid, 0); } catch {
    throw new Error("Mind supervisor " + pid + " is no longer running. " + recovery);
  }
  const request = { pid, generation, token };
  const path = getResetRequestPath(hash);
  writeResetRequest(hash, request);
  const deadline = Date.now() + 20000;
  while (existsSync(path) && Date.now() < deadline) await sleep(100);
  if (existsSync(path)) {
    try {
      const pending = JSON.parse(readFileSync(path, "utf-8"));
      if (pending.pid === pid && pending.generation === generation && pending.token === token) unlinkSync(path);
    } catch { /* leave a replacement request untouched */ }
    throw new Error("Mind launcher did not acknowledge reset. " + recovery);
  }
  console.log("Reset request accepted by launcher " + pid + " (generation " + generation + ").");
}

function pollResetRequest() {
  if (shutdownSignal || !activeHash || activeGeneration === null || resetRequested) return;
  const path = getResetRequestPath(activeHash);
  let request;
  try { request = JSON.parse(readFileSync(path, "utf-8")); } catch { return; }
  const manifest = readManifest(getManifestPath(activeHash));
  if (
    request.pid !== process.pid || request.generation !== activeGeneration || request.token !== LAUNCHER_TOKEN ||
    manifest?.launcherPid !== process.pid || manifest?.generation !== activeGeneration || !manifest.mindInPlace ||
    manifest.launcherTokenHash !== createHash("sha256").update(LAUNCHER_TOKEN).digest("hex")
  ) return;
  try { unlinkSync(path); } catch { return; }
  resetRequested = true;
}

function buildMindArgs(model) {
  return model ? ["--model", model] : [];
}

function buildMindEnv(generation) {
  return {
    ...env,
    PI_MIND_WORKER_ROLE: "mind",
    ...(activeInstance ? { PI_MIND_WORKER_INSTANCE: activeInstance } : {}),
    PI_MIND_WORKER_GENERATION: String(generation),
    PI_MIND_WORKER_LAUNCHER_PID: String(process.pid),
    PI_MIND_WORKER_LAUNCHER_TOKEN: LAUNCHER_TOKEN,
  };
}

function buildWorkerCmd(cwd, gen, workerId, tier, model, sessionDir) {
  return `cd ${shellQuote(cwd)} && exec env ${activeInstance ? `PI_MIND_WORKER_INSTANCE=${activeInstance} ` : ""}PI_MIND_WORKER_ROLE=worker PI_MIND_WORKER_GENERATION=${gen} PI_MIND_WORKER_ID=${workerId} PI_MIND_WORKER_TIER=${tier} PI_MIND_WORKER_SESSION_DIR=${shellQuote(sessionDir)} ${shellQuote(PI_BIN)} --model ${shellQuote(model)} --thinking max --session-dir ${shellQuote(sessionDir)}`;
}

// ── Wait helpers ──

function checkMindStartup() {
  pollResetRequest();
  if (shutdownSignal) throw new Error("Launcher shutdown requested");
  if (resetRequested) throw new Error("Mind reset requested");
  if (activeMindExit) {
    const { error, code, signal } = activeMindExit;
    const failure = new Error(error?.message || `Mind exited before startup completed (code=${code}, signal=${signal})`);
    failure.mindExit = activeMindExit;
    throw failure;
  }
}

async function waitMindReady(hash, gen, timeoutSec = 60) {
  const cp = getControlPath(hash);
  const sock = join(STATE_DIR, `${hash}.sock`);
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    checkMindStartup();
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
    checkMindStartup();
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

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function markStopped(hash, generation, resourcesClosed) {
  const path = getManifestPath(hash);
  const manifest = readManifest(path);
  if (!manifest || manifest.generation !== generation) return;
  try { unlinkSync(join(STATE_DIR, hash + ".sock")); } catch {}
  const clearedWorkers = {};
  if (resourcesClosed) {
    for (const key of Object.keys(manifest)) {
      if (key.startsWith("workerPaneId_")) clearedWorkers[key] = null;
    }
  }
  updateManifest(path, {
    ...clearedWorkers,
    state: resourcesClosed ? "stopped" : "running",
    launcherPid: null,
    mindSupervisorPid: null,
    mindPid: null,
    workerTabId: resourcesClosed ? null : manifest.workerTabId,
    workerWorkspaceId: resourcesClosed ? null : manifest.workerWorkspaceId,
  }, generation);
  const controlPath = getControlPath(hash);
  try {
    if (JSON.parse(readFileSync(controlPath, "utf-8")).generation === generation) {
      writeControl(controlPath, generation, "stopped");
    }
  } catch { /* control file may be absent */ }
}

function mindExitCode(result) {
  if (shutdownSignal) return 128 + (osConstants.signals[shutdownSignal] || 1);
  if (result && result.error) return 127;
  if (result && result.code !== null && result.code !== undefined) return result.code;
  if (result && result.signal) return 128 + (osConstants.signals[result.signal] || 1);
  return 1;
}

function startMind(cwd, generation, model, manifestPath) {
  const child = spawn(PI_BIN, buildMindArgs(model), {
    cwd,
    env: buildMindEnv(generation),
    stdio: "inherit",
  });
  activeMind = child;
  activeMindExit = null;
  const exit = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeMindExit = result;
      resolve(result);
    };
    child.once("error", (error) => finish({ error, code: null, signal: null }));
    child.once("exit", (code, signal) => finish({ code, signal, error: null }));
  });
  storePaneId(manifestPath, "mindPid", child.pid || null);
  return { child, exit };
}

async function waitForChildExit(exit, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exit,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateMind(child, exit) {
  if (!child) return activeMindExit;
  if (activeMindExit) return activeMindExit;
  try { child.kill("SIGTERM"); } catch {}
  let result = await waitForChildExit(exit, 5000);
  if (result) return result;
  try { child.kill("SIGKILL"); } catch {}
  result = await waitForChildExit(exit, 2000);
  if (result) return result;
  child.unref();
  return null;
}

function preserveUnterminatedMind(hash, generation, child) {
  try {
    const path = getManifestPath(hash);
    const manifest = readManifest(path);
    if (manifest?.generation !== generation) return;
    updateManifest(path, {
      state: "running",
      launcherPid: null,
      mindSupervisorPid: null,
      mindPid: child.pid || manifest.mindPid,
    }, generation);
  } catch { /* leave the existing ownership record untouched */ }
}

async function spawnWorkers(cwd, hash, generation, workers, manifestPath, resources) {
  const session = resources.session;
  const panes = resources.panes;
  checkMindStartup();
  await ensureHerdrSession(session);
  checkMindStartup();
  const workspaceId = herdrWorkspaceCreate(session, "workers-" + hash);
  resources.workspaceId = workspaceId;
  storePaneId(manifestPath, "workerWorkspaceId", workspaceId, true);
  await sleep(0);
  checkMindStartup();

  const createdTab = herdrTabCreate(workspaceId, "workers", session);
  resources.tabId = createdTab.tabId;
  storePaneId(manifestPath, "workerTabId", createdTab.tabId, true);
  await sleep(0);
  checkMindStartup();

  const first = workers[0];
  resources.panes.push(createdTab.rootPaneId);
  storePaneId(manifestPath, "workerPaneId_0", createdTab.rootPaneId, true);
  checkMindStartup();
  herdrPaneRun(createdTab.rootPaneId, buildWorkerCmd(cwd, generation, "worker-0", first.tier, first.model, workerSessDir(hash, 0)), session);
  await sleep(0);
  checkMindStartup();

  let previous = createdTab.rootPaneId;
  for (let i = 1; i < workers.length; i++) {
    checkMindStartup();
    const worker = workers[i];
    const ratio = +(1 / (workers.length - i + 1)).toFixed(3);
    const pane = herdrPaneSplit(previous, "right", { ratio, session });
    resources.panes.push(pane);
    storePaneId(manifestPath, "workerPaneId_" + i, pane, true);
    await sleep(0);
    checkMindStartup();
    herdrPaneRun(pane, buildWorkerCmd(cwd, generation, "worker-" + i, worker.tier, worker.model, workerSessDir(hash, i)), session);
    await sleep(0);
    checkMindStartup();
    previous = pane;
  }
  return { panes };
}

async function runGeneration(cwd, hash, generation, workerCount, workers, mindModel, instance = null) {
  const manifestPath = getManifestPath(hash);
  activeHash = hash;
  activeInstance = instance;
  activeGeneration = generation;
  activeMind = null;
  activeMindExit = null;
  resetRequested = false;

  writeManifest(manifestPath, cwd, hash, generation, workerCount, instance);
  writeControl(getControlPath(hash), generation, "");
  try { unlinkSync(getResetRequestPath(hash)); } catch {}
  for (let i = 0; i < workerCount; i++) ensureDir(workerSessDir(hash, i));
  const workerResources = { session: workerHerdrSession(), workspaceId: null, tabId: null, panes: [] };

  let child;
  let childExit;
  try {
    console.log("=== Mind-Pair Launcher (herdr, in-place) ===");
    console.log("  CWD:     " + cwd);
    console.log("  Hash:    " + hash);
    console.log("  Gen:     " + generation);
    console.log("  Workers: " + workerCount);
    console.log("  Starting Mind in this pane...");

    const started = startMind(cwd, generation, mindModel, manifestPath);
    child = started.child;
    childExit = started.exit;
    await waitMindReady(hash, generation, 60);
    checkMindStartup();
    const spawned = await spawnWorkers(cwd, hash, generation, workers, manifestPath, workerResources);
    await waitWorkersConnected(hash, generation, spawned.panes.length, 10 + workerCount * 5);
    while (!activeMindExit) {
      checkMindStartup();
      await waitForChildExit(childExit, 250);
    }
    const result = await childExit;
    if (resetRequested) {
      await cleanupGeneration(hash, generation, workerResources);
      return { reset: true };
    }
    console.log("Mind exited (code=" + result.code + ", signal=" + result.signal + ").");
    const resourcesClosed = closeManifestPanes(manifestPath, generation, workerResources);
    markStopped(hash, generation, resourcesClosed);
    return { exit: result };
  } catch (error) {
    if (child && !activeMindExit) {
      const stopped = await terminateMind(child, childExit);
      if (!stopped) {
        preserveUnterminatedMind(hash, generation, child);
        return { exit: { code: 1, signal: null } };
      }
    }
    if (childExit) await childExit;
    if (resetRequested) {
      await cleanupGeneration(hash, generation, workerResources);
      return { reset: true };
    }
    const resourcesClosed = closeManifestPanes(manifestPath, generation, workerResources);
    if (shutdownSignal) {
      markStopped(hash, generation, resourcesClosed);
      return { exit: activeMindExit || { signal: shutdownSignal } };
    }
    if (error.mindExit) {
      markStopped(hash, generation, resourcesClosed);
      return { exit: error.mindExit };
    }
    markStopped(hash, generation, resourcesClosed);
    throw error;
  } finally {
    activeMind = null;
    activeMindExit = null;
    activeGeneration = null;
    activeHash = null;
    activeInstance = null;
    resetRequested = false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let resetFlag = false;
  let explicitCwd = null;
  let instance = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reset") resetFlag = true;
    if (argv[i] === "--cwd" && i + 1 < argv.length) explicitCwd = argv[++i];
    if (argv[i] === "--instance" && i + 1 < argv.length) instance = argv[++i];
  }

  if (instance !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/.test(instance)) {
    throw new Error("--instance must be 1-24 chars of [A-Za-z0-9._-], starting with a letter or digit.");
  }

  const cwd = realpathSync(explicitCwd || process.cwd());
  const hash = getCwdHash(cwd);
  // Label goes first so instance artifacts never share a prefix with the default ones.
  const id = instance ? `${instance}-${hash}` : hash;
  const manifestPath = getManifestPath(id);
  ensureDir(STATE_DIR);
  ensureDir(SESSIONS_DIR);

  let manifest = readManifest(manifestPath);
  const pairLive = isPairLive(id);
  if (resetFlag || pairLive) {
    if (env.PI_MIND_WORKER_LAUNCHER_PID || env.PI_MIND_WORKER_LAUNCHER_TOKEN) {
      await requestInPlaceReset(id, manifest);
      return;
    }
    if (manifest && manifest.mindInPlace) {
      const launcherAlive = isPidAlive(manifest.launcherPid);
      const mindAlive = isPidAlive(manifest.mindPid);
      if (!launcherAlive && mindAlive) {
        throw new Error("Mind remains in its original pane but its launcher is gone. Exit that Pi there, then relaunch bin/mind-worker-launcher.");
      }
      if (launcherAlive || mindAlive) {
        throw new Error("A Mind launcher or process appears active. Use /mind-reset only from a responsive Mind; otherwise exit any remaining Pi in its original pane, then relaunch bin/mind-worker-launcher.");
      }
    }
    if (!resetFlag && pairLive) {
      console.log("Pair already running for id " + id + ". Running reset...");
      resetFlag = true;
    }
  }

  if (resetFlag && manifest && manifest.mindPaneId && !manifest.mindInPlace &&
      !process.stdin.isTTY && !process.stdout.isTTY && !process.stderr.isTTY) {
    throw new Error("This is a legacy split Mind; rerun bin/mind-worker-launcher --reset from an interactive Herdr shell.");
  }

  let generation = (manifest && manifest.generation || 0) + 1;
  const cfg = loadConfig();
  const mindModel = cfg.mindModel || "";
  const workers = resolveWorkers(cfg);
  const workerCount = workers.length;

  if (resetFlag) {
    console.log("=== Reset (herdr) ===");
    console.log("  Previous generation: " + (generation - 1));
    if (!closeManifestPanes(manifestPath, manifest?.generation)) {
      throw new Error("Reset cleanup refused: pane closure failed or manifest generation changed.");
    }
    await sleep(1000);
    if (!cleanupArtifacts(id, manifest?.generation)) {
      throw new Error("Reset cleanup refused: pane closure failed or manifest generation changed.");
    }
  }

  while (true) {
    if (shutdownSignal) {
      process.exitCode = 128 + (osConstants.signals[shutdownSignal] || 1);
      return;
    }
    const result = await runGeneration(cwd, id, generation, workerCount, workers, mindModel, instance);
    if (result.reset) {
      generation++;
      continue;
    }
    process.exitCode = mindExitCode(result.exit);
    return;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!shutdownSignal) shutdownSignal = signal;
  });
}

main().catch((err) => {
  console.error("FATAL: " + err.message);
  process.exitCode = 1;
});
