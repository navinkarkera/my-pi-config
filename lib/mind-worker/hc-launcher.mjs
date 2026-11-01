#!/usr/bin/env node

// hc-launcher.mjs — run Mind plus static workers as hc (herdr-core) terminals.
//
// Entry point: bin/mind-worker-launcher, started with the shell builtin `exec`
// in an existing parentless app terminal (the root). That wrapper owns the TTY
// and foreground-process-group gate; this module owns the hc contract:
//   - root preflight: HC_TERMINAL_ID resolves to a live, parentless terminal
//     whose recorded pid is this process (proof that exec replaced the shell);
//   - manifest v2: a live pair is refused, a legacy record that can still be
//     running is refused with instructions, a legacy record nothing can still
//     be running in is archived (renamed, never deleted) and replaced, and a
//     stale v2 record is refreshed under a new generation;
//   - Mind runs in this terminal; every static worker is a direct
//     `--rm --no-notify` hc child of the root (argv only, identity env only);
//   - INT/TERM/HUP stop Mind within a bounded time and exit non-zero. The core
//     owns worker teardown: no pool-wide kill, no reset, no session sweep.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, realpathSync } from "node:fs";
import { homedir, constants as osConstants } from "node:os";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { env } from "node:process";
import { resolveThinkingLevel } from "./thinking-level.mjs";
import { getTerminal, probeCoreIdentity, spawnWorkerTerminal, workerTerminalName } from "./hc-terminal.mjs";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT_DIR, "mindworker");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const CONFIG_FILE = join(AGENT_DIR, "mind-worker.json");
const MISE = "/usr/bin/mise";
const NODE_VERSION = "node@26";
const BACKEND = "hc";
const SCHEMA_VERSION = 2;
// hc run --bg can reply before the terminal's pid is recorded (probe §4).
const ROOT_PID_WAIT_MS = 3000;

let activeMind = null;
let activeMindExit = null;
let shutdownSignal = null;

// ── Helpers ──

function getCwdHash(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

const getManifestPath = (id) => join(STATE_DIR, `${id}-manifest.json`);
const getControlPath = (id) => join(STATE_DIR, `${id}-mind-control.json`);
const getMindLogPath = (id, gen) => join(STATE_DIR, `${id}-mind-gen${gen}.log`);
const getSocketPath = (id) => join(STATE_DIR, `${id}.sock`);
const workerSessDir = (id, i) => join(SESSIONS_DIR, `worker-${id}-${i}`);
const ensureDir = (p) => { if (!existsSync(p)) mkdirSync(p, { recursive: true }); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Core selector and identity ──

/** hc silently picks another (default) core when HC_SESSION is absent. */
function requireCoreSelector(clientEnv = env) {
  const session = (clientEnv.HC_SESSION || "").trim();
  const socket = (clientEnv.HC_SOCKET || "").trim();
  if (!session && !socket) {
    throw new Error("HC_SESSION (or HC_SOCKET) is not set: hc would silently select a different core. Start this from a herdr-app (hc) terminal.");
  }
}

/** Pin the actual core before any terminal query or spawn. */
async function probeCore(clientEnv = env) {
  const identity = await probeCoreIdentity({ env: clientEnv });
  const id = identity?.id;
  if (typeof id !== "string" || !id) {
    throw new Error("hc did not report a core id: refusing to start without a pinned core (unavailable or ambiguous core).");
  }
  return {
    id,
    name: identity.name ?? null,
    version: identity.version ?? null,
    session: identity.session ?? null,
    socket: identity.socket ?? null,
  };
}

/** Absolute executable from PATH (or an explicit path); never forces node. */
function resolveExecutable(command) {
  const value = String(command || "");
  if (!value) throw new Error("PI_BIN is empty");
  const candidates = value.includes("/")
    ? [resolve(value)]
    : (env.PATH || "").split(":").filter(Boolean).map((dir) => join(dir, value));
  for (const candidate of candidates) {
    try { accessSync(candidate, osConstants.X_OK); return candidate; } catch { /* next */ }
  }
  throw new Error(`PI_BIN ${value} is not an executable file${value.includes("/") ? "" : " on PATH"}`);
}

/** The Node preflight cannot be bypassed by launching the module directly. */
function assertInteractiveRoot() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new Error("Mind must run in its terminal: stdin, stdout and stderr must be TTYs.");
  }
  const probe = spawnSync("ps", ["-o", "pgid=", "-o", "tpgid=", "-p", String(process.pid)], { encoding: "utf-8", timeout: 5000 });
  const [pgid, tpgid] = probe.status === 0 ? (probe.stdout || "").trim().split(/\s+/).map(Number) : [];
  if (!Number.isSafeInteger(pgid) || !Number.isSafeInteger(tpgid) || pgid <= 0 || pgid !== tpgid) {
    throw new Error("Mind must run in the foreground process group of its terminal.");
  }
}

