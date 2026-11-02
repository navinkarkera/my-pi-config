#!/usr/bin/env node

// tmux-terminal.mjs - the one place that starts, reads and retires tmux worker
// terminals for the mind-worker pool (static workers and native bursts).
//
// tmux is the host: Mind is the pool's root pane program (the launcher execs
// itself there), every worker is a direct argv child in ONE reserved worker
// window, and the v3 record in the state dir carries the server tuple, the
// session, the root pane, the worker window, the owned panes and the owned
// global hook entries. Nothing here talks to hc, the scheduler, the extension
// or the dashboard.
//
// Ownership is proved, never guessed:
//   - every tmux call is "tmux -S <socket> -N <cmd>" with an explicit
//     $session / @window / %pane id captured earlier (-N never starts a
//     server);
//   - the root program is the pane's own pid (pane_pid == expected pid), so a
//     shell-wrapped, non-exec launch is refused before any worker exists;
//   - a worker pane is owned only while its four @mind.* markers, its window,
//     its pid and its start command still match the record;
//   - the worker process itself is a trusted wrapper from this module, exec'd
//     directly by tmux, which proves the pool/root and registers the pane
//     before it execve()s the real argv (pane_pid survives the execve).
//
// The hook helper (tmux-cleanup.mjs) uses the same record and locks. The
// server-global hook entries are recorded with their index and exact command;
// removal proves both before unsetting anything.
//
// Exports (the launcher/dashboard seam; additive fields may appear):
//   probeTmuxRoot({clientEnv, expectedPid, expectedCwd?})
//     -> { server{socketPath,pid,startTime,version}, session{id,created},
//          rootPane{paneId,panePid,startCommand},
//          coreIdentity{id,server,session} }
//     expectedCwd requires the session's @project_dir to be exactly that
//     canonical path; omitted keeps the general probe. Root remain-on-exit is
//     self-cleared only when expectedPid === process.pid, otherwise an
//     inherited "on" is refused before any hook/worker.
//   probeTmuxSource({socketPath, serverPid, sessionId})
//     -> {state:"live", server, session} | {state:"gone"}
//     Exact captured source, no default/active-session fallback.
//   spawnWorkerTerminal({manifestPath, workerId, rootAddress, name, cwd, argv,
//                        env, clientEnv, expectedCoreId}) -> {address}
//   getTerminal(address, {manifestPath, clientEnv, expectedCoreId, rootAddress})
//     -> {address, name, state:"live", pid, parent, startCommand} | null
//   retireWorkerTerminal(address, same args as getTerminal)
//     -> {retired:true}  (throws when it cannot confirm)
//   listOwnedTerminals({manifestPath, clientEnv, expectedCoreId, rootAddress})
//     -> [{address,name,state,pid,parent,startCommand}]
//   capturePane(address, {manifestPath, clientEnv, expectedCoreId, rootAddress,
//                         lines}) -> string
//   installOwnedHooks({manifestPath, owner, run, generation, expectedCoreId,
//                      clientEnv}) -> {hooks, installed}
//   cleanupPool({manifestPath, owner, run, generation, allowRootLive,
//                expectedCoreId})
//     -> {stopped, killed, unconfirmed, refused, server, session}
//   updatePoolManifest(manifestPath, updates,
//                      {owner, run, generation, expectedCoreId})
//     -> updated record (v3/tmux identity fields are preserved)
//   inspectPool({manifestPath}) -> readonly {record, valid, server, root,
//                  terminals} for the cleanup guard and the dashboard
//
// CLI (internal, trusted by tmux argv): --worker-exec ... -- <worker argv>.
// tmux-cleanup.mjs owns the hook/guard CLI.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCHEMA_VERSION = 3;
export const BACKEND = "tmux";

const MODULE_PATH = fileURLToPath(import.meta.url);
const SEP = "\u001f";
const DEFAULT_TMUX_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const GONE_TIMEOUT_MS = 2_000;
const POLL_MS = 50;
const REGISTER_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const EVENTS = ["pane-exited", "after-kill-pane", "window-unlinked"];

// Only identity travels next to a worker through the wrapper. Credentials and
// arbitrary exports never do.
const IDENTITY_KEYS = new Set([
  "PI_MIND_WORKER_ROLE",
  "PI_MIND_WORKER_TIER",
  "PI_MIND_WORKER_ID",
  "PI_MIND_WORKER_GENERATION",
  "PI_MIND_WORKER_SESSION_DIR",
  "PI_MIND_WORKER_INSTANCE",
]);

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PANE_RE = /^%[0-9]+$/;
const WINDOW_RE = /^@[0-9]+$/;
const SESSION_RE = /^\$[0-9]+$/;
const SOCKET_RE = /^\//;

const PANE_FMT = [
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_start_command}",
  "#{window_id}",
  "#{session_id}",
  "#{@mind.owner}",
  "#{@mind.run}",
  "#{@mind.generation}",
  "#{@mind.worker}",
].join(SEP);

const SERVER_FMT = [
  "#{socket_path}",
  "#{pid}",
  "#{start_time}",
  "#{version}",
  "#{session_id}",
  "#{session_created}",
].join(SEP);

export class TmuxError extends Error {
  constructor(message, { kind = null, code = null, detail = null, spawnUnconfirmed = false } = {}) {
    super(message);
    this.name = "TmuxError";
    this.kind = kind;
    this.code = code;
    this.detail = detail;
    this.spawnUnconfirmed = spawnUnconfirmed;
  }
}

// -- Small helpers -----------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(1, ms)));

function fail(message, kind, extra = {}) {
  return new TmuxError(message, { kind, ...extra });
}

function copyEnv(value) {
  const source = value ?? process.env;
  const out = {};
  for (const [key, val] of Object.entries(source)) if (typeof val === "string") out[key] = val;
  return out;
}

function assertInt(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw fail(label + " must be a safe integer >= " + min + ", got " + JSON.stringify(value), "invalid_params");
  }
  return value;
}

function assertText(value, label) {
  if (typeof value !== "string" || !value || /[\0\n\r]/.test(value)) {
    throw fail(label + " must be a non-empty one-line string", "invalid_params");
  }
  return value;
}

function assertId(value, label, re = ID_RE) {
  if (typeof value !== "string" || !re.test(value)) {
    throw fail(label + " has an invalid form: " + JSON.stringify(value), "invalid_params");
  }
  return value;
}

function assertAbsPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || /[\0\n]/.test(value)) {
    throw fail(label + " must be an absolute path, got " + JSON.stringify(value), "invalid_params");
  }
  return value;
}

/** Canonical path for identity checks; only a missing path falls back to resolve. */
function canonicalExisting(value, label) {
  assertAbsPath(value, label);
  try {
    return realpathSync(value);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return resolve(value);
    throw fail("cannot canonicalize " + label + " " + JSON.stringify(value) + ": " + error.message, "invalid_params");
  }
}

function coreIdOf(server, session) {
  return "tmux:" + server.socketPath + "#" + server.pid + "." + server.startTime + "/" + session.id;
}

