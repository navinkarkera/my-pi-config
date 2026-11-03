#!/usr/bin/env node

// tmux-cleanup.mjs - the read-only removal guard behind dotfiles tmux-mind.
//
//   tmux-cleanup.mjs --check-stopped <canonical-root>
//
// The legacy hc/tmux hosting is retired, so the mutating hook sweep (--cleanup)
// and the read-only root locator (--locate-root) are gone with their backend.
// This file now only reads: it starts no server, removes no hook, deletes no
// state, opens no pane and kills no process.
//
// Scans the mindworker state dir. A record blocks when its canonical root is
// the queried root or any path segment under it (Workmux monorepo: the pane
// tag may be a nested config dir while the worktree is an ancestor). It also
// checks every recorded launcher/mind/root/worker pid with ESRCH-only proof,
// so a server-gone record cannot permit removal while a recorded process is
// alive or uncertain. Missing/invalid root fields, unreadable JSON, unknown
// schemas, and v2/legacy records without positive host proof are conservative
// refusals.
//
// A v3/tmux record additionally needs exact read-only tmux proof: the recorded
// server tuple and session must be gone from the recorded socket, the recorded
// root pane must not still run with the recorded pid and start command, and no
// pane may carry this pool's owner/run/generation markers. The recorded socket
// is the only selector; an inherited TMUX client is never consulted.
//
// stdout is empty; diagnostics go to stderr.
// Exit: 0 = safe, 3 = refused, 1 = error, 2 = usage. Writes and kills nothing.

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SEP = "\u001f";
const SESSION_RE = /^\$[0-9]+$/;
const PANE_RE = /^%[0-9]+$/;
// The identity fields the retired backend always wrote: a record without them
// cannot prove which panes are its own, so it is invalid before any probe runs.
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const WINDOW_RE = /^@[0-9]+$/;
const MAX_RECORDS = 200;
const TMUX_TIMEOUT_MS = 10_000;
const MAX_TMUX_OUTPUT = 1024 * 1024;
const LEGACY_PID_KEYS = ["launcherPid", "mindPid", "mindSupervisorPid", "mindChildPid", "workerPid"];
const LEGACY_SOCKET_KEYS = ["socketPath", "socket", "mindSocket", "workerSocket"];
// pane_start_command may itself contain the separator, so it is re-joined.
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

function usage(message) {
  process.stderr.write(
    (message ? message + "\n" : "") +
      "usage: tmux-cleanup.mjs --check-stopped <canonical-root>\n",
  );
  process.exitCode = 2;
}

function parseArgs(argv) {
  if (argv[0] === "--check-stopped") {
    if (argv.length !== 2) throw new Error("--check-stopped takes exactly one path");
    return { root: argv[1] };
  }
  if (argv.length === 0) throw new Error("choose --check-stopped <canonical-root>");
  throw new Error(
    "unknown argument " + JSON.stringify(argv[0]) +
      ": only the read-only --check-stopped guard remains (the mutating --cleanup and --locate-root modes are gone)",
  );
}

// Same normalization as pi's getAgentDir(): a literal "~" or "~/" expands, the
// value is never trimmed. A relative or file:// value is refused before any
// scan, so a live pool can never be reported stopped.
function agentDirForGuard() {
  const raw = process.env.PI_CODING_AGENT_DIR;
  let dir = raw || join(homedir(), ".pi", "agent");
  if (raw === "~") dir = homedir();
  else if (raw && raw.startsWith("~/")) dir = join(homedir(), raw.slice(2));
  if (!dir.startsWith("/")) {
    throw new Error(
      'PI_CODING_AGENT_DIR must be an absolute path or start with "~/"; relative and file:// values are refused, got ' +
        JSON.stringify(raw) + "; refusing",
    );
  }
  return dir;
}

function stateDir() {
  return join(agentDirForGuard(), "mindworker");
}

function listManifests() {
  const dir = stateDir();
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith("-manifest.json"))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return { dir, names: [], error: null };
    return { dir, names: [], error };
  }
  if (names.length > MAX_RECORDS) return { dir, names: [], error: new Error("too many records (> " + MAX_RECORDS + ")") };
  return { dir, names, error: null };
}