/** hc get can report pid:null right after --bg; poll bounded, never guess. */
async function waitRootRecord(rootAddress, expectedCoreId, clientEnv, timeoutMs = ROOT_PID_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let record = null;
  while (Date.now() < deadline) {
    record = await getTerminal(rootAddress, { expectedCoreId, env: clientEnv });
    if (!record) return null;
    if (record.pid !== null && record.pid !== undefined) return record;
    await sleep(100);
  }
  return record;
}

/** An absent manifest is fresh; unreadable or malformed is fail-closed. */
function readManifestState(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "absent" };
    throw new Error(`Refusing to start: cannot read ${path} (${error.message}). Fix or archive it.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Refusing to start: ${path} is not valid JSON (${error.message}). Fix or archive it.`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Refusing to start: ${path} is not a manifest object. Fix or archive it.`);
  }
  return { kind: "present", manifest };
}

/** A Mind exit 0 before readiness is still a startup failure. */
function normalizeStartupExit(exit) {
  if (!exit) return { code: 1, signal: null };
  if (exit.code === 0) return { ...exit, code: 1 };
  return exit;
}

/** Termination was not confirmed: never claim stopped. */
function preserveUnterminatedMind(manifestPath, generation, child) {
  try {
    const manifest = readManifest(manifestPath);
    if (!manifest || manifest.generation !== generation) return;
    updateManifest(manifestPath, { state: "running", launcherPid: null, mindPid: child?.pid ?? manifest.mindPid }, generation);
  } catch { /* leave the record as it is */ }
}

/** Full cwd + instance + generation in 12 hex chars; fits hc's 32-char name. */
function runIdFor(cwd, instance, generation) {
  return createHash("sha256").update(`${cwd}\0${instance || ""}\0${generation}`).digest("hex").slice(0, 12);
}

function readManifest(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function writeJsonAtomic(path, value) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function writeManifest(path, { cwd, hash, id, generation, workerCount, instance, rootAddress, core }) {
  const now = Date.now();
  writeJsonAtomic(path, {
    schemaVersion: SCHEMA_VERSION,
    terminalBackend: BACKEND,
    coreIdentity: core,
    rootTerminalAddress: rootAddress,
    cwd,
    cwdHash: hash,
    instance: instance || null,
    generation,
    workerCount,
    state: "starting",
    startedAt: now,
    lastUpdated: now,
    launcherPid: process.pid,
    mindPid: null,
    workerAddresses: {},
    mindRole: "mind",
    workerRole: "worker",
    mindSessionDir: "",
    workerSessionDir: workerSessDir(id, 0),
  });
}

function updateManifest(path, updates, generation) {
  const manifest = readManifest(path);
  if (!manifest || manifest.generation !== generation) return;
  writeJsonAtomic(path, { ...manifest, ...updates, lastUpdated: Date.now() });
}

function writeControl(path, generation, status = "") {
  writeJsonAtomic(path, { status, generation, lastUpdated: Date.now() });
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  // Missing/invalid settings keep the pre-settings behavior: workers on "max", Mind on Pi's default.
  const globalThinking = resolveThinkingLevel(cfg.workerThinkingLevel, "max");
  const resolved = [];
  if (Array.isArray(cfg.workerModels) && cfg.workerModels.length > 0) {
    for (const entry of cfg.workerModels) {
      for (let i = 0; i < entry.count; i++) {
        resolved.push({
          model: entry.model,
          tier: entry.tier || "flash",
          thinkingLevel: resolveThinkingLevel(entry.thinkingLevel, globalThinking),
        });
      }
    }
  } else {
    const count = cfg.workerCount || 3;
    const model = cfg.workerModel || "openai/gpt-6-luna";
    for (let i = 0; i < count; i++) resolved.push({ model, tier: "flash", thinkingLevel: globalThinking });
  }
  return resolved;
}

// ── Root preflight (before any worker exists) ──

async function rootPreflight(core, clientEnv) {
  const rootAddress = (clientEnv.HC_TERMINAL_ID || "").trim();
  if (!rootAddress) {
    throw new Error("HC_TERMINAL_ID is not set: start this from a herdr-app (hc) terminal, not a plain shell.");
  }
  const record = await waitRootRecord(rootAddress, core.id, clientEnv);
  if (!record) {
    throw new Error(`hc does not know terminal ${rootAddress}: its core is unreachable or the terminal is gone.`);
  }
  if (record.state !== "live") {
    throw new Error(`root terminal ${rootAddress} is ${record.state}; Mind needs a live terminal.`);
  }
  if (record.parent !== null) {
    throw new Error(`root terminal ${rootAddress} was started by ${record.parent}; Mind needs a parentless terminal. Open a new app terminal and run: exec ~/.pi/agent/bin/mind-worker-launcher`);
  }
  if (record.pid === null || record.pid === undefined) {
    throw new Error(`hc has not reported a pid for ${rootAddress}; refusing to guess root ownership. Retry once the terminal is fully started.`);
  }
  if (record.pid !== process.pid) {
    throw new Error(`this process is not the root program of ${rootAddress} (hc records pid ${record.pid}). Start it with the shell builtin exec so it replaces the terminal's shell: exec ~/.pi/agent/bin/mind-worker-launcher`);
  }
  return { rootAddress };
}