function tmuxClientEnv() {
  const env = copyEnv(process.env);
  // The explicit -S target is the only selector; an inherited TMUX must not
  // pull a client onto another server or pane.
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

function tmuxBin() {
  // Test seam only: a private fixture may point this at a forwarding shim.
  return process.env.PI_TMUX_BIN || "tmux";
}

function tmuxRun(server, args, { timeoutMs = DEFAULT_TMUX_TIMEOUT_MS, allowFailure = false } = {}) {
  const full = ["-S", server.socketPath, "-N", ...args];
  const result = spawnSync(tmuxBin(), full, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: tmuxClientEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw fail("tmux " + args[0] + ": " + result.error.message, "tmux_failed", { detail: full.join(" ") });
  }
  if (result.signal) {
    throw fail("tmux " + args[0] + " timed out after " + timeoutMs + "ms", "timeout", { detail: full.join(" ") });
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    if (allowFailure) return { status: result.status, stdout: result.stdout || "", stderr: detail };
    throw fail("tmux " + args[0] + " failed (" + result.status + "): " + (detail || "no stderr"), "tmux_failed", {
      code: result.status,
      detail: full.join(" "),
    });
  }
  return { status: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
}

// A query that found no such server/session/window/pane is "gone", not an
// error: callers treat gone as a normal concurrent death. Every other failure
// is loud.
const GONE_RE = /no server running|error connecting|server exited unexpectedly|can't find (session|window|pane)|no such (session|window|pane)|no current (client|session)|no sessions/i;

function tmuxQuery(server, args, options = {}) {
  const result = tmuxRun(server, args, { ...options, allowFailure: true });
  if (result.status === 0) return result.stdout;
  if (GONE_RE.test(result.stderr)) return null;
  throw fail("tmux " + args[0] + " failed (" + result.status + "): " + (result.stderr || "no stderr"), "tmux_failed", {
    code: result.status,
    detail: args.join(" "),
  });
}

// -- Locks (flock on a never-unlinked inode) ---------------------------------

/**
 * Acquire one short exclusive flock and return its release function. flock(1)
 * locks the open file description, so the lock survives the flock child's exit
 * while this process keeps the fd; closing it releases the lock. The inode is
 * never unlinked (unlink is the classic inode race).
 *
 * Callers must not yield between acquire and release in a synchronous
 * critical section: a second flock child in the same Node process would block
 * the event loop and deadlock the first section's release.
 */
function acquireLock(lockPath) {
  const fd = openSync(lockPath, "a+", 0o600);
  const result = spawnSync("flock", ["-w", String(LOCK_TIMEOUT_MS / 1000), "3"], {
    stdio: ["ignore", "pipe", "pipe", fd],
    timeout: LOCK_TIMEOUT_MS + 5_000,
    env: tmuxClientEnv(),
  });
  if (result.error || result.status !== 0) {
    try { closeSync(fd); } catch { /* closed */ }
    if (result.error) throw fail("flock " + lockPath + ": " + result.error.message, "lock_failed");
    throw fail("flock " + lockPath + " timed out after " + LOCK_TIMEOUT_MS + "ms", "lock_timeout", {
      detail: (result.stderr || "").toString().trim(),
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { closeSync(fd); } catch { /* closed */ }
  };
}

function poolIdOf(manifestPath) {
  const name = basename(manifestPath);
  return name.endsWith("-manifest.json") ? name.slice(0, -"-manifest.json".length) : name.replace(/\.[^.]+$/, "");
}

const workerLockPath = (manifestPath) => join(dirname(manifestPath), poolIdOf(manifestPath) + ".worker-window.lock");
// All pool records for one server must live in one state dir: the hook-index
// lock is shared across pools through this server-tuple file in that dir.
const hookLockPath = (manifestPath, server) =>
  join(dirname(manifestPath), "tmux-server-" + server.pid + "-" + server.startTime + ".hook-index.lock");

// -- v3 record ---------------------------------------------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Refuse anything that is not this exact record shape. A v2/hc, legacy,
 * unknown-schema or malformed record is never adopted, converted or read as
 * v3, and the caller must leave it untouched.
 */
function validateRecord(record, manifestPath = "record") {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw fail(manifestPath + " is not a v3 tmux record object", "record");
  }
  if (record.schemaVersion !== SCHEMA_VERSION || record.terminalBackend !== BACKEND) {
    throw fail(
      manifestPath + " is not a v3 tmux record (schemaVersion " + JSON.stringify(record.schemaVersion) +
        ", terminalBackend " + JSON.stringify(record.terminalBackend) + "); refusing to touch it",
      "record",
    );
  }
  assertId(record.owner, "record owner");
  assertId(record.run, "record run");
  assertInt(record.generation, "record generation", { min: 1 });
  const server = record.server;
  if (!server || typeof server !== "object") throw fail(manifestPath + " has no server tuple", "record");
  assertAbsPath(server.socketPath, "record server.socketPath");
  assertInt(server.pid, "record server.pid", { min: 1 });
  assertInt(server.startTime, "record server.startTime", { min: 0 });
  assertText(server.version, "record server.version");
  const session = record.session;
  if (!session || typeof session !== "object") throw fail(manifestPath + " has no session", "record");
  assertId(session.id, "record session.id", SESSION_RE);
  assertInt(session.created, "record session.created", { min: 0 });
  const pane = record.rootPane;
  if (!pane || typeof pane !== "object") throw fail(manifestPath + " has no root pane", "record");
  assertId(pane.paneId, "record rootPane.paneId", PANE_RE);
  assertInt(pane.panePid, "record rootPane.panePid", { min: 1 });
  if (typeof pane.startCommand !== "string") throw fail("record rootPane.startCommand must be a string", "record");
  if (record.workerWindow !== null && !WINDOW_RE.test(String(record.workerWindow))) {
    throw fail("record workerWindow must be @N or null", "record");
  }
  const panes = record.workerPanes;
  if (!panes || typeof panes !== "object" || Array.isArray(panes)) {
    throw fail("record workerPanes must be an object", "record");
  }
  for (const [workerId, entry] of Object.entries(panes)) {
    assertId(workerId, "workerPanes key", WORKER_ID_RE);
    if (!entry || typeof entry !== "object") throw fail("workerPanes." + workerId + " is not an object", "record");
    assertId(entry.paneId, "workerPanes." + workerId + ".paneId", PANE_RE);
    assertInt(entry.panePid, "workerPanes." + workerId + ".panePid", { min: 1 });
    if (typeof entry.startCommand !== "string") {
      throw fail("workerPanes." + workerId + ".startCommand must be a string", "record");
    }
  }
  if (record.hooks !== undefined) {
    if (!record.hooks || typeof record.hooks !== "object" || Array.isArray(record.hooks)) {
      throw fail("record hooks must be an object", "record");
    }
    for (const [event, entry] of Object.entries(record.hooks)) {
      if (!EVENTS.includes(event)) throw fail("record hooks has an unknown event " + JSON.stringify(event), "record");
      if (!entry || typeof entry !== "object") throw fail("record hooks." + event + " is not an object", "record");
      assertInt(entry.index, "hooks." + event + ".index", { min: 0 });
      assertText(entry.command, "hooks." + event + ".command");
    }
  }
  return record;
}

function loadRecord(manifestPath) {
  const record = readJson(manifestPath);
  if (record === null) {
    throw fail(manifestPath + " is absent or unreadable; refusing to touch it", "record");
  }
  return validateRecord(record, manifestPath);
}

function recordOrNull(manifestPath) {
  const record = readJson(manifestPath);
  if (record === null) return null;
  return validateRecord(record, manifestPath);
}

function assertRecordIdentity(record, { owner, run, generation, expectedCoreId } = {}) {
  if (owner !== undefined && record.owner !== owner) {
    throw fail("pool owner mismatch: record " + record.owner + ", caller " + JSON.stringify(owner), "stale", { detail: "owner" });
  }
  if (run !== undefined && record.run !== run) {
    throw fail("pool run mismatch: record " + record.run + ", caller " + JSON.stringify(run), "stale", { detail: "run" });
  }
  if (generation !== undefined && record.generation !== generation) {
    throw fail(
      "stale generation: record generation " + record.generation + ", caller " + JSON.stringify(generation),
      "stale_generation",
    );
  }
  if (expectedCoreId !== undefined && expectedCoreId !== null) {
    const live = coreIdOf(record.server, record.session);
    if (expectedCoreId !== live) {
      throw fail(
        "core mismatch: expected " + expectedCoreId + ", record is " + live,
        "stale_tuple",
      );
    }
  }
  return record;
}

/** A caller's own TMUX selector must not point at another server than the record. */
function assertClientServer(record, clientEnv) {
  if (!clientEnv || typeof clientEnv.TMUX !== "string") return;
  const [socketPath, pidText] = clientEnv.TMUX.split(",");
  if (socketPath !== record.server.socketPath || Number(pidText) !== record.server.pid) {
    throw fail(
      "caller's tmux server " + socketPath + "," + pidText + " does not match the pool record " +
        record.server.socketPath + "," + record.server.pid,
      "stale_tuple",
    );
  }
}

function assertRootAddress(record, rootAddress, label = "rootAddress") {
  if (rootAddress === undefined || rootAddress === null) return record.rootPane.paneId;
  if (typeof rootAddress !== "string" || !PANE_RE.test(rootAddress)) {
    throw fail(label + " must be a %pane id", "invalid_params");
  }
  if (record.rootPane.paneId !== rootAddress) {
    throw fail(
      "root pane mismatch: record root is " + record.rootPane.paneId + ", caller says " + rootAddress,
      "not_owned",
    );
  }
  return rootAddress;
}

// -- tmux probes -------------------------------------------------------------

function parsePane(text) {
  if (text === null || text === "") return null;
  const clean = text.replace(/\n$/, "");
  const parts = clean.split(SEP);
  if (parts.length < 9) return null;
  const tail = parts.slice(parts.length - 6);
  const startCommand = parts.slice(2, parts.length - 6).join(SEP);
  return {
    paneId: parts[0],
    panePid: Number(parts[1]),
    startCommand,
    windowId: tail[0],
    sessionId: tail[1],
    owner: tail[2],
    run: tail[3],
    generation: tail[4],
    worker: tail[5],
  };
}

function paneDetail(server, paneId) {
  const text = tmuxQuery(server, ["display-message", "-p", "-t", paneId, "-F", PANE_FMT]);
  const pane = parsePane(text);
  if (!pane || pane.paneId !== paneId) return null;
  return pane;
}

function listWindowPanes(server, windowId) {
  if (!windowId) return null;
  const text = tmuxQuery(server, ["list-panes", "-t", windowId, "-F", PANE_FMT]);
  if (text === null) return null;
  // Never accept a pane from another window if tmux fell back to a default.
  return text.split("\n").filter(Boolean).map(parsePane).filter((pane) => pane && pane.windowId === windowId);
}

function windowDetail(server, windowId) {
  if (!windowId) return null;
  const text = tmuxQuery(server, [
    "display-message", "-p", "-t", windowId, "-F",
    ["#{window_id}", "#{session_id}"].join(SEP),
  ]);
  if (!text) return null;
  const [id, sessionId] = text.trim().split(SEP);
  if (id !== windowId || !WINDOW_RE.test(id ?? "")) return null;
  return { windowId: id, sessionId };
}

function parseServerProbe(text) {
  if (!text) return null;
  const parts = text.replace(/\n$/, "").split(SEP);
  if (parts.length < 6) return null;
  return {
    socketPath: parts[0],
    pid: Number(parts[1]),
    startTime: Number(parts[2]),
    version: parts[3],
    sessionId: parts[4],
    created: Number(parts[5]),
  };
}

/**
 * Read the live tuple of the recorded server and session without starting a
 * server and without trusting an ambient client.
 *
 * state: "live" | "session_gone" | "gone"; tuple is present whenever the
 * server answered from any of its sessions.
 */
function queryServer(record) {
  // List sessions first: display-message -t '$N:' silently falls back to the
  // server's current session when $N is gone, so a direct display cannot prove
  // absence. Only read a tuple from a session that list-sessions named.
  const sessions = tmuxQuery(record.server, ["list-sessions", "-F", "#{session_id}"]);
  if (sessions === null || !sessions.trim()) return { state: "gone", tuple: null };
  const ids = sessions.split("\n").map((line) => line.trim()).filter(Boolean);
  let tuple = null;
  if (ids.includes(record.session.id)) {
    const own = parseServerProbe(tmuxQuery(record.server, [
      "display-message", "-p", "-t", record.session.id + ":", "-F", SERVER_FMT,
    ]));
    if (own && own.sessionId === record.session.id) tuple = own;
  }
  if (!tuple) {
    for (const id of ids) {
      const any = parseServerProbe(tmuxQuery(record.server, [
        "display-message", "-p", "-t", id + ":", "-F", SERVER_FMT,
      ]));
      if (any && any.sessionId === id) {
        tuple = any;
        break;
      }
    }
  }
  if (!tuple) return { state: "gone", tuple: null };
  if (!ids.includes(record.session.id) || tuple.sessionId !== record.session.id) {
    return { state: "session_gone", tuple };
  }
  return { state: "live", tuple };
}

/**
 * Prove the live server/session still is the recorded one. "gone" means the
 * whole server (and therefore every pane) is gone; a session_gone probe is
 * returned as-is so a caller can sweep hooks but no panes.
 */
function serverState(record) {
  const probe = queryServer(record);
  if (probe.state === "gone") return { state: "gone" };
  const tuple = probe.tuple;
  if (
    tuple.socketPath !== record.server.socketPath ||
    tuple.pid !== record.server.pid ||
    tuple.startTime !== record.server.startTime
  ) {
    throw fail(
      "tmux server tuple changed: record " + record.server.pid + "." + record.server.startTime +
        " at " + record.server.socketPath + ", live " + tuple.pid + "." + tuple.startTime + " at " + tuple.socketPath,
      "stale_tuple",
    );
  }
  if (probe.state === "session_gone") return { state: "session_gone" };
  if (tuple.sessionId !== record.session.id || tuple.created !== record.session.created) {
    throw fail(
      "tmux session id/created changed: record " + record.session.id + "." + record.session.created +
        ", live " + tuple.sessionId + "." + tuple.created,
      "stale_tuple",
    );
  }
  return { state: "live" };
}

/** The recorded root program is this pane's direct argv program. */
function rootState(record, server) {
  const pane = paneDetail(server, record.rootPane.paneId);
  if (!pane) return { state: "gone" };
  if (
    pane.sessionId !== record.session.id ||
    pane.panePid !== record.rootPane.panePid ||
    pane.startCommand !== record.rootPane.startCommand
  ) {
    return { state: "replaced", pane };
  }
  return { state: "live", pane };
}

function assertRootLive(record) {
  const state = serverState(record);
  if (state.state === "gone") throw fail("tmux server is gone; refusing to create a worker", "root_not_live");
  if (state.state === "session_gone") throw fail("root session is gone; refusing to create a worker", "root_not_live");
  const root = rootState(record, record.server);
  if (root.state !== "live") {
    throw fail(
      "root pane " + record.rootPane.paneId + " is " + root.state + "; refusing to create a worker",
      "root_not_live",
    );
  }
  return root.pane;
}

function markersMatch(record, pane) {
  return Boolean(
    pane &&
    pane.sessionId === record.session.id &&
    pane.owner === record.owner &&
    pane.run === record.run &&
    pane.generation === String(record.generation) &&
    pane.worker,
  );
}

function paneOwnedBy(record, pane, workerId = null) {
  return markersMatch(record, pane) &&
    pane.windowId === record.workerWindow &&
    (!workerId || pane.worker === workerId);
}

/**
 * Every pane in the recorded worker window whose markers prove it belongs to
 * this pool/generation. Unmarked panes (editor, manual, tools) never appear.
 */
function markedWorkerPanes(record, server) {
  if (!record.workerWindow) return [];
  const panes = listWindowPanes(server, record.workerWindow);
  if (!panes) return [];
  return panes.filter((pane) => paneOwnedBy(record, pane));
}

function paneState(record, address, expectedCoreId) {
  assertId(address, "address", PANE_RE);
  assertRecordIdentity(record, { expectedCoreId });
  const state = serverState(record);
  if (state.state === "gone" || state.state === "session_gone") return null;
  const pane = paneDetail(record.server, address);
  if (!pane) return null;
  const entry = Object.entries(record.workerPanes).find(([, value]) => value.paneId === address);
  const workerId = entry ? entry[0] : pane.worker;
  if (!markersMatch(record, pane) || !workerId) {
    throw fail(
      "pane " + address + " is not owned by " + record.owner + "/" + record.run + "#" + record.generation,
      "not_owned",
    );
  }
  if (pane.windowId !== record.workerWindow) {
    throw fail("pane " + address + " is not in the reserved worker window", "not_owned");
  }
  if (entry) {
    const [, value] = entry;
    if (value.panePid !== pane.panePid || value.startCommand !== pane.startCommand) {
      throw fail("pane " + address + " no longer matches its record (pid/startCommand changed)", "not_owned");
    }
  }
  return {
    address,
    name: workerId || null,
    state: "live",
    pid: pane.panePid,
    parent: record.rootPane.paneId,
    startCommand: pane.startCommand,
  };
}

// -- Root probe --------------------------------------------------------------

/** Effective remain-on-exit for the pane's window: true/false, or null if unknown. */
function readRemainOnExit(server, paneId) {
  const text = tmuxQuery(server, [
    "display-message", "-p", "-t", paneId, "-F", ["#{pane_id}", "#{remain-on-exit}"].join(SEP),
  ]);
  if (text === null) return null;
  const [reportedPane, reportedValue] = text.trim().split(SEP);
  if (reportedPane !== paneId) return null; // a stale id fell back to another pane
  const value = (reportedValue ?? "").trim();
  if (value === "on") return true;
  if (value === "off") return false;
  const pane = paneDetail(server, paneId);
  if (!pane) return null;
  const paneOption = tmuxQuery(server, ["show-options", "-p", "-t", paneId, "-v", "remain-on-exit"]);
  if (paneOption !== null && paneOption.trim()) return paneOption.trim() === "on";
  const windowOption = tmuxQuery(server, ["show-options", "-w", "-t", pane.windowId, "-v", "remain-on-exit"]);
  if (windowOption === null) return false;
  const normalized = windowOption.trim();
  if (!normalized) return false; // unset default is off
  return normalized === "on";
}

/**
 * A root window with remain-on-exit on can strand its pane after the program
 * exits. The actual root process may turn it off on its own window after the
 * pid proof; anyone else must refuse rather than modify a foreign pane.
 */
function ensureRootRemainOff(server, pane, maySet) {
  const state = readRemainOnExit(server, pane.paneId);
  if (state === null) {
    throw fail("cannot prove remain-on-exit is off for root pane " + pane.paneId, "root_remain_on_exit");
  }
  if (!state) return;
  if (!maySet) {
    throw fail(
      "root pane " + pane.paneId + " inherits remain-on-exit=on; refusing before any hook or worker",
      "root_remain_on_exit",
    );
  }
  const current = paneDetail(server, pane.paneId);
  if (!current || current.panePid !== pane.panePid) {
    throw fail("root pane " + pane.paneId + " changed before remain-on-exit could be cleared", "root_remain_on_exit");
  }
  // Pane-local: never change another pane in the root's window.
  tmuxRun(server, ["set-option", "-p", "-t", pane.paneId, "remain-on-exit", "off"]);
  if (readRemainOnExit(server, pane.paneId) !== false) {
    throw fail("could not turn remain-on-exit off for root pane " + pane.paneId, "root_remain_on_exit");
  }
}

/**
 * Probe the caller's own tmux pane as the pool root. The captured socket is
 * used, every target is explicit and -N never starts a server. The root
 * program must be the pane's direct argv program: pane_pid == expectedPid.
 * With expectedCwd, the root session's @project_dir must be exactly that
 * canonical path before any hook or worker is created.
 */
export function probeTmuxRoot({ clientEnv = process.env, expectedPid, expectedCwd } = {}) {
  const env = copyEnv(clientEnv);
  const tmuxVar = env.TMUX;
  const paneId = env.TMUX_PANE;
  if (typeof tmuxVar !== "string" || !tmuxVar.trim()) {
    throw fail("TMUX is not set: start Mind from a tmux pane, not a plain shell", "root_not_tmux");
  }
  if (typeof paneId !== "string" || !PANE_RE.test(paneId)) {
    throw fail("TMUX_PANE is not a %pane id; refusing to guess the root pane", "root_not_tmux");
  }
  const parts = tmuxVar.trim().split(",");
  if (parts.length !== 3) {
    throw fail("TMUX=" + JSON.stringify(tmuxVar) + " is not <socket>,<pid>,<start-time>", "root_not_tmux");
  }
  // TMUX's third field is not the server start time (tmux 3.7c reports 0), so
  // it is only a socket/pid hint; the tuple is read live below.
  const hint = { socketPath: parts[0], pid: Number(parts[1]), version: "" };
  if (!SOCKET_RE.test(hint.socketPath) || !Number.isSafeInteger(hint.pid) || hint.pid <= 0) {
    throw fail("TMUX=" + JSON.stringify(tmuxVar) + " is not a usable server hint", "root_not_tmux");
  }
  assertInt(expectedPid, "expectedPid", { min: 1 });

  const pane = paneDetail(hint, paneId);
  if (!pane) {
    throw fail("tmux pane " + paneId + " is not live on " + hint.socketPath, "root_not_live");
  }
  if (pane.panePid !== expectedPid) {
    throw fail(
      "this process (pid " + expectedPid + ") is not the direct root program of pane " + paneId +
        " (pane_pid " + pane.panePid + "); start Mind with the shell builtin exec so it replaces the pane's shell",
      "root_pid_mismatch",
    );
  }
  const server = hint;
  const probe = parseServerProbe(tmuxQuery(server, ["display-message", "-p", "-t", paneId, "-F", SERVER_FMT]));
  if (!probe) throw fail("tmux did not answer the server tuple probe", "malformed_reply");
  if (probe.socketPath !== hint.socketPath || probe.pid !== hint.pid) {
    throw fail(
      "tmux server changed while probing (socket " + probe.socketPath + ", pid " + probe.pid + ")",
      "stale_tuple",
    );
  }
  if (probe.sessionId !== pane.sessionId) {
    throw fail("tmux answered contradictory pane/session ids", "malformed_reply");
  }
  const live = {
    socketPath: probe.socketPath,
    pid: probe.pid,
    startTime: probe.startTime,
    version: probe.version,
  };
  const session = { id: pane.sessionId, created: probe.created };

  if (expectedCwd !== undefined) {
    const expected = canonicalExisting(expectedCwd, "expectedCwd");
    const tagText = tmuxQuery(server, ["display-message", "-p", "-t", pane.paneId, "-F", "#{@project_dir}"]);
    const tag = tagText === null ? "" : tagText.trim();
    if (!tag || !tag.startsWith("/")) {
      throw fail("root session " + session.id + " has no canonical @project_dir", "root_project_identity");
    }
    const actual = canonicalExisting(tag, "@project_dir");
    if (actual !== expected) {
      throw fail(
        "root session " + session.id + " @project_dir " + actual + " does not match expected cwd " + expected,
        "root_project_mismatch",
      );
    }
  }

  ensureRootRemainOff(server, pane, expectedPid === process.pid);

  const rootPane = { paneId: pane.paneId, panePid: pane.panePid, startCommand: pane.startCommand };
  return {
    server: live,
    session,
    rootPane,
    coreIdentity: { id: coreIdOf(live, session), server: live, session },
  };
}

/**
 * Readonly probe of an explicitly captured source. No client, active-pane,
 * default-session or default-socket fallback: list the sessions, require the
 * requested $N, then read the tuple from that exact session. Returns
 * {state:"live", server, session} or {state:"gone"}; throws stale_tuple when
 * the socket/server identity does not match the captured values.
 */
export function probeTmuxSource({ socketPath, serverPid, sessionId } = {}) {
  assertAbsPath(socketPath, "socketPath");
  assertInt(serverPid, "serverPid", { min: 1 });
  assertId(sessionId, "sessionId", SESSION_RE);
  const server = { socketPath, pid: serverPid, version: "" };
  const sessions = tmuxQuery(server, ["list-sessions", "-F", "#{session_id}"]);
  if (sessions === null || !sessions.trim()) return { state: "gone" };
  const ids = sessions.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!ids.includes(sessionId)) return { state: "gone" };
  const tuple = parseServerProbe(tmuxQuery(server, [
    "display-message", "-p", "-t", sessionId + ":", "-F", SERVER_FMT,
  ]));
  if (!tuple || tuple.sessionId !== sessionId) return { state: "gone" };
  if (tuple.socketPath !== socketPath || tuple.pid !== serverPid) {
    throw fail(
      "captured source " + socketPath + "," + serverPid + " does not match the live server " +
        tuple.socketPath + "," + tuple.pid,
      "stale_tuple",
    );
  }
  return {
    state: "live",
    server: {
      socketPath: tuple.socketPath,
      pid: tuple.pid,
      startTime: tuple.startTime,
      version: tuple.version,
    },
    session: { id: tuple.sessionId, created: tuple.created },
  };
}

// -- Worker spawn (wrapper transaction) --------------------------------------

function identityPairs(identity) {
  if (identity == null) return [];
  if (typeof identity !== "object" || Array.isArray(identity)) {
    throw fail("worker env must be an object of PI_MIND_WORKER_* strings", "invalid_params");
  }
  const pairs = [];
  for (const [key, value] of Object.entries(identity)) {
    if (!IDENTITY_KEYS.has(key)) {
      throw fail("refusing to pass " + key + " to a worker: only PI_MIND_WORKER_* identity vars are allowed", "invalid_params");
    }
    if (typeof value !== "string" || !value) {
      throw fail("worker env " + key + " must be a non-empty string", "invalid_params");
    }
    if (/[\0\n\r]/.test(value)) throw fail("worker env " + key + " must be one line", "invalid_params");
    pairs.push([key, value]);
  }
  return pairs;
}

function wrapperCommand(record, manifestPath, { workerId, argv, identity, expectedCoreId }) {
  const command = [
    process.execPath,
    MODULE_PATH,
    "--worker-exec",
    "--manifest", manifestPath,
    "--owner", record.owner,
    "--run", record.run,
    "--generation", String(record.generation),
    "--worker-id", workerId,
    "--expected-core-id", expectedCoreId || coreIdOf(record.server, record.session),
  ];
  for (const [key, value] of identity) command.push("--identity", key + "=" + value);
  command.push("--", ...argv);
  return command;
}

function createReply(text) {
  if (!text) return null;
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2 || !WINDOW_RE.test(parts[0]) || !PANE_RE.test(parts[1])) return null;
  return { windowId: parts[0], paneId: parts[1] };
}

function markedWindowInSession(record) {
  const windows = tmuxQuery(record.server, ["list-windows", "-t", record.session.id + ":", "-F", "#{window_id}"]);
  if (windows === null) return [];
  const found = [];
  for (const windowId of windows.split("\n").map((line) => line.trim()).filter((id) => WINDOW_RE.test(id))) {
    if (windowId === record.workerWindow) continue;
    const panes = listWindowPanes(record.server, windowId) || [];
    if (panes.some((pane) => markersMatch(record, pane))) found.push(windowId);
  }
  return found;
}

function workerWindowPointedByRecord(record) {
  if (!record.workerWindow) return null;
  const detail = windowDetail(record.server, record.workerWindow);
  if (!detail) return null;
  if (detail.sessionId !== record.session.id) {
    throw fail(
      "recorded worker window " + record.workerWindow + " now belongs to " + detail.sessionId +
        ", not " + record.session.id + "; refusing to hijack it",
      "not_owned",
    );
  }
  return record.workerWindow;
}

/**
 * Find or create the one reserved worker window inside the recorded live
 * session. Creation happens under the worker-window flock, so concurrent
 * static and burst spawns cannot make two windows.
 */
function resolveWorkerWindow(record, manifestPath, spawn) {
  const existing = workerWindowPointedByRecord(record);
  if (existing) return { windowId: existing, created: false };
  const adopted = markedWindowInSession(record);
  if (adopted.length > 1) {
    throw fail(
      "multiple marked worker windows exist in " + record.session.id + ": " + adopted.join(", "),
      "ambiguous_window",
    );
  }
  if (adopted.length === 1) return { windowId: adopted[0], created: false, adopt: true };

  const command = wrapperCommand(record, manifestPath, spawn);
  const reply = tmuxQuery(record.server, [
    // -n also turns automatic-rename off on this window alone, so a global
    // automatic-rename-format can never rename it away from workers.
    "new-window", "-d", "-P", "-F", "#{window_id} #{pane_id}", "-n", "workers",
    "-t", record.session.id + ":",
    "-c", spawn.cwd,
    "--", ...command,
  ]);
  const created = createReply(reply);
  if (!created) {
    // The pane may exist even though the reply was lost. The wrapper
    // registers itself; the caller reconciles, and never retries blindly.
    throw fail(
      "tmux new-window returned no usable window/pane id" + (reply ? " (" + reply.trim().slice(0, 200) + ")" : ""),
      "spawn_unconfirmed",
      { spawnUnconfirmed: true },
    );
  }
  return { windowId: created.windowId, paneId: created.paneId, created: true };
}

async function reconcileSpawn(manifestPath, workerId, expectedCoreId, deadline) {
  while (Date.now() < deadline) {
    const current = recordOrNull(manifestPath);
    if (current) {
      assertRecordIdentity(current, { expectedCoreId });
      const entry = current.workerPanes[workerId];
      if (entry) {
        // The wrapper writes the record before its markers, so keep polling
        // until the record, the markers and the pane's own pid/start command
        // prove the same pane; do not report unconfirmed early. A marked pane
        // the record does not list (one already retiring, say) is never proof.
        const pane = paneDetail(current.server, entry.paneId);
        if (
          pane && paneOwnedBy(current, pane, workerId) &&
          pane.panePid === entry.panePid && pane.startCommand === entry.startCommand
        ) {
          return { address: entry.paneId, windowId: current.workerWindow };
        }
      }
    }
    await sleep(POLL_MS);
  }
  return null;
}

function findWorkerByMarkers(record, workerId) {
  const panes = markedWorkerPanes(record, record.server).filter((pane) => pane.worker === workerId);
  return panes.length === 1 ? panes[0] : null;
}

/**
 * Start one worker as a direct argv program in the reserved worker window.
 *
 * tmux execs this module's trusted wrapper (argv only). The wrapper proves the
 * pool tuple, root pane, owner/run/generation, registers the pane and only
 * then execve()s the worker argv, so the pane_pid never changes and a root
 * death racing the create leaves no unmarked orphan: a pane created after the
 * sweep sees a dead root and exits, closing the pane.
 *
 * Returns {address:"%N"}. A lost/malformed create reply is reconciled by the
 * uniquely registered/marked pane; an ambiguous result stays unconfirmed and
 * is never retried blindly.
 */
export async function spawnWorkerTerminal(options = {}) {
  const {
    manifestPath, workerId, rootAddress, name, cwd, argv, env: identity,
    clientEnv, expectedCoreId,
  } = options;
  if (typeof manifestPath !== "string" || !manifestPath.startsWith("/")) {
    throw fail("manifestPath must be an absolute path", "invalid_params");
  }
  assertId(workerId, "workerId", WORKER_ID_RE);
  assertAbsPath(cwd, "worker cwd");
  if (name !== undefined && name !== null) assertId(name, "worker name", WORKER_ID_RE);
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string" && part)) {
    throw fail("worker argv must be a non-empty array of strings", "invalid_params");
  }
  if (!argv[0].startsWith("/")) {
    throw fail("worker argv[0] must be an absolute program path, got " + JSON.stringify(argv[0]), "invalid_params");
  }
  const pairs = identityPairs(identity);

  let created = null;
  let lostReply = false;
  {
    const release = acquireLock(workerLockPath(manifestPath));
    try {
    let record = loadRecord(manifestPath);
    assertRecordIdentity(record, { expectedCoreId });
    assertClientServer(record, clientEnv);
    assertRootAddress(record, rootAddress);
    if (record.workerPanes[workerId]) {
      throw fail(
        "worker " + workerId + " already exists as " + record.workerPanes[workerId].paneId + "; refusing a duplicate",
        "already_exists",
      );
    }
    {
      const rootPane = assertRootLive(record);
      ensureRootRemainOff(record.server, rootPane, process.pid === rootPane.panePid);
    }

    const spawn = { workerId, cwd, argv, identity: pairs, expectedCoreId };
    try {
      const window = resolveWorkerWindow(record, manifestPath, spawn);
      let paneId = window.paneId || null;
      if (!window.created) {
        const command = wrapperCommand(record, manifestPath, spawn);
        const reply = tmuxQuery(record.server, [
          "split-window", "-d", "-P", "-F", "#{window_id} #{pane_id}",
          "-t", window.windowId,
          "-c", cwd,
          "--", ...command,
        ]);
        const split = createReply(reply);
        if (!split || split.windowId !== window.windowId) {
          // The pane may exist. Never retry blindly; reconcile by the wrapper's
          // own registration/markers after the lock is released.
          lostReply = true;
          paneId = null;
        } else {
          paneId = split.paneId;
        }
      }
      if (record.workerWindow !== window.windowId) {
        record = { ...record, workerWindow: window.windowId };
        writeJsonAtomic(manifestPath, record);
      }
      // Keep the worker window non-persistent (mirrors hc --rm) and retile
      // only it; neither steals focus.
      tmuxRun(record.server, ["set-option", "-w", "-t", window.windowId, "remain-on-exit", "off"], { allowFailure: true });
      tmuxRun(record.server, ["select-layout", "-t", window.windowId, "tiled"], { allowFailure: true });
      if (paneId) {
        created = { paneId, windowId: window.windowId };
        if (name) tmuxRun(record.server, ["select-pane", "-t", paneId, "-T", name], { allowFailure: true });
      }
    } catch (error) {
      if (error instanceof TmuxError && error.spawnUnconfirmed) {
        lostReply = true;
      } else {
        throw error;
      }
    }
    } finally {
      release();
    }
  }

  // The wrapper registers under the same flock; do not wait while holding it.
  const deadline = Date.now() + REGISTER_TIMEOUT_MS;
  if (lostReply) {
    const reconciled = await reconcileSpawn(manifestPath, workerId, expectedCoreId, deadline);
    if (reconciled) return { address: reconciled.address };
    // The record is left as it is: this pool is live, and a durable
    // unconfirmed label belongs to a failed sweep (cleanupPool), never to a
    // live pool whose root must stay focusable. The next sweep proves it.
    throw fail(
      "worker " + workerId + " spawn reply was lost and no unique pane proves it; leaving it unconfirmed (no retry)",
      "spawn_unconfirmed",
      { spawnUnconfirmed: true },
    );
  }
  if (created) {
    while (Date.now() < deadline) {
      const current = loadRecord(manifestPath);
      assertRecordIdentity(current, { expectedCoreId });
      const entry = current.workerPanes[workerId];
      if (entry && entry.paneId !== created.paneId) {
        throw fail(
          "worker " + workerId + " registered as " + entry.paneId + " but tmux created " + created.paneId,
          "spawn_unconfirmed",
          { spawnUnconfirmed: true },
        );
      }
      const pane = paneDetail(current.server, created.paneId);
      if (!pane) {
        throw fail("worker pane " + created.paneId + " disappeared before registration", "spawn_unconfirmed", {
          spawnUnconfirmed: true,
        });
      }
      // Do not report success before the wrapper's markers exist: a caller
      // that immediately gets or retires the terminal must see it owned.
      if (entry && paneOwnedBy(current, pane, workerId) && pane.panePid === entry.panePid) {
        return { address: entry.paneId };
      }
      const direct = findWorkerByMarkers(current, workerId);
      if (direct && direct.paneId === created.paneId) return { address: direct.paneId };
      await sleep(POLL_MS);
    }
    throw fail(
      "worker " + workerId + " pane " + created.paneId + " did not register within " + REGISTER_TIMEOUT_MS +
        "ms; leaving it unconfirmed (no retry)",
      "spawn_unconfirmed",
      { spawnUnconfirmed: true, detail: created.paneId },
    );
  }
  throw fail(
    "worker " + workerId + " disappeared before registration; leaving it unconfirmed (no retry)",
    "spawn_unconfirmed",
    { spawnUnconfirmed: true },
  );
}

