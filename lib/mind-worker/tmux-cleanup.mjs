#!/usr/bin/env node

// tmux-cleanup.mjs - the trusted entrypoint behind the pool's global tmux
// hooks, plus the read-only filesystem guards for dotfiles tmux-mind.
//
// Hook CLI (installed by tmux-terminal.mjs as run-shell -b):
//   tmux-cleanup.mjs --cleanup --record <manifest> --owner <id> --run <id> --generation <n>
//
// The event arguments tmux supplies are deliberately ignored: the helper
// re-reads the recorded server tuple, root pane, owner, run and generation,
// takes the shared hook-index lock and the pool worker-window lock, and only
// then sweeps. A stale helper (old generation, replaced server, non-v3 record)
// mutates nothing. It never prompts and carries no credential.
//
// The hook path is silent on both stdout and stderr for an expected no-op:
// tmux run-shell opens a view on any output. A live root is the normal no-op
// while the pool runs; a clean stop or an absent record is also silent. Only a
// refusal that needs attention (stale generation, non-v3 record, unconfirmed
// sweep) writes one diagnostic to stderr.
// Exit codes: 0 = expected no-op (live root, pool stopped, or record absent),
// 3 = refused or unconfirmed (live state kept, diagnostic on stderr),
// 1 = operational error, 2 = usage.
//
// Read-only removal guard:
//   tmux-cleanup.mjs --check-stopped <canonical-root>
//
// Scans the mindworker state dir. A record blocks when its canonical root is
// the queried root or any path segment under it (Workmux monorepo: the pane
// tag may be a nested config dir while the worktree is an ancestor). It also
// checks every recorded launcher/mind/root/worker pid with ESRCH-only proof,
// so a server-gone record cannot permit removal while a recorded process is
// alive or uncertain. Missing/invalid root fields, unreadable JSON, unknown
// schemas, and v2/legacy records without positive host proof are conservative
// refusals. stdout is empty; diagnostics go to stderr.
// Exit: 0 = safe, 3 = refused, 1 = error, 2 = usage. Writes and kills nothing.
//
// Read-only root locator for the script owner:
//   tmux-cleanup.mjs --locate-root <canonical-root> \
//     --session '$N' --socket <captured-socket> --server-pid <pid>
//
// Probes the captured source by exact session id (list-sessions first: tmux
// would otherwise fall back to its current session), then returns exactly one
// JSON object on stdout when a UNIQUE live v3/tmux record has that exact
// canonical root and the same captured source/session:
//   {"manifestPath":"...","server":{...},"session":{...},
//    "rootPane":{"paneId":"%N","panePid":123,"startCommand":"..."}}
// The root pane may have moved to another window in the same session; the
// pane id/pid/start command are the identity and callers use paneId to select
// the actual window. Exit 0 = unique live; 3 = proven absent/stopped;
// 4 = refused (unknown, legacy/hc, unconfirmed, multiple live, cross-source);
// 1 = error; 2 = usage. No mutations and no kills.

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { cleanupPool, inspectPool, probeTmuxSource, TmuxError } from "./tmux-terminal.mjs";

const OWNER_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SESSION_RE = /^\$[0-9]+$/;
const MAX_RECORDS = 200;
const LEGACY_PID_KEYS = ["launcherPid", "mindPid", "mindSupervisorPid", "mindChildPid", "workerPid"];
const LEGACY_SOCKET_KEYS = ["socketPath", "socket", "mindSocket", "workerSocket"];

function usage(message) {
  process.stderr.write(
    (message ? message + "\n" : "") +
      "usage: tmux-cleanup.mjs --cleanup --record <manifest> --owner <id> --run <id> --generation <n>\n" +
      "       tmux-cleanup.mjs --check-stopped <canonical-root>\n" +
      "       tmux-cleanup.mjs --locate-root <canonical-root> --session '$N' --socket <socket> --server-pid <pid>\n",
  );
  process.exitCode = 2;
}

function parseArgs(argv) {
  const out = { mode: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cleanup") {
      if (out.mode) throw new Error("choose exactly one mode");
      out.mode = "cleanup";
    } else if (arg === "--check-stopped") {
      if (out.mode) throw new Error("choose exactly one mode");
      out.mode = "check-stopped";
      out.root = argv[++i];
      if (out.root === undefined) throw new Error("--check-stopped needs a path");
    } else if (arg === "--locate-root") {
      if (out.mode) throw new Error("choose exactly one mode");
      out.mode = "locate-root";
      out.root = argv[++i];
      if (out.root === undefined) throw new Error("--locate-root needs a path");
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (value === undefined) throw new Error("missing value for --" + key);
      out[key] = value;
    } else {
      throw new Error("unexpected argument " + JSON.stringify(arg));
    }
  }
  if (!out.mode) throw new Error("choose --cleanup, --check-stopped or --locate-root");
  return out;
}