// ── Manifest v2: refuse live or legacy, archive legacy only when it is idle ──

// A legacy Mind heartbeats its control file about every 10s while it lives.
const LEGACY_HEARTBEAT_MS = 120_000;
const SOCKET_PROBE_MS = 2000;
// No supported system has a pid above the signed 32-bit range.
const PID_MAX = 2147483647;
// Every process the old launcher recorded: launcher/supervisor, Mind, worker.
const LEGACY_PID_KEYS = ["launcherPid", "mindSupervisorPid", "mindPid", "mindChildPid", "workerPid"];
// Fields only the old launcher wrote; without one, a stray file is not a pool.
const LEGACY_MARKERS = ["mindInPlace", "launcherTokenHash", "mindPaneId", "workerHerdrSession"];

/** Only an unversioned (v1) herdr record is legacy; anything else is unknown, not legacy. */
function isLegacyRecord(manifest) {
  const schema = manifest.schemaVersion;
  const backend = manifest.terminalBackend;
  const hasSchema = schema !== undefined && schema !== null;
  const hasBackend = backend !== undefined && backend !== null;
  if (hasSchema && schema !== 1) return false;
  if (hasBackend && backend !== "herdr") return false;
  if (hasSchema || hasBackend) return true;
  // Neither marker says which launcher wrote it, so an old-format field must.
  return LEGACY_MARKERS.some((key) => manifest[key] === true || (typeof manifest[key] === "string" && manifest[key] !== ""));
}

/** Only ESRCH proves a pid gone; a missing pid proves nothing, and a malformed one is not a stop. */
function pidState(pid) {
  if (pid === null || pid === undefined) return "absent";
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > PID_MAX) return "malformed";
  try { process.kill(pid, 0); return "alive"; } catch (error) { return error.code === "ESRCH" ? "gone" : "alive"; }
}

/** A listening pool server is live whatever its pids or heartbeat say. */
function socketState(socketPath) {
  // Always attempt the connect: existsSync can say false for a path it cannot
  // reach, and that must surface as an unknown error, not as "nothing listens".
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const settle = (state) => { socket.destroy(); resolve(state); };
    socket.on("connect", () => settle("listening"));
    // Only these two mean nothing listens; a timeout or EACCES may still be a live server.
    const disconnected = new Set(["ENOENT", "ECONNREFUSED"]);
    socket.on("error", (error) => settle(disconnected.has(error.code) ? "closed" : "unknown:" + (error.code || error.message)));
    socket.setTimeout(SOCKET_PROBE_MS, () => settle("unknown:probe timeout"));
  });
}

/**
 * Everything a legacy record must clear before its runtime files may be moved:
 * no listening socket, no live or unusable pid, and no recent activity. Returns
 * the first reason it may still be live, or null when nothing it records is
 * still running. That is evidence, not proof: a stop is inferred from a closed
 * socket, gone pids and an old timestamp.
 */