// -- Read / retire / capture -------------------------------------------------

export async function getTerminal(address, options = {}) {
  const { manifestPath, expectedCoreId, rootAddress } = options;
  if (typeof manifestPath !== "string" || !manifestPath.startsWith("/")) {
    throw fail("manifestPath must be an absolute path", "invalid_params");
  }
  const record = loadRecord(manifestPath);
  assertRecordIdentity(record, { expectedCoreId });
  assertClientServer(record, options.clientEnv);
  assertRootAddress(record, rootAddress);
  return paneState(record, address, expectedCoreId);
}

export async function listOwnedTerminals(options = {}) {
  const { manifestPath, expectedCoreId, rootAddress } = options;
  if (typeof manifestPath !== "string" || !manifestPath.startsWith("/")) {
    throw fail("manifestPath must be an absolute path", "invalid_params");
  }
  const record = loadRecord(manifestPath);
  assertRecordIdentity(record, { expectedCoreId });
  assertClientServer(record, options.clientEnv);
  assertRootAddress(record, rootAddress);
  const state = serverState(record);
  if (state.state !== "live") return [];
  return markedWorkerPanes(record, record.server).map((pane) => ({
    address: pane.paneId,
    name: pane.worker,
    state: "live",
    pid: pane.panePid,
    parent: record.rootPane.paneId,
    startCommand: pane.startCommand,
  }));
}