// ESRCH is the only proof a process is gone. Success (alive), EPERM and any
// other error are alive/unknown and must refuse a filesystem removal.
function pidState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error.code === "ESRCH" ? "gone" : "unknown";
  }
}

function canonicalForGuard(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || /[\0\n]/.test(value)) {
    return { ok: false, reason: "invalid " + label };
  }
  try {
    return { ok: true, path: realpathSync(value) };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      // A removed worktree still compares lexically.
      return { ok: true, path: resolve(value) };
    }
    return { ok: false, reason: "cannot canonicalize " + label + ": " + (error.code || error.message) };
  }
}

/**
 * All present root fields must be valid and agree; a missing field or a
 * conflict is conservative unknown, never an identity collapse.
 */
function recordRoot(record) {
  const keys = ["cwd", "rootDir", "projectRoot"].filter((key) => record?.[key] !== undefined);
  if (keys.length === 0) return { ok: false, reason: "missing root field" };
  const canonical = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || !value.startsWith("/") || /[\0\n]/.test(value)) {
      return { ok: false, reason: "invalid " + key };
    }
    const info = canonicalForGuard(value, key);
    if (!info.ok) return info;
    canonical.push(info.path);
  }
  if (new Set(canonical).size !== 1) return { ok: false, reason: "conflicting root fields" };
  return { ok: true, path: canonical[0] };
}

/** True when recordRoot is the queried root or a path segment under it. */
function atOrUnder(recordRoot, queryRoot) {
  const rel = relative(queryRoot, recordRoot);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function classification(record) {
  const schema = record?.schemaVersion;
  const backend = record?.terminalBackend;
  if (schema === 3 && backend === "tmux") return "v3";
  if (schema === 2 && backend === "hc") return "v2";
  const legacySchema = schema === undefined || schema === null || schema === 1;
  const legacyBackend = backend === undefined || backend === null || backend === "herdr";
  if (legacySchema && legacyBackend) return "legacy";
  return "unknown";
}

function recordedV3Pids(record) {
  const pids = [];
  const add = (label, value) => {
    if (value !== undefined && value !== null) pids.push([label, value]);
  };
  add("launcherPid", record.launcherPid);
  add("mindPid", record.mindPid);
  add("rootPane.panePid", record.rootPane?.panePid);
  for (const [workerId, entry] of Object.entries(record.workerPanes ?? {})) {
    add("workerPanes." + workerId + ".panePid", entry?.panePid);
  }
  return pids;
}

function recordedLegacyPids(record) {
  const pids = [];
  for (const key of LEGACY_PID_KEYS) {
    if (record?.[key] !== undefined && record[key] !== null) pids.push([key, record[key]]);
  }
  for (const [key, value] of Object.entries(record?.workerPids ?? {})) pids.push(["workerPids." + key, value]);
  return pids;
}

function recordedLegacySockets(record) {
  const paths = [];
  const add = (label, value) => {
    if (value === undefined || value === null) return;
    if (typeof value !== "string" || !value.startsWith("/") || /[\0\n]/.test(value)) {
      paths.push({ label, path: null });
    } else {
      paths.push({ label, path: value });
    }
  };
  for (const key of LEGACY_SOCKET_KEYS) add(key, record?.[key]);
  add("coreIdentity.socket", record?.coreIdentity?.socket);
  add("coreIdentity.terminalSocket", record?.coreIdentity?.terminalSocket);
  return paths;
}

/**
 * v2/hc and legacy records have no v3 host tuple. Stopped means: an explicit
 * stopped/exited state AND at least one recorded pid AND every recorded pid is
 * ESRCH AND every recorded socket path is absent. The state word alone is
 * never proof.
 */
function legacyStoppedReason(record) {
  if (record.state !== "stopped" && record.state !== "exited") return "not proven stopped";
  const pids = recordedLegacyPids(record);
  if (pids.length === 0) return "no recorded pid proof";
  for (const [label, pid] of pids) {
    const state = pidState(pid);
    if (state !== "gone") return label + " is " + state;
  }
  for (const item of recordedLegacySockets(record)) {
    if (item.path === null) return "invalid socket field " + item.label;
    try {
      lstatSync(item.path);
      return "recorded socket " + item.path + " is present";
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        return "recorded socket " + item.path + " is " + (error.code || "unknown");
      }
    }
  }
  return null;
}