async function legacyStoppedReason(manifest, controlPath, socketPath) {
  const socket = await socketState(socketPath);
  if (socket === "listening") return "its runtime socket still accepts connections";
  if (socket !== "closed") return `its runtime socket could not be probed (${socket.slice(8)})`;
  for (const key of LEGACY_PID_KEYS) {
    const state = pidState(manifest?.[key]);
    if (state === "alive") return `its recorded ${key} ${manifest[key]} is still running`;
    if (state === "malformed") return `its recorded ${key} is not a usable pid`;
  }
  // Times are used as they are: a numeric string or a boolean is not a stamp.
  let control;
  try {
    control = readManifestState(controlPath);
  } catch (error) {
    // A broken control file is not proof of anything, least of all of a stop.
    return `its control file cannot be read (${String(error.message).split("\n")[0].replace("Refusing to start: ", "")})`;
  }
  if (control.kind === "absent") {
    // Booting legacy records have no control file yet, so their own stamp must be old too.
    const seen = manifest.lastUpdated;
    if (typeof seen !== "number" || !Number.isFinite(seen) || seen <= 0) {
      return "its record has no usable lastUpdated and no control file";
    }
    const idle = Date.now() - seen;
    if (idle < LEGACY_HEARTBEAT_MS) return `its record was updated ${Math.round(idle / 1000)}s ago and no control file proves it stopped`;
    return null;
  }
  const beat = control.manifest.lastHeartbeat ?? control.manifest.lastUpdated;
  if (typeof beat !== "number" || !Number.isFinite(beat) || beat <= 0) return "its control file has no usable heartbeat timestamp";
  const age = Date.now() - beat;
  if (age < LEGACY_HEARTBEAT_MS) return `its Mind wrote a heartbeat ${Math.round(age / 1000)}s ago`;
  return null;
}

/** The generation a stopped or stale record hands over: one past it, never a fallback. */
function nextGeneration(manifest, manifestPath) {
  const carried = manifest?.generation;
  if (!Number.isSafeInteger(carried) || carried <= 0 || carried === Number.MAX_SAFE_INTEGER) {
    throw new Error([
      `Refusing to take over ${manifestPath}: its generation ${JSON.stringify(carried)} cannot be carried forward, so a worker it left behind could not be fenced out.`,
      "Nothing was changed. Fix that record's generation, or archive it by hand, then relaunch.",
      instanceHint(),
    ].join("\n"));
  }
  return carried + 1;
}

/**
 * A stale v2 record may only recover when the Mind it recorded and its server
 * are gone too: otherwise the old pool is still alive and keeps its socket.
 */
async function stalePoolReason(manifest, socketPath) {
  const pid = pidState(manifest?.mindPid);
  if (pid === "alive") return `its recorded mindPid ${manifest.mindPid} is still running`;
  if (pid === "malformed") return `its recorded mindPid ${JSON.stringify(manifest.mindPid)} is not a usable pid`;
  const socket = await socketState(socketPath);
  if (socket === "listening") return "its runtime socket still accepts connections";
  if (socket !== "closed") return `its runtime socket could not be probed (${socket.slice(8)})`;
  return null;
}

/**
 * Move a legacy runtime nothing is known to still be running aside as a set by
 * renaming, never deleting: the manifest goes last, so a crash mid-archive
 * leaves the record in place and the next launch retries. A failed rename puts
 * back what was already moved. Sessions, transcripts, logs and results stay.
 */
function archiveStoppedLegacyRuntime(id, manifestPath, generation) {
  const stamp = Date.now();
  const moved = [];
  for (const path of [getSocketPath(id), getControlPath(id), manifestPath]) {
    if (!existsSync(path)) continue;
    let dest = `${path}.legacy-${stamp}`;
    for (let n = 2; existsSync(dest); n++) dest = `${path}.legacy-${stamp}-${n}`;
    try {
      renameSync(path, dest);
    } catch (error) {
      const stuck = [];
      for (const [src, to] of moved.reverse()) {
        try { renameSync(to, src); } catch (undo) { stuck.push(`${to} back to ${src} (${undo.message})`); }
      }
      throw new Error([
        `Refusing to start: cannot archive stopped legacy runtime state ${path} (${error.message}).`,
        stuck.length
          ? `Nothing was deleted, but the rollback failed too; move these back by hand: ${stuck.join("; ")}`
          : "Nothing was deleted, and everything already moved was put back.",
        instanceHint(),
      ].join("\n"));
    }
    moved.push([path, dest]);
  }
  const archived = moved.map(([, dest]) => dest);
  console.log(`Archived stopped legacy runtime state (generation ${generation}): ` + archived.join(", "));
  return { generation, mode: "fresh" };
}

function instanceHint() {
  return "To start a separate pool now without touching that record, relaunch with an unused instance name:"
    + " exec ~/.pi/agent/bin/mind-worker-launcher --instance alt";
}

function legacyRefusal(manifestPath, reason) {
  return new Error([
    `Refusing to take over a legacy mind-worker pool at ${manifestPath}.`,
    `Nothing was archived: ${reason}, so the pool may still be live.`,
    "Stop the live legacy pool (its Mind in its original pane) and archive that project's mindworker record,",
    "then relaunch bin/mind-worker-launcher. No automatic takeover and no cleanup was attempted.",
    instanceHint(),
  ].join("\n"));
}