export async function capturePane(address, options = {}) {
  const { manifestPath, expectedCoreId, rootAddress } = options;
  assertId(address, "address", PANE_RE);
  const lines = options.lines === undefined ? 200 : assertInt(options.lines, "lines", { min: 1 });
  if (lines > 5000) throw fail("lines must be <= 5000", "invalid_params");
  const terminal = await getTerminal(address, { manifestPath, expectedCoreId, rootAddress, clientEnv: options.clientEnv });
  if (!terminal) throw fail("pane " + address + " is gone", "not_found");
  const record = loadRecord(manifestPath);
  const text = tmuxQuery(record.server, ["capture-pane", "-p", "-J", "-t", address, "-S", "-" + lines]);
  if (text === null) throw fail("pane " + address + " disappeared during capture", "not_found");
  return text;
}

/**
 * Retile only the reserved worker window after a pane count change; tmux keeps
 * the previous layout's shape otherwise. The target is one exact @window id,
 * so no other window is touched and focus never moves.
 */
function retileWorkerWindow(server, windowId) {
  if (!windowId) return;
  // @N ids are never reused inside one live server tuple, so a window that
  // died with its last pane just fails here; allowFailure keeps that quiet.
  tmuxRun(server, ["select-layout", "-t", windowId, "tiled"], { allowFailure: true });
}