function v3PidProblem(record) {
  for (const [label, pid] of recordedV3Pids(record)) {
    const state = pidState(pid);
    if (state !== "gone") return label + " is " + state;
  }
  return null;
}

// Only a proven absence is "gone": tmux naming no server, a socket that does
// not exist, a refused connection, or a target tmux itself reports as missing.
// Anything else — permission denied, a non-socket path, an unknown failure, a
// client-context complaint — is unreadable evidence and must refuse, because a
// live pool behind an unreadable socket is not a stopped pool.
const GONE_RE = new RegExp(
  [
    "no server running",
    "server exited unexpectedly",
    "can't find (?:session|window|pane)",
    "no such (?:session|window|pane)",
    "no sessions",
    "error connecting to .*\\((?:No such file or directory|Connection refused)\\)",
  ].join("|"),
  "i",
);

/** One read-only tmux query against the recorded socket; null means gone. */
function tmuxQuery(server, args) {
  const env = { ...process.env };
  // The recorded -S target is the only selector; an inherited TMUX must not
  // move the probe onto another server or pane.
  delete env.TMUX;
  delete env.TMUX_PANE;
  const result = spawnSync(process.env.PI_TMUX_BIN || "tmux", ["-S", server.socketPath, "-N", ...args], {
    encoding: "utf8",
    timeout: TMUX_TIMEOUT_MS,
    maxBuffer: MAX_TMUX_OUTPUT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error("tmux " + args[0] + ": " + result.error.message);
  if (result.signal) throw new Error("tmux " + args[0] + " timed out after " + TMUX_TIMEOUT_MS + "ms");
  if (result.status === 0) return result.stdout || "";
  const stderr = (result.stderr || "").trim();
  if (GONE_RE.test(stderr)) return null;
  throw new Error("tmux " + args[0] + " failed (" + result.status + "): " + (stderr || "no stderr"));
}

function fields(text) {
  if (!text) return null;
  return text.replace(/\n$/, "").split(SEP);
}

/**
 * The recorded server and session must be exactly the live ones. "gone" means
 * no server answered (so every pane is gone); "session_gone" means the server
 * answered but the recorded session is no longer there.
 */
function serverState(record) {
  // list-sessions first: display-message -t '$N:' falls back to the server's
  // current session when $N is gone, so a direct display cannot prove absence.
  const listed = tmuxQuery(record.server, ["list-sessions", "-F", "#{session_id}"]);
  if (listed === null || !listed.trim()) return { state: "gone" };
  const ids = listed.split("\n").map((line) => line.trim()).filter(Boolean);
  const order = ids.includes(record.session.id)
    ? [record.session.id, ...ids.filter((id) => id !== record.session.id)]
    : ids;
  let tuple = null;
  for (const id of order) {
    const parts = fields(tmuxQuery(record.server, ["display-message", "-p", "-t", id + ":", "-F", SERVER_FMT]));
    if (parts && parts.length >= 6 && parts[4] === id) {
      tuple = parts.slice(0, 6);
      break;
    }
  }
  if (!tuple) return { state: "gone" };
  const live = {
    socketPath: tuple[0],
    pid: Number(tuple[1]),
    startTime: Number(tuple[2]),
    version: tuple[3],
    sessionId: tuple[4],
    created: Number(tuple[5]),
  };
  if (
    live.socketPath !== record.server.socketPath ||
    live.pid !== record.server.pid ||
    live.startTime !== record.server.startTime
  ) {
    return {
      state: "stale",
      reason:
        "tmux server tuple changed: record " + record.server.pid + "." + record.server.startTime +
        " at " + record.server.socketPath + ", live " + live.pid + "." + live.startTime + " at " + live.socketPath,
    };
  }
  if (!ids.includes(record.session.id)) return { state: "session_gone" };
  if (live.sessionId !== record.session.id || live.created !== record.session.created) {
    return {
      state: "stale",
      reason:
        "tmux session id/created changed: record " + record.session.id + "." + record.session.created +
        ", live " + live.sessionId + "." + live.created,
    };
  }
  return { state: "live" };
}

function parsePane(text) {
  const parts = fields(text);
  if (!parts || parts.length < 9) return null;
  const tail = parts.slice(parts.length - 6);
  return {
    paneId: parts[0],
    panePid: Number(parts[1]),
    startCommand: parts.slice(2, parts.length - 6).join(SEP),
    windowId: tail[0],
    sessionId: tail[1],
    owner: tail[2],
    run: tail[3],
    generation: tail[4],
    worker: tail[5],
  };
}

function paneDetail(server, paneId) {
  const pane = parsePane(tmuxQuery(server, ["display-message", "-p", "-t", paneId, "-F", PANE_FMT]));
  if (!pane || pane.paneId !== paneId) return null;
  return pane;
}

/** The recorded root program is still the same pane, pid and start command. */
function rootState(record) {
  const pane = paneDetail(record.server, record.rootPane.paneId);
  if (!pane) return { state: "gone" };
  if (
    pane.sessionId !== record.session.id ||
    pane.panePid !== record.rootPane.panePid ||
    pane.startCommand !== record.rootPane.startCommand
  ) {
    return { state: "replaced" };
  }
  return { state: "live" };
}

/**
 * Panes on the recorded server, in the recorded session, whose markers prove
 * they belong to this pool generation. An unmarked editor or tool pane never
 * appears; pane ids are re-read from tmux, never from the record.
 */
function ownedMarkerPanes(record) {
  const text = tmuxQuery(record.server, ["list-panes", "-a", "-F", PANE_FMT]);
  if (text === null) return [];
  const found = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const parts = line.split(SEP);
    if (parts.length < 9) continue;
    const tail = parts.slice(parts.length - 6);
    const pane = { paneId: parts[0], sessionId: tail[1], owner: tail[2], run: tail[3], generation: tail[4], worker: tail[5] };
    // Identity is owner/run/generation inside the recorded session. The worker
    // label is not part of it: a cleared @mind.worker must not hide a live pane.
    if (
      pane.sessionId === record.session.id &&
      pane.owner === record.owner &&
      pane.run === record.run &&
      pane.generation === String(record.generation)
    ) {
      found.push(pane.paneId);
    }
  }
  return found;
}

const isInt = (value, min) => Number.isSafeInteger(value) && value >= min;
const isAbsPath = (value) => typeof value === "string" && value.startsWith("/") && !/[\0\n]/.test(value);

/**
 * A v3 record must carry its identity and a usable tuple before any probe runs.
 * This is the retired backend's own contract (owner/run ids, a positive
 * generation, a @window or null worker window, a workerPanes object): a record
 * that fails it can no longer say which panes belong to it, so it refuses
 * rather than fall through to a proof of absence.
 */
function v3RecordProblem(record) {
  if (typeof record.owner !== "string" || !ID_RE.test(record.owner)) return "invalid owner";
  if (typeof record.run !== "string" || !ID_RE.test(record.run)) return "invalid run";
  if (!isInt(record.generation, 1)) return "invalid generation";
  if (record.workerWindow !== null && !WINDOW_RE.test(String(record.workerWindow))) {
    return "invalid workerWindow";
  }
  const panes = record.workerPanes;
  if (!panes || typeof panes !== "object" || Array.isArray(panes)) return "invalid workerPanes";
  const server = record.server;
  const session = record.session;
  const root = record.rootPane;
  if (
    !server || typeof server !== "object" ||
    !isAbsPath(server.socketPath) || !isInt(server.pid, 1) || !isInt(server.startTime, 0) ||
    typeof server.version !== "string"
  ) {
    return "invalid server tuple";
  }
  if (
    !session || typeof session !== "object" || typeof session.id !== "string" ||
    !SESSION_RE.test(session.id) || !isInt(session.created, 0)
  ) {
    return "invalid session tuple";
  }
  if (
    !root || typeof root !== "object" || typeof root.paneId !== "string" ||
    !PANE_RE.test(root.paneId) || !isInt(root.panePid, 1) || typeof root.startCommand !== "string"
  ) {
    return "invalid root pane";
  }
  return null;
}

function v3StoppedReason(record) {
  // Identity first: an unprovable record refuses before any proof of absence, so
  // a gone server can never excuse a record whose panes we cannot recognize.
  const invalid = v3RecordProblem(record);
  if (invalid) return "invalid v3 record: " + invalid;
  // Every recorded process must be ESRCH-gone on every branch, including a
  // server-gone, session-gone or replaced-root branch.
  const pidProblem = v3PidProblem(record);
  if (pidProblem) return pidProblem;

  let server;
  try {
    server = serverState(record);
  } catch (error) {
    return "unreadable live state: " + (error instanceof Error ? error.message : String(error));
  }
  if (server.state === "stale") return "stale server tuple: " + server.reason;
  // With every recorded pid gone, a dead server or session proves the host is
  // gone even if the retired backend never wrote a stopped marker.
  if (server.state === "gone" || server.state === "session_gone") return null;

  let root;
  try {
    root = rootState(record);
  } catch (error) {
    return "unreadable live state: " + (error instanceof Error ? error.message : String(error));
  }
  if (root.state === "live") return "root live";

  let owned;
  try {
    owned = ownedMarkerPanes(record);
  } catch (error) {
    return "unreadable live state: " + (error instanceof Error ? error.message : String(error));
  }
  if (owned.length > 0) return "owned worker panes live: " + owned.join(",");

  const listed = Boolean(record.workerWindow) || Object.keys(record.workerPanes ?? {}).length > 0;
  // A sweep that could not prove quiescence wrote this label and kept the
  // record; it is never "stopped" even after its worker state was pruned.
  if (record.state === "unconfirmed" || record.unconfirmed) return "unconfirmed record";
  if (record.state === "stopped") return listed ? "stopped record still lists worker state" : null;
  if (listed) return "unconfirmed worker records";
  return null;
}

function blockedReason(record) {
  const kind = classification(record);
  if (kind === "v3") return v3StoppedReason(record);
  if (kind === "v2" || kind === "legacy") return legacyStoppedReason(record);
  return "unknown schemaVersion " + JSON.stringify(record?.schemaVersion) +
    " / terminalBackend " + JSON.stringify(record?.terminalBackend);
}

function checkStopped(rootArg) {
  const rootInfo = canonicalForGuard(rootArg, "root");
  if (!rootInfo.ok) {
    process.stderr.write("refused " + JSON.stringify(rootArg) + ": " + rootInfo.reason + "\n");
    return 3;
  }
  const root = rootInfo.path;
  const listed = listManifests();
  if (listed.error) {
    process.stderr.write("refused " + root + ": " + listed.dir + ": " + listed.error.message + "\n");
    return 3;
  }
  let blocked = 0;
  for (const manifestPath of listed.names) {
    let record;
    try {
      record = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      blocked++;
      process.stderr.write("refused " + root + ": " + manifestPath + ": unreadable record\n");
      continue;
    }
    const recordRootInfo = recordRoot(record);
    if (!recordRootInfo.ok) {
      blocked++;
      process.stderr.write("refused " + root + ": " + manifestPath + ": " + recordRootInfo.reason + "\n");
      continue;
    }
    if (!atOrUnder(recordRootInfo.path, root)) continue;
    const reason = blockedReason(record);
    if (reason === null) {
      process.stderr.write("stopped " + root + " (" + manifestPath + ")\n");
    } else {
      blocked++;
      process.stderr.write("refused " + root + ": " + manifestPath + ": " + reason + "\n");
    }
  }
  if (blocked > 0) return 3;
  process.stderr.write("stopped " + root + "\n");
  return 0;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    process.exitCode = checkStopped(opts.root);
  } catch (error) {
    process.stderr.write("tmux-cleanup: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}

main();