async function resolveStartup(cwd, id, hash, core, clientEnv) {
  const manifestPath = getManifestPath(id);
  const state = readManifestState(manifestPath);
  if (state.kind === "absent") {
    // A manifest-less launch is fresh only if no runtime state survived. Never
    // take over or clean up an ambiguous control/socket by guessing.
    const controlPath = getControlPath(id);
    const socketPath = getSocketPath(id);
    if (existsSync(controlPath) || existsSync(socketPath)) {
      throw new Error([
        `Refusing a fresh start for ${cwd}: ${controlPath} or ${socketPath} exists without a v2 manifest.`,
        "Stop the existing pool (or the terminal that owns it), then archive that project's mindworker runtime state and relaunch.",
        "No automatic takeover or cleanup was attempted.",
        instanceHint(),
      ].join("\n"));
    }
    return { generation: 1, mode: "fresh" };
  }
  const existing = state.manifest;

  if (isLegacyRecord(existing)) {
    // Archiving moves another pool's files, so the record must first prove it is
    // this pool's: a wrong or missing cwdHash is an unknown identity, not a stop.
    // The old launcher stored the bare cwd hash, or the full instance id for an
    // instance pool; either one proves this record belongs to this pool.
    if (existing.cwdHash !== hash && existing.cwdHash !== id) {
      throw new Error([
        `Refusing to take over a legacy mind-worker pool at ${manifestPath}: its recorded cwdHash does not match ${cwd}.`,
        "Nothing was archived because its identity is unknown. Archive or remove that record by hand, then relaunch.",
        instanceHint(),
      ].join("\n"));
    }
    const reason = await legacyStoppedReason(existing, getControlPath(id), getSocketPath(id));
    if (reason) throw legacyRefusal(manifestPath, reason);
    return archiveStoppedLegacyRuntime(id, manifestPath, nextGeneration(existing, manifestPath));
  }
  // A v3 or another backend is not legacy: its runtime shape is unknown, so it fails closed.
  if (existing.schemaVersion !== SCHEMA_VERSION || existing.terminalBackend !== BACKEND) {
    throw new Error([
      `Refusing to take over ${manifestPath}: unsupported record (schemaVersion ${JSON.stringify(existing.schemaVersion)}, terminalBackend ${JSON.stringify(existing.terminalBackend)}).`,
      "Only v2/hc records recover, and only proven-stopped legacy records are archived. Nothing was changed.",
      instanceHint(),
    ].join("\n"));
  }

  // The actual core.id is the identity; HC_SCOPE/HC_TERMINAL_SOCKET are per-terminal.
  if (typeof existing.coreIdentity?.id !== "string" || !existing.coreIdentity.id) {
    throw new Error(`Refusing to take over ${manifestPath}: schema v2 record has no coreIdentity.id. Archive it and start a fresh pool.`);
  }
  if (existing.coreIdentity.id !== core.id) {
    throw new Error([
      `Refusing to take over ${manifestPath}: it belongs to a different hc core (id).`,
      "Stop that pool where it runs, or archive this project's mindworker record. Ambiguous cores fail closed.",
    ].join("\n"));
  }

  const rootAddress = existing.rootTerminalAddress;
  if (typeof rootAddress !== "string" || !rootAddress) {
    throw new Error(`Refusing to take over ${manifestPath}: schema v2 record has no rootTerminalAddress.`);
  }
  const record = await waitRootRecord(rootAddress, core.id, clientEnv);
  if (record && record.state === "live") {
    const owned = record.parent === null && record.pid === existing.launcherPid && isPidAlive(existing.launcherPid);
    if (!owned) {
      throw new Error(`Refusing to start a second pool for ${cwd}: root terminal ${rootAddress} is live but ownership is ambiguous. Stop it with: hc kill ${rootAddress}`);
    }
    throw new Error(`Mind is already running for ${cwd} in terminal ${rootAddress}. Stop that terminal (hc kill ${rootAddress}) or exit Mind there, then relaunch.`);
  }

  // Proven-stale root. Its Mind and server may still outlive it, so prove they
  // are gone before recovering: preserveUnterminatedMind keeps that record, and
  // the socket of a surviving server is never unlinked.
  const stillLive = await stalePoolReason(existing, getSocketPath(id));
  if (stillLive) {
    throw new Error([
      `Refusing to recover ${manifestPath}: ${stillLive}, so the previous pool may still be live.`,
      "Stop that Mind or its terminal, then relaunch. Nothing was unlinked or overwritten.",
      instanceHint(),
    ].join("\n"));
  }
  return { generation: nextGeneration(existing, manifestPath), mode: "recover" };
}