async function confirmPaneGone(server, paneId, deadline) {
  while (Date.now() < deadline) {
    if (!paneDetail(server, paneId)) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/**
 * End one owned worker pane. Markers plus the recorded pid and start command
 * are re-proved immediately before kill-pane; only that one pane is a target.
 * The record entry is dropped only after the pane is confirmed gone.
 */
export async function retireWorkerTerminal(address, options = {}) {
  const { manifestPath, expectedCoreId, rootAddress, goneTimeoutMs } = options;
  if (typeof manifestPath !== "string" || !manifestPath.startsWith("/")) {
    throw fail("manifestPath must be an absolute path", "invalid_params");
  }
  assertId(address, "address", PANE_RE);
  const timeout = Number.isFinite(goneTimeoutMs) ? Math.max(1, goneTimeoutMs) : GONE_TIMEOUT_MS;
  let record = loadRecord(manifestPath);
  assertRecordIdentity(record, { expectedCoreId });
  assertClientServer(record, options.clientEnv);
  assertRootAddress(record, rootAddress);
  const state = serverState(record);
  if (state.state !== "live") {
    await dropPane(manifestPath, address, expectedCoreId);
    return { retired: true };
  }
  if (!paneState(record, address, expectedCoreId)) {
    await dropPane(manifestPath, address, expectedCoreId);
    return { retired: true };
  }
  // The ownership read above is immediately followed by the kill; markers,
  // window, pid and start command are the identity.
  record = loadRecord(manifestPath);
  if (!paneState(record, address, expectedCoreId)) return { retired: true };
  // Kill only a pane whose recorded pid and start command prove it; markers
  // alone are not enough for a destructive operation.
  if (!Object.values(record.workerPanes).some((entry) => entry.paneId === address)) {
    throw fail("pane " + address + " has no recorded pid/start command; refusing to kill it", "not_owned");
  }
  tmuxRun(record.server, ["kill-pane", "-t", address]);
  if (!(await confirmPaneGone(record.server, address, Date.now() + timeout))) {
    throw fail("pane " + address + " is still present after kill-pane", "retire_timeout");
  }
  await dropPane(manifestPath, address, expectedCoreId);
  retileWorkerWindow(record.server, record.workerWindow);
  return { retired: true };
}

async function dropPane(manifestPath, address, expectedCoreId) {
  const release = acquireLock(workerLockPath(manifestPath));
  try {
    const record = recordOrNull(manifestPath);
    if (!record) return;
    assertRecordIdentity(record, { expectedCoreId });
    const workerId = Object.keys(record.workerPanes).find((key) => record.workerPanes[key].paneId === address);
    if (!workerId) return;
    const workerPanes = { ...record.workerPanes };
    delete workerPanes[workerId];
    writeJsonAtomic(manifestPath, { ...record, workerPanes });
  } finally {
    release();
  }
}

// -- Global indexed hooks ----------------------------------------------------

function shellQuote(value) {
  const text = String(value);
  // Only the alphabet our fixed hook serialization can represent is accepted:
  // one single-quoted word with no quote, backslash or control byte. That is
  // what makes the stored hook command round-trip through show-hooks exactly.
  if (text.includes("'") || text.includes('"') || text.includes("\\") || /[\0\n\r]/.test(text)) {
    throw fail("cannot quote " + JSON.stringify(text) + " for a tmux hook command", "invalid_params");
  }
  return "'" + text + "'";
}

/** Exact argv every one of this pool's hook entries must run. */
function hookArgv(manifestPath, record) {
  return [
    process.execPath, join(dirname(MODULE_PATH), "tmux-cleanup.mjs"),
    "--cleanup",
    "--record", manifestPath,
    "--owner", record.owner,
    "--run", record.run,
    "--generation", String(record.generation),
  ];
}

function hookCommand(manifestPath, record) {
  // run-shell passes this through sh -c, so every argv element is shell
  // quoted. # is doubled so tmux format expansion sees a literal # (tmux halves
  // ## at execution). tmux stores and prints this serialization unchanged, so
  // an intent written before set-hook stays removable after a crash.
  const shell = hookArgv(manifestPath, record).map(shellQuote).join(" ");
  return 'run-shell -b "' + shell.replace(/#/g, "##") + '"';
}

/**
 * Decode exactly this one known serialization back to its argv: one
 * `run-shell -b "<single-quoted words>"`, nothing before or after it, no other
 * quoting, no lone # (a tmux format). Strict shape, never a substring test.
 */
function decodeHookCommand(command) {
  if (typeof command !== "string") return null;
  const match = /^run-shell -b "(.*)"$/.exec(command);
  if (!match) return null;
  const inner = match[1];
  if (inner.includes("\\")) return null; // the shellQuote alphabet has none
  if (/(^|[^#])#(?!#)/.test(inner)) return null;
  const plain = inner.replace(/##/g, "#");
  if (!/^'[^']*'(?: '[^']*')*$/.test(plain)) return null;
  return plain.slice(1, -1).split("' '");
}

/**
 * True only when command is this pool's hook command: byte equal to our
 * serialization, or exactly equivalent quoting of the same complete argv. A
 * modified entry that still contains our path/owner/run/generation is foreign.
 */
function hookOwned(command, manifestPath, record) {
  if (typeof command !== "string" || !command) return false;
  if (command === hookCommand(manifestPath, record)) return true;
  const decoded = decodeHookCommand(command);
  if (!decoded) return false;
  const argv = hookArgv(manifestPath, record);
  return decoded.length === argv.length && decoded.every((word, index) => word === argv[index]);
}

function readHookEntry(server, event, index) {
  const out = tmuxQuery(server, ["show-hooks", "-g", event + "[" + index + "]"]);
  if (out === null) return null;
  const line = out.split("\n").map((value) => value.trimEnd()).find(Boolean);
  if (!line) return null;
  const match = line.match(/^(\S+?)(?:\[(\d+)\])?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const lineEvent = match[1];
  const lineIndex = match[2] === undefined ? 0 : Number(match[2]);
  if (lineEvent !== event || lineIndex !== index) return null;
  // tmux answers an unset index with "event[N] " and no command: nothing is
  // installed there, which is "removed", never a foreign entry.
  const command = match[3] ?? "";
  if (!command) return null;
  return { event, index, command };
}

function usedHookIndexes(server, event) {
  const out = tmuxQuery(server, ["show-hooks", "-g", event]);
  const used = new Set();
  if (out === null || !out.trim()) return used;
  for (const line of out.split("\n")) {
    const match = line.trimEnd().match(/^(\S+?)(?:\[(\d+)\])?(?:\s|$)/);
    if (!match || match[1] !== event) continue;
    used.add(match[2] === undefined ? 0 : Number(match[2]));
  }
  return used;
}

function freeHookIndex(server, event) {
  const used = usedHookIndexes(server, event);
  for (let index = 0; index < 100_000; index++) if (!used.has(index)) return index;
  throw fail("no free hook index for " + event, "hook_index");
}

function removeOwnedHooks(server, record, manifestPath) {
  const removed = [];
  const unconfirmed = [];
  for (const event of EVENTS) {
    const entry = record.hooks?.[event];
    if (!entry) continue;
    const live = readHookEntry(server, event, entry.index);
    if (!live) {
      removed.push({ event, index: entry.index });
      continue;
    }
    // Ownership is the exact normalized command: byte equal, or exactly
    // equivalent quoting of our complete argv. A modified entry is foreign even
    // when it still contains our path/owner/run/generation: it stays installed
    // and is reported, never unset.
    if (!hookOwned(live.command, manifestPath, record)) {
      unconfirmed.push({ event, index: entry.index, reason: "foreign-entry" });
      continue;
    }
    tmuxRun(server, ["set-hook", "-gu", event + "[" + entry.index + "]"], { allowFailure: true });
    const after = readHookEntry(server, event, entry.index);
    if (after && hookOwned(after.command, manifestPath, record)) {
      unconfirmed.push({ event, index: entry.index, reason: "still-installed" });
    } else {
      removed.push({ event, index: entry.index });
    }
  }
  return { removed, unconfirmed };
}

/**
 * Install this pool's three global indexed hook entries under the shared
 * server-tuple lock. Every pre-existing entry in each list is left in place;
 * only the newly recorded index is ever unset later. Idempotent per record.
 */
export async function installOwnedHooks(options = {}) {
  const { manifestPath, owner, run, generation, expectedCoreId } = options;
  if (typeof manifestPath !== "string" || !manifestPath.startsWith("/")) {
    throw fail("manifestPath must be an absolute path", "invalid_params");
  }
  assertId(owner, "owner");
  assertId(run, "run");
  assertInt(generation, "generation", { min: 1 });

  const initial = loadRecord(manifestPath);
  assertRecordIdentity(initial, { owner, run, generation, expectedCoreId });
  assertClientServer(initial, options.clientEnv);
  const releaseHook = acquireLock(hookLockPath(manifestPath, initial.server));
  let releaseWorker = null;
  try {
    releaseWorker = acquireLock(workerLockPath(manifestPath));
    const record = loadRecord(manifestPath);
    assertRecordIdentity(record, { owner, run, generation, expectedCoreId });
    if (serverState(record).state !== "live") {
      throw fail("root session is gone; refusing to install hooks for a dead pool", "root_not_live");
    }
    // A swept pool must not grow hooks again: that would re-arm a stopped
    // record and leave entries no live root owns.
    if (record.state === "stopped") {
      throw fail("pool record is stopped; refusing to install hooks on it", "root_not_live");
    }
    {
      const rootPane = assertRootLive(record);
      ensureRootRemainOff(record.server, rootPane, process.pid === rootPane.panePid);
    }
    // Allocate every index and persist the exact command we are about to
    // install BEFORE the first set-hook. A SIGKILL or a tmux failure inside the
    // install window then leaves a record the helper can sweep by index and
    // exact command; nothing is ever found by scanning the global lists.
    const intents = {};
    const unconfirmed = [];
    for (const event of EVENTS) {
      const previous = record.hooks?.[event];
      if (previous) {
        const live = readHookEntry(record.server, event, previous.index);
        if (live && hookOwned(live.command, manifestPath, record)) {
          intents[event] = { index: previous.index, command: live.command };
          continue;
        }
        // Someone else's entry now sits at our old index. Leave it alone and
        // report that it was not adopted.
        unconfirmed.push({ event, index: previous.index, reason: "foreign-entry" });
      }
      intents[event] = {
        index: freeHookIndex(record.server, event),
        command: hookCommand(manifestPath, record),
      };
    }
    writeJsonAtomic(manifestPath, { ...record, hooks: intents });

    const hooks = {};
    const installed = [];
    for (const event of EVENTS) {
      const { index } = intents[event];
      tmuxRun(record.server, ["set-hook", "-g", event + "[" + index + "]", hookCommand(manifestPath, record)]);
      const readback = readHookEntry(record.server, event, index);
      // Anchored proof: the readback must decode to exactly our complete argv,
      // never merely contain our tokens.
      if (!readback || !hookOwned(readback.command, manifestPath, record)) {
        throw fail("tmux did not install the " + event + " hook at index " + index + " as this pool's exact command", "hook_install");
      }
      // Persist the canonical command for this event right away; the other two
      // intents stay on disk until their own readback replaces them.
      hooks[event] = { index, command: readback.command };
      writeJsonAtomic(manifestPath, { ...record, hooks: { ...intents, ...hooks } });
      installed.push({ event, index });
    }
    writeJsonAtomic(manifestPath, { ...record, hooks });
    return { hooks, installed, unconfirmed };
  } finally {
    if (releaseWorker) releaseWorker();
    releaseHook();
  }
}

// -- Cleanup -----------------------------------------------------------------

const refusal = (refused, extra = {}) => ({
  stopped: false,
  refused,
  killed: [],
  unconfirmed: [],
  server: null,
  session: null,
  ...extra,
});

function dropWorkerEntry(record, address) {
  const workerPanes = { ...record.workerPanes };
  let changed = false;
  for (const [workerId, entry] of Object.entries(workerPanes)) {
    if (entry.paneId === address) {
      delete workerPanes[workerId];
      changed = true;
    }
  }
  return changed ? { ...record, workerPanes } : record;
}

/**
 * Fenced sweep for one pool.
 *
 * The hook calls this with allowRootLive=false: it refuses while the root
 * program is live. The launcher may pass allowRootLive=true only as itself,
 * i.e. process.pid must still be the recorded root pane pid.
 *
 * Only panes in the recorded worker window whose owner/run/generation/worker
 * markers match are killed. A recorded pane that no longer matches is left
 * alone and reported unconfirmed. Hook entries are removed only when both the
 * recorded index and the exact command still match. A stale generation, stale
 * tuple or non-v3 record mutates nothing.
 */
export async function cleanupPool(options = {}) {
  const { manifestPath, owner, run, generation, allowRootLive = false, expectedCoreId } = options;
  if (typeof manifestPath !== "string" || !manifestPath.startsWith("/")) {
    throw fail("manifestPath must be an absolute path", "invalid_params");
  }
  assertId(owner, "owner");
  assertId(run, "run");
  assertInt(generation, "generation", { min: 1 });

  if (!existsSync(manifestPath)) return { stopped: true, absent: true, killed: [], unconfirmed: [] };
  let initial;
  try {
    initial = loadRecord(manifestPath);
    assertRecordIdentity(initial, { owner, run, generation, expectedCoreId });
  } catch (error) {
    if (error instanceof TmuxError) return refusal(error.kind || "record", { detail: error.message });
    throw error;
  }

  const releaseHook = acquireLock(hookLockPath(manifestPath, initial.server));
  let releaseWorker = null;
  try {
    releaseWorker = acquireLock(workerLockPath(manifestPath));
    {
      let record;
      try {
        record = loadRecord(manifestPath);
        assertRecordIdentity(record, { owner, run, generation, expectedCoreId });
      } catch (error) {
        if (error instanceof TmuxError) return refusal(error.kind || "record", { detail: error.message });
        throw error;
      }

      let server;
      try {
        server = serverState(record);
      } catch (error) {
        if (error instanceof TmuxError) return refusal(error.kind, { detail: error.message });
        throw error;
      }

      // Server gone: every pane and every hook entry died with it. Nothing to
      // kill or unset; retire the record's live claims so a later launch can
      // carry the generation forward.
      if (server.state === "gone") {
        try {
          assertRecordIdentity(loadRecord(manifestPath), { owner, run, generation, expectedCoreId });
        } catch (error) {
          if (error instanceof TmuxError) return refusal(error.kind || "stale", { detail: error.message });
          throw error;
        }
        writeJsonAtomic(manifestPath, {
          ...record,
          state: "stopped",
          stoppedAt: Date.now(),
          workerWindow: null,
          workerPanes: {},
          hooks: {},
        });
        return { stopped: true, killed: [], unconfirmed: [], server: "gone", session: "gone", refused: null };
      }

      if (server.state === "live") {
        const root = rootState(record, record.server);
        if (root.state === "live") {
          if (!allowRootLive) return refusal("root_live", { server: "live", session: "live" });
          if (process.pid !== record.rootPane.panePid) {
            return refusal("root_pid_unproven", { server: "live", session: "live" });
          }
        }
      }

      const killed = [];
      const unconfirmed = [];
      let next = record;

      if (server.state === "live" && record.workerWindow) {
        const panes = listWindowPanes(record.server, record.workerWindow) || [];
        const seen = new Set();
        for (const pane of panes) {
          if (pane.paneId === record.rootPane.paneId) continue;
          const entry = Object.entries(record.workerPanes).find(([, value]) => value.paneId === pane.paneId);
          if (!paneOwnedBy(record, pane)) {
            if (entry) {
              unconfirmed.push({ paneId: pane.paneId, reason: "markers-changed" });
              seen.add(pane.paneId);
            }
            continue;
          }
          if (!entry) {
            // Markers prove the pool, but without the recorded pid/start
            // command there is no proof of the exact process; never kill it.
            unconfirmed.push({ paneId: pane.paneId, reason: "unrecorded-marked-pane" });
            seen.add(pane.paneId);
            continue;
          }
          {
            const [, value] = entry;
            if (value.panePid !== pane.panePid || value.startCommand !== pane.startCommand) {
              unconfirmed.push({ paneId: pane.paneId, reason: "pid-or-command-changed" });
              seen.add(pane.paneId);
              continue;
            }
          }
          tmuxRun(record.server, ["kill-pane", "-t", pane.paneId]);
          if (!(await confirmPaneGone(record.server, pane.paneId, Date.now() + GONE_TIMEOUT_MS))) {
            unconfirmed.push({ paneId: pane.paneId, reason: "still-live-after-kill" });
            seen.add(pane.paneId);
            continue;
          }
          killed.push(pane.paneId);
          next = dropWorkerEntry(next, pane.paneId);
        }
        if (killed.length) retileWorkerWindow(record.server, record.workerWindow);
        // Recorded panes that were not in the worker window at all.
        for (const entry of Object.values(record.workerPanes)) {
          if (seen.has(entry.paneId) || killed.includes(entry.paneId)) continue;
          const live = paneDetail(record.server, entry.paneId);
          if (live) {
            unconfirmed.push({ paneId: entry.paneId, reason: "outside-worker-window" });
            seen.add(entry.paneId);
          } else {
            next = dropWorkerEntry(next, entry.paneId);
          }
        }
      } else if (server.state === "session_gone") {
        // Every pane in the session is gone, but the server (and its hooks)
        // is still live.
        next = { ...next, workerWindow: null, workerPanes: {} };
      } else if (server.state === "live") {
        // Live session but no recorded worker window: a recorded pane can only
        // be ours if it still exists and its markers agree.
        for (const entry of Object.values(record.workerPanes)) {
          const live = paneDetail(record.server, entry.paneId);
          if (live) {
            unconfirmed.push({ paneId: entry.paneId, reason: "no-worker-window" });
          } else {
            next = dropWorkerEntry(next, entry.paneId);
          }
        }
      }

      // Owned hook entries are removed only once every owned pane is confirmed
      // gone. A failed retirement keeps them installed so a later worker exit
      // re-triggers this sweep; nothing else can remove them.
      let hooks = { removed: [], unconfirmed: [] };
      if (unconfirmed.length === 0) {
        hooks = removeOwnedHooks(record.server, record, manifestPath);
        for (const item of hooks.unconfirmed) unconfirmed.push({ hook: item.event, index: item.index, reason: item.reason });
      }
      const remainingHooks = { ...(next.hooks ?? {}) };
      for (const item of hooks.removed) delete remainingHooks[item.event];

      // Final generation fence immediately before writing: a helper that
      // started under an older record (or a restart that replaced it) must not
      // overwrite the new generation even if it was slow to reach this point.
      try {
        assertRecordIdentity(loadRecord(manifestPath), { owner, run, generation, expectedCoreId });
      } catch (error) {
        if (error instanceof TmuxError) return refusal(error.kind || "stale", { detail: error.message });
        throw error;
      }
      if (unconfirmed.length === 0) {
        writeJsonAtomic(manifestPath, {
          ...next,
          state: "stopped",
          stoppedAt: Date.now(),
          workerWindow: null,
          workerPanes: {},
          hooks: {},
        });
      } else {
        // A failed sweep keeps the record and its unconfirmed claims; it never
        // claims success. Only metadata proven gone under the lock is pruned:
        // with no recorded pane left and the window id no longer resolving, the
        // window is gone; an unknown (or hijacked) window id stays untouched.
        const pruned = { ...next };
        if (pruned.workerWindow && Object.keys(pruned.workerPanes ?? {}).length === 0 &&
            !windowDetail(record.server, pruned.workerWindow)) {
          pruned.workerWindow = null;
        }
        // Durable label: this record's stop was never proven, so the guard
        // must keep refusing it even after an unproven item was pruned away.
        writeJsonAtomic(manifestPath, { ...pruned, state: "unconfirmed", hooks: remainingHooks });
      }
      return {
        stopped: unconfirmed.length === 0,
        killed,
        unconfirmed,
        refused: null,
        server: "live",
        session: server.state === "session_gone" ? "gone" : "live",
        hooksRemoved: hooks.removed,
      };
    }
  } finally {
    if (releaseWorker) releaseWorker();
    releaseHook();
  }
}

// -- Safe v3 update helper ---------------------------------------------------

const RESERVED_UPDATES = new Set([
  "schemaVersion", "terminalBackend", "owner", "run", "generation",
  "server", "session", "rootPane",
]);

/**
 * Read-modify-write a v3 record under the same bounded worker-window flock.
 * Identity (schema/backend/owner/run/generation/server/session/rootPane) is
 * preserved and cannot be replaced by updates; a non-v3 record is refused
 * untouched. The launcher and extension use this for workerWindow/workerPanes
 * and other per-pool fields.
 */
export async function updatePoolManifest(manifestPath, updates, options = {}) {
  const { owner, run, generation, expectedCoreId } = options;
  if (typeof manifestPath !== "string" || !manifestPath.startsWith("/")) {
    throw fail("manifestPath must be an absolute path", "invalid_params");
  }
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw fail("updates must be an object", "invalid_params");
  }
  for (const key of Object.keys(updates)) {
    if (RESERVED_UPDATES.has(key)) {
      throw fail("refusing to update reserved record field " + key, "invalid_params");
    }
  }
  const release = acquireLock(workerLockPath(manifestPath));
  try {
    const record = loadRecord(manifestPath);
    assertRecordIdentity(record, { owner, run, generation, expectedCoreId });
    const next = {
      ...record,
      ...updates,
      schemaVersion: record.schemaVersion,
      terminalBackend: record.terminalBackend,
      owner: record.owner,
      run: record.run,
      generation: record.generation,
      server: record.server,
      session: record.session,
      rootPane: record.rootPane,
    };
    const validated = validateRecord(next, manifestPath);
    writeJsonAtomic(manifestPath, validated);
    return validated;
  } finally {
    release();
  }
}

/** Read-only snapshot for guards and rendering; never mutates or kills. */
export async function inspectPool(options = {}) {
  const { manifestPath } = options;
  if (typeof manifestPath !== "string" || !manifestPath.startsWith("/")) {
    throw fail("manifestPath must be an absolute path", "invalid_params");
  }
  let record;
  try {
    record = loadRecord(manifestPath);
  } catch (error) {
    return { record: null, valid: false, reason: error.message, server: "unknown", root: "unknown", terminals: [] };
  }
  let server;
  try {
    server = serverState(record);
  } catch (error) {
    return { record, valid: true, server: "stale", reason: error.message, root: "unknown", terminals: [] };
  }
  if (server.state === "gone") return { record, valid: true, server: "gone", root: "gone", terminals: [] };
  if (server.state === "session_gone") return { record, valid: true, server: "live", root: "gone", terminals: [] };
  const root = rootState(record, record.server);
  const terminals = (listWindowPanes(record.server, record.workerWindow) || [])
    .filter((pane) => paneOwnedBy(record, pane))
    .map((pane) => ({ address: pane.paneId, name: pane.worker, pid: pane.panePid, startCommand: pane.startCommand }));
  return { record, valid: true, server: "live", root: root.state, terminals, hooks: record.hooks ?? {} };
}

// -- Trusted worker-side wrapper ---------------------------------------------

function parseWrapperOptions(argv) {
  const out = { identity: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (arg === "--identity") {
      const value = argv[++i];
      if (!value) throw fail("--identity needs KEY=VALUE", "usage");
      const eq = value.indexOf("=");
      if (eq <= 0) throw fail("--identity needs KEY=VALUE", "usage");
      out.identity.push([value.slice(0, eq), value.slice(eq + 1)]);
      continue;
    }
    const key = arg.replace(/^--/, "");
    const value = argv[++i];
    if (value === undefined) throw fail("missing value for " + arg, "usage");
    out[key] = value;
  }
  return out;
}

/**
 * The wrapper tmux exec'd directly in the new pane. It proves the pool and
 * root, registers its own pane under the worker-window flock, marks the pane,
 * re-proves the root, and only then execve()s the worker argv. On any failure
 * it exits: remain-on-exit is off for the worker window, so the pane closes
 * and a create that raced a root death leaves nothing behind.
 */
async function workerExec(argv) {
  const opts = parseWrapperOptions(argv);
  const required = ["manifest", "owner", "run", "generation", "worker-id", "expected-core-id"];
  for (const key of required) {
    if (opts[key] === undefined) throw fail("worker-exec requires --" + key, "usage");
  }
  const manifestPath = opts.manifest;
  const workerId = opts["worker-id"];
  const expectedCoreId = opts["expected-core-id"];
  const generation = Number(opts.generation);
  assertId(workerId, "workerId", WORKER_ID_RE);
  assertInt(generation, "generation", { min: 1 });
  const identity = identityPairs(Object.fromEntries(opts.identity));
  if (!Array.isArray(opts.rest) || opts.rest.length === 0 || !opts.rest[0].startsWith("/")) {
    throw fail("worker argv must start with an absolute program path", "usage");
  }

  const selfEnv = copyEnv(process.env);
  const tmuxVar = selfEnv.TMUX;
  const paneId = selfEnv.TMUX_PANE;
  if (typeof tmuxVar !== "string" || !PANE_RE.test(String(paneId))) {
    throw fail("worker-exec must run inside the tmux pane tmux created", "root_not_tmux");
  }
  const parts = tmuxVar.split(",");
  if (parts.length !== 3) throw fail("TMUX is not a server tuple", "root_not_tmux");
  // TMUX's start-time field is not authoritative (tmux 3.7c reports 0); the
  // live probe below supplies the tuple that must match the record.
  const hint = { socketPath: parts[0], pid: Number(parts[1]), version: "" };
  const self = paneDetail(hint, paneId);
  if (!self) throw fail("this pane is not live", "root_not_live");
  if (self.panePid !== process.pid) {
    throw fail(
      "worker wrapper is not the pane's direct program (pane_pid " + self.panePid + ", wrapper " + process.pid + ")",
      "not_direct",
    );
  }
  const probed = parseServerProbe(tmuxQuery(hint, ["display-message", "-p", "-t", paneId, "-F", SERVER_FMT]));
  if (!probed || probed.sessionId !== self.sessionId) {
    throw fail("worker pane did not answer the server tuple probe", "malformed_reply");
  }
  const server = {
    socketPath: probed.socketPath,
    pid: probed.pid,
    startTime: probed.startTime,
    version: probed.version,
  };

  let registered = false;
  let record = null;
  {
    const release = acquireLock(workerLockPath(manifestPath));
    try {
    record = loadRecord(manifestPath);
    assertRecordIdentity(record, {
      owner: opts.owner,
      run: opts.run,
      generation,
      expectedCoreId,
    });
    if (
      server.socketPath !== record.server.socketPath ||
      server.pid !== record.server.pid ||
      server.startTime !== record.server.startTime
    ) {
      throw fail("worker pane is on a different tmux server than the pool record", "stale_tuple");
    }
    if (self.sessionId !== record.session.id) {
      throw fail("worker pane is in " + self.sessionId + ", not the pool session " + record.session.id, "not_owned");
    }
    // The spawner records a new window only after tmux returns its id, so the
    // wrapper may see null or a window that has just disappeared. A live
    // reserved window in this session that is not this pane's window is
    // always a refusal.
    let workerWindow = record.workerWindow;
    if (workerWindow) {
      const reserved = windowDetail(record.server, workerWindow);
      if (reserved && reserved.sessionId === record.session.id) {
        if (workerWindow !== self.windowId) {
          throw fail(
            "worker pane is in window " + self.windowId + ", not the reserved worker window " + workerWindow,
            "not_owned",
          );
        }
      } else {
        // The spawner records a new window only after tmux returns its id, so a
        // stale/absent id is adopted from the pane that actually got created.
        workerWindow = self.windowId;
      }
    } else {
      workerWindow = self.windowId;
    }
    {
      const rootPane = assertRootLive(record);
      ensureRootRemainOff(record.server, rootPane, process.pid === rootPane.panePid);
    }
    const existing = record.workerPanes[workerId];
    if (existing && existing.paneId !== paneId) {
      throw fail(
        "worker " + workerId + " is already registered as " + existing.paneId + "; refusing to replace it",
        "already_exists",
      );
    }
    const workerPanes = {
      ...record.workerPanes,
      [workerId]: { paneId, panePid: self.panePid, startCommand: self.startCommand },
    };
    record = {
      ...record,
      workerWindow,
      workerPanes,
    };
    writeJsonAtomic(manifestPath, record);
    registered = true;
    } finally {
      release();
    }
  }

  const setMarker = (name, value) =>
    tmuxRun(record.server, ["set-option", "-p", "-t", paneId, name, value]);
  try {
    setMarker("@mind.owner", record.owner);
    setMarker("@mind.run", record.run);
    setMarker("@mind.generation", String(record.generation));
    setMarker("@mind.worker", workerId);
    if (opts.name) tmuxRun(record.server, ["select-pane", "-t", paneId, "-T", opts.name], { allowFailure: true });
  } catch (error) {
    await abandonWrapper(manifestPath, paneId, workerId, expectedCoreId, registered);
    throw error;
  }

  // Last proof before the worker program starts. If the sweep already ran or
  // the root died during registration, this pane removes its own record and
  // markers and exits; the pane then closes.
  let stillLive = false;
  try {
    const current = loadRecord(manifestPath);
    assertRecordIdentity(current, { owner: opts.owner, run: opts.run, generation, expectedCoreId });
    const entry = current.workerPanes[workerId];
    stillLive = current.state !== "stopped" &&
      Boolean(entry && entry.paneId === paneId) &&
      rootState(current, current.server).state === "live";
  } catch {
    stillLive = false;
  }
  if (!stillLive) {
    await abandonWrapper(manifestPath, paneId, workerId, expectedCoreId, registered);
    throw fail("root or pool changed before the worker program started; the wrapper retired itself", "root_not_live");
  }

  const execEnv = { ...selfEnv, ...Object.fromEntries(identity) };
  process.execve(opts.rest[0], opts.rest, execEnv);
  throw fail("execve returned without replacing the wrapper", "exec_failed");
}

async function abandonWrapper(manifestPath, paneId, workerId, expectedCoreId, registered) {
  let record = null;
  try {
    record = recordOrNull(manifestPath);
  } catch { /* ignore */ }
  if (record) {
    for (const name of ["@mind.owner", "@mind.run", "@mind.generation", "@mind.worker"]) {
      try {
        tmuxRun(record.server, ["set-option", "-pu", "-t", paneId, name], { allowFailure: true });
      } catch { /* pane may be gone */ }
    }
  }
  if (!registered) return;
  let release = null;
  try {
    release = acquireLock(workerLockPath(manifestPath));
    const current = recordOrNull(manifestPath);
    if (!current) return;
    try {
      assertRecordIdentity(current, { expectedCoreId });
    } catch {
      return;
    }
    const entry = current.workerPanes[workerId];
    if (!entry || entry.paneId !== paneId) return;
    const workerPanes = { ...current.workerPanes };
    delete workerPanes[workerId];
    writeJsonAtomic(manifestPath, { ...current, workerPanes });
  } catch { /* the sweep/record owner is authoritative */ } finally {
    if (release) release();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--worker-exec") {
    try {
      await workerExec(argv.slice(1));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write("[tmux-worker] " + message + "\n");
      process.exitCode = 3;
    }
    return;
  }
  process.stderr.write(
    "usage: tmux-terminal.mjs --worker-exec --manifest <path> --owner <id> --run <id> " +
      "--generation <n> --worker-id <id> --expected-core-id <id> [--identity KEY=VALUE]... -- <argv...>\n" +
      "hook/guard CLI: tmux-cleanup.mjs --cleanup --record <manifest> --owner <id> --run <id> --generation <n>\n",
  );
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