// Same normalization as the launcher and pi's getAgentDir(): a literal "~" or
// "~/" expands, the value is never trimmed. A relative or file:// value is
// refused before any scan, so a live pool can never be reported stopped.
function agentDirForGuard() {
  const raw = process.env.PI_CODING_AGENT_DIR;
  let dir = raw || join(homedir(), ".pi", "agent");
  if (raw === "~") dir = homedir();
  else if (raw && raw.startsWith("~/")) dir = join(homedir(), raw.slice(2));
  if (!dir.startsWith("/")) {
    throw new Error(
      'PI_CODING_AGENT_DIR must be an absolute path or start with "~/" (relative and file:// values are refused), got ' +
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

async function v3StoppedReason(manifestPath, record) {
  // Every recorded process must be ESRCH-gone on every branch, including a
  // server-gone or session-gone branch.
  const pidProblem = v3PidProblem(record);
  if (pidProblem) return pidProblem;
  let info;
  try {
    info = await inspectPool({ manifestPath });
  } catch (error) {
    return "unreadable: " + (error instanceof Error ? error.message : String(error));
  }
  if (!info.valid) return "invalid v3 record: " + (info.reason || "unknown");
  if (info.server === "stale") return "stale server tuple: " + (info.reason || "unknown");
  // With every recorded pid gone, a dead server or session proves the host is
  // gone even if cleanup never wrote a stopped marker.
  if (info.server === "gone" || info.server === "session_gone") return null;
  if (info.root === "live") return "root live";
  if (info.terminals.length > 0) {
    return "owned worker panes live: " + info.terminals.map((item) => item.address).join(",");
  }
  const listed = Boolean(record.workerWindow) || Object.keys(record.workerPanes ?? {}).length > 0;
  // A sweep that could not prove quiescence writes this label and keeps the
  // record; it is never "stopped" even after its worker state was pruned.
  if (record.state === "unconfirmed" || record.unconfirmed) return "unconfirmed record";
  if (record.state === "stopped") return listed ? "stopped record still lists worker state" : null;
  if (listed) return "unconfirmed worker records";
  return null;
}

async function blockedReason(manifestPath, record) {
  const kind = classification(record);
  if (kind === "v3") return v3StoppedReason(manifestPath, record);
  if (kind === "v2" || kind === "legacy") return legacyStoppedReason(record);
  return "unknown schemaVersion " + JSON.stringify(record?.schemaVersion) +
    " / terminalBackend " + JSON.stringify(record?.terminalBackend);
}

async function checkStopped(rootArg) {
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
    const reason = await blockedReason(manifestPath, record);
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

async function runCleanup(opts) {
  for (const key of ["record", "owner", "run", "generation"]) {
    if (opts[key] === undefined) throw new Error("--cleanup needs --" + key);
  }
  if (!opts.record.startsWith("/")) throw new Error("--record must be an absolute path");
  if (!OWNER_RE.test(opts.owner)) throw new Error("--owner has an invalid form");
  if (!OWNER_RE.test(opts.run)) throw new Error("--run has an invalid form");
  const generation = Number(opts.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("--generation must be a positive integer");

  const result = await cleanupPool({
    manifestPath: opts.record,
    owner: opts.owner,
    run: opts.run,
    generation,
    allowRootLive: false,
  });
  // The hook path is silent for expected no-ops: tmux run-shell opens a view
  // on any output. A live root is the normal state while the pool runs.
  if (result.stopped) return 0;
  if (result.refused === "root_live") return 0;
  process.stderr.write(
    "cleanup: refused " + (result.refused || "unconfirmed") +
      (result.killed.length ? " killed=" + result.killed.join(",") : "") +
      (result.unconfirmed.length ? " unconfirmed=" + result.unconfirmed.length : "") + "\n",
  );
  return 3;
}

async function locateRoot(opts) {
  const rootInfo = canonicalForGuard(opts.root, "root");
  if (!rootInfo.ok) {
    process.stderr.write("locate: " + rootInfo.reason + "\n");
    return 4;
  }
  if (typeof opts.session !== "string" || !SESSION_RE.test(opts.session)) throw new Error("--session must be '$N'");
  if (typeof opts.socket !== "string" || !opts.socket.startsWith("/")) throw new Error("--socket must be an absolute path");
  const serverPid = Number(opts["server-pid"]);
  if (!Number.isSafeInteger(serverPid) || serverPid <= 0) throw new Error("--server-pid must be a positive integer");

  let source;
  try {
    source = probeTmuxSource({ socketPath: opts.socket, serverPid, sessionId: opts.session });
  } catch (error) {
    if (error instanceof TmuxError) {
      process.stderr.write("locate: " + error.message + "\n");
      return 4;
    }
    throw error;
  }
  if (source.state === "gone") {
    process.stderr.write("locate: requested source session is absent\n");
    return 3;
  }

  const root = rootInfo.path;
  const listed = listManifests();
  if (listed.error) {
    process.stderr.write("locate: " + listed.error.message + "\n");
    return 4;
  }
  const live = [];
  let stopped = 0;
  let unknown = false;
  for (const manifestPath of listed.names) {
    let record;
    try {
      record = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      unknown = true;
      process.stderr.write("locate: " + manifestPath + ": unreadable record\n");
      continue;
    }
    const recordRootInfo = recordRoot(record);
    if (!recordRootInfo.ok) {
      unknown = true;
      process.stderr.write("locate: " + manifestPath + ": " + recordRootInfo.reason + "\n");
      continue;
    }
    if (recordRootInfo.path !== root) continue;

    const kind = classification(record);
    if (kind !== "v3") {
      unknown = true;
      process.stderr.write("locate: " + manifestPath + ": " + kind + " record for this root\n");
      continue;
    }
    if (record.state === "unconfirmed" || record.unconfirmed) {
      unknown = true;
      process.stderr.write("locate: " + manifestPath + ": unconfirmed record\n");
      continue;
    }
    if (
      record.session?.id !== source.session.id ||
      record.server?.socketPath !== source.server.socketPath ||
      record.server?.pid !== source.server.pid ||
      record.server?.startTime !== source.server.startTime ||
      record.session?.created !== source.session.created
    ) {
      unknown = true;
      process.stderr.write("locate: " + manifestPath + ": cross-source record\n");
      continue;
    }
    let info;
    try {
      info = await inspectPool({ manifestPath });
    } catch (error) {
      unknown = true;
      process.stderr.write("locate: " + manifestPath + ": " + (error instanceof Error ? error.message : String(error)) + "\n");
      continue;
    }
    if (!info.valid || info.server === "stale") {
      unknown = true;
      process.stderr.write("locate: " + manifestPath + ": " + (info.reason || "stale record") + "\n");
      continue;
    }
    if (info.server === "live" && info.root === "live") {
      live.push({ manifestPath, record });
    } else {
      // A stopped/gone classification is only proof when every recorded
      // process is ESRCH-gone; an alive/unknown pid is unconfirmed, not 3.
      const pidProblem = v3PidProblem(record);
      if (pidProblem) {
        unknown = true;
        process.stderr.write("locate: " + manifestPath + ": " + pidProblem + "\n");
        continue;
      }
      stopped++;
    }
  }

  if (unknown) return 4;
  if (live.length > 1) {
    process.stderr.write("locate: multiple live pools for this root/source\n");
    return 4;
  }
  if (live.length === 1) {
    const { manifestPath, record } = live[0];
    process.stdout.write(JSON.stringify({
      manifestPath,
      server: record.server,
      session: record.session,
      rootPane: record.rootPane,
    }) + "\n");
    return 0;
  }
  process.stderr.write(stopped > 0 ? "locate: pool is stopped\n" : "locate: no record for this root/source\n");
  return 3;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    if (opts.mode === "check-stopped") {
      process.exitCode = await checkStopped(opts.root);
    } else if (opts.mode === "locate-root") {
      process.exitCode = await locateRoot(opts);
    } else {
      process.exitCode = await runCleanup(opts);
    }
  } catch (error) {
    if (error instanceof TmuxError) {
      process.stderr.write("tmux-cleanup: " + error.message + "\n");
    } else {
      process.stderr.write("tmux-cleanup: " + (error instanceof Error ? error.message : String(error)) + "\n");
    }
    process.exitCode = 1;
  }
}

await main();