// ── Mind ──

function buildMindArgs(model, thinkingLevel) {
  const args = model ? ["--model", model] : [];
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  return args;
}

function buildMindEnv(generation, instance) {
  return {
    ...env,
    PI_MIND_WORKER_ROLE: "mind",
    ...(instance ? { PI_MIND_WORKER_INSTANCE: instance } : {}),
    PI_MIND_WORKER_GENERATION: String(generation),
    PI_MIND_WORKER_LAUNCHER_PID: String(process.pid),
  };
}

function startMind(cwd, id, generation, model, thinkingLevel, manifestPath, instance, piBin) {
  // Mind keeps the terminal's stdin/stdout (stdout is the TUI); stderr goes to a
  // per-generation file so extension diagnostics cannot paint over the editor.
  let logFd = null;
  try { logFd = openSync(getMindLogPath(id, generation), "a"); } catch { /* fall back to discarding stderr */ }
  let child;
  try {
    child = spawn(piBin, buildMindArgs(model, thinkingLevel), {
      cwd,
      env: buildMindEnv(generation, instance),
      stdio: ["inherit", "inherit", logFd ?? "ignore"],
    });
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
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
  updateManifest(manifestPath, { mindPid: child.pid || null }, generation);
  return { child, exit };
}

function shutdownError() {
  const error = new Error("Launcher shutdown requested");
  error.shutdown = true;
  return error;
}

function checkMindStartup() {
  if (shutdownSignal) throw shutdownError();
  if (activeMindExit) {
    const { error, code, signal } = activeMindExit;
    const failure = new Error(error?.message || `Mind exited before startup completed (code=${code}, signal=${signal})`);
    failure.mindExit = activeMindExit;
    throw failure;
  }
}

/** A unix socket that accepts a connection; bounded and always destroyed. */
function assertSocketConnectable(socketPath, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => { socket.destroy(); resolve(); });
    socket.on("error", (error) => { socket.destroy(); reject(error); });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error(`timeout after ${timeoutMs}ms`)); });
  });
}

async function waitMindReady(id, gen, timeoutSec = 60) {
  const controlPath = getControlPath(id);
  const socketPath = getSocketPath(id);
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    checkMindStartup();
    if (existsSync(controlPath)) {
      try {
        const data = JSON.parse(readFileSync(controlPath, "utf-8"));
        if (data.generation === gen && (data.status === "ready" || data.status === "worker-connected") && existsSync(socketPath)) {
          try {
            await assertSocketConnectable(socketPath);
            return;
          } catch { /* socket not connectable yet, keep polling */ }
        }
      } catch { /* parse error, keep polling */ }
    }
    await sleep(500);
  }
  throw new Error(`Mind did not become ready within ${timeoutSec}s (id: ${id})`);
}

async function waitWorkersConnected(id, gen, expected, timeoutSec = 60) {
  const controlPath = getControlPath(id);
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    checkMindStartup();
    if (existsSync(controlPath)) {
      try {
        const data = JSON.parse(readFileSync(controlPath, "utf-8"));
        if (data.generation === gen && data.status === "worker-connected" && (data.connectedWorkers || 0) >= expected) return;
      } catch { /* keep polling */ }
    }
    await sleep(500);
  }
  throw new Error(`Not all workers connected within ${timeoutSec}s (id: ${id})`);
}

async function waitForChildExit(exit, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exit,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateMind(child, exit) {
  if (!child) return activeMindExit;
  if (activeMindExit) return activeMindExit;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  let result = await waitForChildExit(exit, 5000);
  if (result) return result;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  result = await waitForChildExit(exit, 2000);
  if (result) return result;
  child.unref();
  return null;
}

// ── Workers ──

function workerArgv(worker, sessionDir, piBin) {
  const args = [];
  if (worker.model) args.push("--model", worker.model);
  if (worker.thinkingLevel) args.push("--thinking", worker.thinkingLevel);
  args.push("--session-dir", sessionDir);
  return [MISE, "x", NODE_VERSION, "--", piBin, ...args];
}

function workerIdentity({ workerId, tier, generation, sessionDir, instance }) {
  return {
    PI_MIND_WORKER_ROLE: "worker",
    PI_MIND_WORKER_TIER: tier,
    PI_MIND_WORKER_ID: workerId,
    PI_MIND_WORKER_GENERATION: String(generation),
    PI_MIND_WORKER_SESSION_DIR: sessionDir,
    ...(instance ? { PI_MIND_WORKER_INSTANCE: instance } : {}),
  };
}

// ── One pool generation ──

function markStopped(id, generation) {
  const path = getManifestPath(id);
  const manifest = readManifest(path);
  if (!manifest || manifest.generation !== generation) return;
  updateManifest(path, { state: "stopped", launcherPid: null, mindPid: null }, generation);
  try {
    if (JSON.parse(readFileSync(getControlPath(id), "utf-8")).generation === generation) {
      writeControl(getControlPath(id), generation, "stopped");
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

async function runGeneration({ cwd, id, hash, generation, workers, mindModel, mindThinking, instance, rootAddress, core, piBin, clientEnv }) {
  // A signal received during preflight must not spawn Mind at all.
  if (shutdownSignal) return { exit: { signal: shutdownSignal } };
  const manifestPath = getManifestPath(id);
  activeMind = null;
  activeMindExit = null;

  writeManifest(manifestPath, { cwd, hash, id, generation, workerCount: workers.length, instance, rootAddress, core });
  writeControl(getControlPath(id), generation, "");
  for (let i = 0; i < workers.length; i++) ensureDir(workerSessDir(id, i));

  let child;
  let childExit;
  try {
    console.log("=== Mind-Pair Launcher (hc) ===");
    console.log("  Root:    " + rootAddress);
    console.log("  CWD:     " + cwd);
    console.log("  Gen:     " + generation);
    console.log("  Workers: " + workers.length);
    console.log("  Starting Mind in this terminal...");

    if (shutdownSignal) throw shutdownError();
    const started = startMind(cwd, id, generation, mindModel, mindThinking, manifestPath, instance, piBin);
    child = started.child;
    childExit = started.exit;
    await waitMindReady(id, generation, 60);
    checkMindStartup();

    const runId = runIdFor(cwd, instance, generation);
    const addresses = {};
    for (let i = 0; i < workers.length; i++) {
      checkMindStartup();
      const worker = workers[i];
      const workerId = `worker-${i}`;
      const sessionDir = workerSessDir(id, i);
      const { address } = await spawnWorkerTerminal({
        rootAddress,
        name: workerTerminalName(runId, "worker", i),
        cwd,
        argv: workerArgv(worker, sessionDir, piBin),
        env: workerIdentity({ workerId, tier: worker.tier, generation, sessionDir, instance }),
        expectedCoreId: core.id,
        clientEnv,
      });
      addresses[workerId] = address;
      updateManifest(manifestPath, { workerAddresses: { ...addresses } }, generation);
      console.log("  " + workerId + " -> " + address);
    }

    await waitWorkersConnected(id, generation, workers.length, 10 + workers.length * 5);
    // Readiness is complete: a Mind exit from here on is normal, not a startup failure.
    updateManifest(manifestPath, { state: "running" }, generation);
    while (!activeMindExit) {
      if (shutdownSignal) throw shutdownError();
      await waitForChildExit(childExit, 250);
    }
    const result = await childExit;
    console.log("Mind exited (code=" + result.code + ", signal=" + result.signal + ").");
    markStopped(id, generation);
    return { exit: result };
  } catch (error) {
    // Bounded: terminateMind waits at most 5s + 2s. Never wait on childExit again:
    // if termination was not confirmed, the record must say so.
    const termination = child && !activeMindExit ? await terminateMind(child, childExit) : activeMindExit;
    if (child && termination === null) {
      preserveUnterminatedMind(manifestPath, generation, child);
      if (shutdownSignal) return { exit: { signal: shutdownSignal } };
      throw error;
    }
    markStopped(id, generation);
    if (shutdownSignal) return { exit: { signal: shutdownSignal } };
    if (error.mindExit) return { exit: normalizeStartupExit(error.mindExit) };
    throw error;
  } finally {
    activeMind = null;
    activeMindExit = null;
  }
}

// ── Lifetime guard ──

/**
 * One pool per cwd+instance, acquired before the manifest is read or claimed and
 * before any Mind/worker exists. flock(2) locks the shared open file description,
 * so the parent Node process keeps the lock after the short flock child exits;
 * SIGKILL closes the fd and releases it for stale recovery. The lock file is
 * never unlinked (inode race); there is no PID or token authentication.
 */
function acquireLifetimeLock(id) {
  const lockPath = join(STATE_DIR, `${id}.launcher.lock`);
  let fd;
  try {
    fd = openSync(lockPath, "a", 0o600);
  } catch (error) {
    throw new Error(`Cannot open the launcher lock ${lockPath}: ${error.message}`);
  }
  const fail = (message) => {
    try { closeSync(fd); } catch { /* already closed */ }
    throw new Error(message);
  };
  const result = spawnSync("flock", ["--nonblock", "3"], {
    stdio: ["ignore", "pipe", "pipe", fd],
    timeout: 5000,
  });
  if (result.error) {
    fail(`flock is required to keep one pool per cwd+instance: ${result.error.message}`);
  }
  if (result.status === 1) {
    fail(`Another mind-worker launcher already holds ${lockPath}. Stop it, or use a different --instance.`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "").toString().trim();
    fail(`flock could not lock ${lockPath} (status ${result.status}${detail ? `: ${detail}` : ""}); refusing to start without the lifetime guard.`);
  }
  return { fd, path: lockPath };
}

// ── Main ──

async function main() {
  const argv = process.argv.slice(2);
  let explicitCwd = null;
  let instance = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && i + 1 < argv.length) explicitCwd = argv[++i];
    else if (argv[i] === "--instance" && i + 1 < argv.length) instance = argv[++i];
    else if (argv[i] === "--reset") {
      throw new Error("Whole-pool reset is gone. Stop the root terminal and start a fresh one.");
    }
  }
  if (instance !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/.test(instance)) {
    throw new Error("--instance must be 1-24 chars of [A-Za-z0-9._-], starting with a letter or digit.");
  }

  const cwd = realpathSync(explicitCwd || process.cwd());
  const hash = getCwdHash(cwd);
  const id = instance ? `${instance}-${hash}` : hash;
  ensureDir(STATE_DIR);
  ensureDir(SESSIONS_DIR);

  // Acquire before reading the manifest or claiming the pool. Held until exit,
  // including SIGKILL, so a crash cannot leave a stale lock.
  const lock = acquireLifetimeLock(id);
  // hc sets HC_TERMINAL_SOCKET to the owning core's socket, but hc does not
  // read it as a selector. Pin it explicitly instead of accepting the default.
  const terminalSocket = (env.HC_TERMINAL_SOCKET || "").trim();
  const useTerminalSocket = !env.HC_SESSION?.trim() && !env.HC_SOCKET?.trim() && Boolean(terminalSocket);
  let exit;
  try {
    const cfg = loadConfig();
    if (cfg.terminalBackend !== BACKEND) {
      throw new Error(`mind-worker.json terminalBackend must be "${BACKEND}" (found ${JSON.stringify(cfg.terminalBackend ?? null)}).`);
    }

    if (useTerminalSocket) {
      if (!(env.HC_TERMINAL_ID || "").trim()) {
        throw new Error("HC_TERMINAL_ID is not set: start this from a herdr-app (hc) terminal, not a plain shell.");
      }
      // hc server status can start a core at a stale socket; prove this one is
      // already live, so the fallback cannot create or select another core.
      try {
        await assertSocketConnectable(terminalSocket);
      } catch (error) {
        throw new Error(`HC_TERMINAL_SOCKET ${terminalSocket} is not reachable (${error.message}); refusing to let hc start or select another core.`);
      }
      env.HC_SOCKET = terminalSocket;
    }
    // One selector snapshot for probing, every root read and every spawn. A
    // later process.env change can never redirect the pool to another core.
    const clientEnv = { ...env };

    // No hc query before the selector is explicit: a missing HC_SESSION silently
    // selects a different (default) core. Then pin the actual core id.
    requireCoreSelector(clientEnv);
    const core = await probeCore(clientEnv);
    const { rootAddress } = await rootPreflight(core, clientEnv);
    const startup = await resolveStartup(cwd, id, hash, core, clientEnv);
    const { generation } = startup;
    if (startup.mode === "recover") {
      // Recovery proved nothing listens here, so this only clears a stale inode.
      try { unlinkSync(getSocketPath(id)); } catch { /* absent */ }
    }

    const workers = resolveWorkers(cfg);
    const piBin = resolveExecutable(env.PI_BIN || "pi");
    // Last gate before any spawn: a direct module launch cannot skip the TTY check.
    assertInteractiveRoot();
    exit = (await runGeneration({
      cwd, id, hash, generation, workers,
      mindModel: cfg.mindModel || "",
      mindThinking: resolveThinkingLevel(cfg.mindThinkingLevel),
      instance, rootAddress, core, piBin, clientEnv,
    })).exit;
  } finally {
    try { closeSync(lock.fd); } catch { /* already closed */ }
  }
  process.exitCode = mindExitCode(exit);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!shutdownSignal) shutdownSignal = signal;
  });
}

main().catch((error) => {
  console.error("FATAL: " + error.message);
  process.exitCode = 1;
});
