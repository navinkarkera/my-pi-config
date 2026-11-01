import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { workerTerminalName } from "../hc-terminal.mjs";

const NL = String.fromCharCode(10);
const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, "..", "hc-launcher.mjs");
const thinkingLevelModule = join(here, "..", "thinking-level.mjs");
const hcTerminalModule = join(here, "..", "hc-terminal.mjs");
const wrapper = join(here, "..", "..", "..", "bin", "mind-worker-launcher");

const FAKE_PI = [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  "const readline = require('node:readline');",
  "const NL = String.fromCharCode(10);",
  "const startTime = pid => { try { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return s.slice(s.lastIndexOf(')') + 2).trim().split(' ')[19]; } catch { return null; } };",
  "const record = {",
  "  type: 'start', pid: process.pid, ppid: process.ppid, startTime: startTime(process.pid),",
  "  cwd: process.cwd(), args: process.argv.slice(2), executable: process.argv[1],",
  "  role: process.env.PI_MIND_WORKER_ROLE, generation: process.env.PI_MIND_WORKER_GENERATION,",
  "  instance: process.env.PI_MIND_WORKER_INSTANCE || null, supervisor: process.env.PI_MIND_WORKER_LAUNCHER_PID || null,",
  "  stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY,",
  "  secret: process.env.SECRET || null, piSessionId: process.env.PI_SESSION_ID || null,",
  "  hcSocket: process.env.HC_SOCKET || null, hcSession: process.env.HC_SESSION || null,",
  "};",
  "const log = value => fs.appendFileSync(process.env.PI_LOG, JSON.stringify(value) + NL);",
  "log(record);",
  "process.stdout.write('FAKE_PI_STDOUT generation=' + record.generation + NL);",
  "process.stderr.write('FAKE_PI_STDERR generation=' + record.generation + NL);",
  "let finishing = false;",
  "function finish(code, reason) { if (finishing) return; finishing = true; log({ type: 'exit', pid: process.pid, generation: record.generation, code, reason }); process.exit(code); }",
  "process.on('SIGTERM', () => { log({ type: 'signal', generation: record.generation, signal: 'SIGTERM' }); if (process.env.FAKE_PI_IGNORE_TERM !== '1') finish(0, 'SIGTERM'); });",
  "process.on('SIGHUP', () => { log({ type: 'signal', generation: record.generation, signal: 'SIGHUP' }); finish(0, 'SIGHUP'); });",
  "if (process.env.FAKE_PI_FAIL_BEFORE_READY === '1') finish(Number(process.env.FAKE_PI_EXIT_CODE || 31), 'startup-failure');",
  "else {",
  "  const server = net.createServer(socket => socket.end());",
  "  server.on('error', error => { log({ type: 'listen-error', message: error.message }); finish(32, 'listen-error'); });",
  "  server.listen(process.env.SOCKET_FILE, () => {",
  "    fs.writeFileSync(process.env.CONTROL_FILE, JSON.stringify({ status: 'ready', generation: Number(record.generation), lastUpdated: Date.now() }));",
  "    const input = readline.createInterface({ input: process.stdin });",
  "    input.on('line', line => { log({ type: 'input', generation: record.generation, line }); if (line.startsWith('exit:')) finish(Number(line.slice(5)), 'stdin'); });",
  "  });",
  "}",
].join(NL);

const FAKE_HC = [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "const NL = String.fromCharCode(10);",
  "const args = process.argv.slice(2);",
  "const env = { HC_SESSION: process.env.HC_SESSION || null, HC_SOCKET: process.env.HC_SOCKET || null };",
  "fs.appendFileSync(process.env.HC_LOG, JSON.stringify({ args, ppid: process.ppid, env }) + NL);",
  "const out = value => process.stdout.write(JSON.stringify(value));",
  "const fail = (kind, message, hint, code) => { process.stderr.write(JSON.stringify({ error: { kind, message, hint } })); process.exit(code); };",
  "const op = args[0];",
  "if (op === 'server' && args[1] === 'status') {",
  "  if (process.env.HC_SERVER_FAIL === '1') fail('unavailable', 'core unavailable', 'start hc', 5);",
  "  let statusCount = 0;",
  "  try { statusCount = Number(fs.readFileSync(process.env.HC_STATUS_COUNT, 'utf8')); } catch {}",
  "  statusCount += 1; fs.writeFileSync(process.env.HC_STATUS_COUNT, String(statusCount));",
  "  const sequence = String(process.env.HC_CORE_SEQUENCE || '').split(',').filter(Boolean);",
  "  const coreId = sequence.length ? sequence[Math.min(statusCount - 1, sequence.length - 1)] : (process.env.HC_FAKE_CORE_ID || 'core-test');",
  "  const reply = () => out({ core: { id: coreId, name: 'test-host' }, version: '0.1.16', pid: 1, uptime_ms: 1, holders: [], holder: null, installed_by: null, live: 0, finished: 0 });",
  "  if (process.env.HC_SERVER_SLEEP === '1') setTimeout(reply, 1500); else reply();",
  "} else if (op === 'get') {",
  "  let state = { terminals: {} };",
  "  try { state = JSON.parse(fs.readFileSync(process.env.HC_STATE, 'utf8')); } catch {}",
  "  const record = state.terminals[args[1]];",
  "  if (!record) fail('not_found', 'no terminal ' + args[1], 'see hc ls --all', 3);",
  "  let pid = record.pid;",
  "  if (pid === 'self-ppid') pid = process.ppid;",
  "  else if (pid === 'delayed') {",
  "    let count = 0; try { count = Number(fs.readFileSync(process.env.HC_GET_COUNT, 'utf8')); } catch {}",
  "    count += 1; fs.writeFileSync(process.env.HC_GET_COUNT, String(count));",
  "    pid = count <= 2 ? null : process.ppid;",
  "  } else if (pid === 'never') pid = null;",
  "  out({ address: args[1], state: record.state || 'live', parent: record.parent === undefined ? null : record.parent, pid, name: record.name || null });",
  "} else if (op === 'run') {",
  "  if (process.env.HC_RUN_FAIL === '1') fail('blocked', 'auth blocked', 'pi auth login', 9);",
  "  if (process.env.HC_RUN_SLEEP === '1') { setTimeout(() => out({ address: 't99' }), 30000); }",
  "  else {",
  "    let count = 0; try { count = Number(fs.readFileSync(process.env.HC_RUN_COUNT, 'utf8')); } catch {}",
  "    count += 1; fs.writeFileSync(process.env.HC_RUN_COUNT, String(count));",
  "    const generation = /PI_MIND_WORKER_GENERATION=([0-9]+)/.exec(args.join(' '));",
  "    fs.writeFileSync(process.env.CONTROL_FILE, JSON.stringify({ status: 'worker-connected', generation: generation ? Number(generation[1]) : 0, connectedWorkers: count, expectedWorkers: Number(process.env.WORKER_COUNT), lastUpdated: Date.now() }));",
  "    out({ address: 't' + (100 + count), parent: args[args.indexOf('--parent') + 1], name: args[args.indexOf('--name') + 1], state: 'live', pid: 4242 });",
  "  }",
  "} else if (op === 'kill') {",
  "  out({ address: args[1], state: 'finished' });",
  "} else fail('unknown', 'unexpected op ' + op, '', 1);",
].join(NL);

const FAKE_MISE = [
  "#!/bin/sh",
  '[ -n "${MISE_PID_FILE:-}" ] && echo "$$" >> "$MISE_PID_FILE"',
  "shift 3",
  '[ "$1" = node ] && shift',
  'exec ' + JSON.stringify(process.execPath) + ' "$@"',
].join(NL);

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").trim().split(NL).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

function processIdentity(pid) {
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
    return { state: fields[0], startTime: fields[19] };
  } catch { return null; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "mind-hc-launcher-test-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const stateDir = join(agentDir, "mindworker");
  const sessionsDir = join(agentDir, "sessions");
  const project = join(root, "project");
  const fakeBin = join(root, "bin");
  for (const dir of [agentDir, stateDir, sessionsDir, project, fakeBin]) mkdirSync(dir, { recursive: true });

  const piPath = join(fakeBin, "fake-pi");
  const hcPath = join(fakeBin, "hc");
  const misePath = join(fakeBin, "mise");
  writeFileSync(piPath, FAKE_PI);
  writeFileSync(hcPath, FAKE_HC);
  writeFileSync(misePath, FAKE_MISE);
  for (const path of [piPath, hcPath, misePath]) chmodSync(path, 0o755);

  const workerCount = options.workerCount === undefined ? 2 : options.workerCount;
  const terminalId = options.terminalId || "t1";
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 16);
  const id = options.instance ? options.instance + "-" + hash : hash;
  const controlFile = join(stateDir, id + "-mind-control.json");
  const socketFile = join(stateDir, id + ".sock");
  const manifestFile = join(stateDir, id + "-manifest.json");
  const hcLog = join(root, "hc.jsonl");
  const piLog = join(root, "pi.jsonl");
  const hcStateFile = join(root, "hc-state.json");
  const runCountFile = join(root, "hc-run-count");
  const getCountFile = join(root, "hc-get-count");
  const statusCountFile = join(root, "hc-status-count");
  const misePidFile = join(root, "mise-pids");

  writeFileSync(join(agentDir, "mind-worker.json"), JSON.stringify({
    terminalBackend: "hc",
    mindModel: "vendor/mind-model",
    workerModels: [{ model: "vendor/worker-model", count: workerCount, tier: "flash" }],
    ...(options.config || {}),
  }));
  const terminals = {
    ...(options.seedCurrent === false ? {} : { [terminalId]: { state: "live", parent: null, pid: "self-ppid" } }),
    ...((options.hcState && options.hcState.terminals) || {}),
  };
  writeFileSync(hcStateFile, JSON.stringify({ terminals }));
  if (options.manifest !== undefined) {
    writeFileSync(manifestFile, typeof options.manifest === "string" ? options.manifest : JSON.stringify(options.manifest));
  }
  if (options.staleSocket) writeFileSync(socketFile, "stale socket file");

  const env = {
    ...process.env,
    HOME: home,
    PATH: fakeBin + ":" + dirname(process.execPath) + ":" + (process.env.PATH || ""),
    PI_BIN: piPath,
    HC_TERMINAL_ID: terminalId,
    HC_SESSION: "test-session",
    HC_SCOPE: "scope-test",
    HC_TERMINAL_SOCKET: "/tmp/ignored-terminal.sock",
    HC_FAKE_CORE_ID: options.coreId || "core-test",
    HC_CORE_SEQUENCE: (options.coreSequence || []).join(","),
    HC_STATUS_COUNT: statusCountFile,
    HC_LOG: hcLog,
    HC_STATE: hcStateFile,
    HC_RUN_COUNT: runCountFile,
    HC_GET_COUNT: getCountFile,
    CONTROL_FILE: controlFile,
    SOCKET_FILE: socketFile,
    PI_LOG: piLog,
    WORKER_COUNT: String(workerCount),
    HC_RUN_FAIL: options.runFail ? "1" : "0",
    HC_RUN_SLEEP: options.runSleep ? "1" : "0",
    HC_SERVER_FAIL: options.serverFail ? "1" : "0",
    HC_SERVER_SLEEP: options.serverSleep ? "1" : "0",
    FAKE_PI_FAIL_BEFORE_READY: options.piFail ? "1" : "0",
    FAKE_PI_EXIT_CODE: String(options.piExitCode === undefined ? 31 : options.piExitCode),
    FAKE_PI_IGNORE_TERM: options.ignorePiTerm ? "1" : "0",
    MISE_PID_FILE: misePidFile,
    MISE_BIN: misePath,
    SECRET: "s3cr3t-sentinel",
    PI_SESSION_ID: "mind-session-should-not-leak",
    TERM: "mind-term-should-not-leak",
  };
  for (const key of [
    "HC_SOCKET", "PI_MIND_WORKER_ROLE", "PI_MIND_WORKER_TIER", "PI_MIND_WORKER_ID",
    "PI_MIND_WORKER_GENERATION", "PI_MIND_WORKER_SESSION_DIR", "PI_MIND_WORKER_INSTANCE",
    "PI_MIND_WORKER_LAUNCHER_PID", "MIND_WORKER_LAUNCHER_BACKGROUND",
  ]) delete env[key];

  const children = [];
  t.after(async () => {
    for (const entry of children) if (entry.child.exitCode === null) entry.child.kill("SIGTERM");
    await sleep(100);
    for (const entry of children) if (entry.child.exitCode === null) entry.child.kill("SIGKILL");
    for (const start of readJsonl(piLog).filter((entry) => entry.type === "start")) {
      const current = processIdentity(start.pid);
      if (current && current.state !== "Z" && current.startTime === start.startTime) {
        try { process.kill(start.pid, "SIGKILL"); } catch {}
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  return {
    root, home, agentDir, stateDir, sessionsDir, project, fakeBin, piPath, hcPath, misePath,
    hash, id, terminalId, controlFile, socketFile, manifestFile, hcLog, piLog, hcStateFile,
    getCountFile, misePidFile, env, children,
    mindLogFor: (gen) => join(stateDir, id + "-mind-gen" + gen + ".log"),
  };
}

function installTestWrapper(f) {
  const copy = join(f.agentDir, "bin", "mind-worker-launcher");
  const launcherCopy = join(f.agentDir, "lib", "mind-worker", "hc-launcher.mjs");
  mkdirSync(dirname(copy), { recursive: true });
  mkdirSync(dirname(launcherCopy), { recursive: true });
  copyFileSync(wrapper, copy);
  copyFileSync(launcher, launcherCopy);
  copyFileSync(thinkingLevelModule, join(dirname(launcherCopy), "thinking-level.mjs"));
  copyFileSync(hcTerminalModule, join(dirname(launcherCopy), "hc-terminal.mjs"));
  chmodSync(copy, 0o755);
  return copy;
}

function startProcess(f, args = [launcher], extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: f.project,
    env: { ...f.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return track(f, child);
}

function track(f, child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const entry = { child, closed, output: () => ({ stdout, stderr, all: stdout + stderr }) };
  f.children.push(entry);
  return entry;
}

function startPtyProcess(f, command, args = [], extraEnv = {}) {
  const scriptPath = findScript();
  if (!scriptPath) return null;
  const child = spawn(scriptPath, ["-q", "-e", "/dev/null", "--", command, ...args], {
    cwd: f.project,
    env: { ...f.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return track(f, child);
}

function findScript() {
  const result = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await sleep(25);
  }
  throw new Error("timed out waiting for launcher condition");
}

function closeWithin(entry, timeoutMs = 8000) {
  let timer;
  return Promise.race([
    entry.closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("child did not close within " + timeoutMs + "ms")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function hcCalls(f) { return readJsonl(f.hcLog); }
function hcRuns(f) { return hcCalls(f).map((call) => call.args).filter((args) => args[0] === "run"); }
function piStarts(f) { return readJsonl(f.piLog).filter((entry) => entry.type === "start"); }
function readManifest(f) { return JSON.parse(readFileSync(f.manifestFile, "utf8")); }
function readControl(f) { return JSON.parse(readFileSync(f.controlFile, "utf8")); }

/** Every regular file under root containing needle; archive names stay free-form. */
function filesContaining(root, needle) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesContaining(path, needle));
    else if (entry.isFile()) {
      try { if (readFileSync(path, "utf8").includes(needle)) found.push(path); } catch { /* unreadable */ }
    }
  }
  return found;
}

/** A real unix socket the launcher can prove before its first hc call. */
async function listenTerminalSocket(t, path) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return path;
}

function skipWithoutPty(t) {
  if (!findScript()) { t.skip("util-linux script is unavailable; no PTY runner installed"); return true; }
  return false;
}

/** The launcher marks the manifest running only after readiness and every worker. */
function waitPoolRunning(f, generation = 1) {
  return waitFor(() => {
    try {
      const manifest = readManifest(f);
      return manifest.state === "running" && manifest.generation === generation;
    } catch { return false; }
  });
}

/** Start the real launcher under a real PTY (the Node preflight demands one). */
function startLauncherPty(f, extraEnv = {}, extraArgs = []) {
  return startPtyProcess(f, process.execPath, [launcher, ...extraArgs], extraEnv);
}

// ── Preflight refusals (no spawn, no PTY needed) ──

test("the Node preflight refuses a direct non-TTY launch before Mind or workers", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /must be TTYs/);
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
});

test("a launch with no core selector at all is refused before any hc query", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  const proc = startProcess(f, [launcher], { HC_SESSION: "", HC_SOCKET: "", HC_TERMINAL_SOCKET: "" });
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /HC_SESSION \(or HC_SOCKET\) is not set/);
  assert.deepEqual(hcCalls(f), []);
  assert.deepEqual(piStarts(f), []);
});

test("the terminal socket alone pins HC_SOCKET before the first hc query", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  const socket = await listenTerminalSocket(t, join(f.root, "terminal-core.sock"));
  const proc = startProcess(f, [launcher], { HC_SESSION: "", HC_TERMINAL_SOCKET: socket });
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /must be TTYs/, "the selector gate passes and the TTY gate stops it");
  const first = hcCalls(f)[0];
  assert.equal(first.env.HC_SOCKET, socket);
  assert.equal(first.env.HC_SESSION, null);
  assert.deepEqual(hcRuns(f), []);
  assert.deepEqual(piStarts(f), []);
});

test("explicit HC_SESSION or HC_SOCKET is never replaced by the terminal socket", async (t) => {
  const terminalSocket = "/tmp/terminal-core.sock";
  const cases = [
    { extraEnv: { HC_SESSION: "explicit-session" }, session: "explicit-session", socket: null },
    { extraEnv: { HC_SESSION: "", HC_SOCKET: "/tmp/explicit-core.sock" }, session: null, socket: "/tmp/explicit-core.sock" },
  ];
  for (const entry of cases) {
    const f = fixture(t, { workerCount: 1 });
    const proc = startProcess(f, [launcher], { ...entry.extraEnv, HC_TERMINAL_SOCKET: terminalSocket });
    assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
    assert.match(proc.output().stderr, /must be TTYs/);
    const first = hcCalls(f)[0];
    assert.equal(first.env.HC_SESSION, entry.session);
    assert.equal(first.env.HC_SOCKET, entry.socket);
  }
});

test("an absent or refused terminal socket fails before hc, Mind or workers", async (t) => {
  for (const kind of ["absent", "refused"]) {
    const f = fixture(t, { workerCount: 1 });
    const socket = join(f.root, kind + ".sock");
    if (kind === "refused") writeFileSync(socket, "");
    const proc = startProcess(f, [launcher], { HC_SESSION: "", HC_TERMINAL_SOCKET: socket });
    assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
    assert.match(proc.output().stderr, /HC_TERMINAL_SOCKET .* is not reachable/);
    assert.deepEqual(hcCalls(f), []);
    assert.deepEqual(hcRuns(f), []);
    assert.deepEqual(piStarts(f), []);
  }
});

test("the terminal-socket fallback still requires HC_TERMINAL_ID before probing", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  const proc = startProcess(f, [launcher], {
    HC_TERMINAL_ID: "", HC_SESSION: "", HC_TERMINAL_SOCKET: "/tmp/unused-core.sock",
  });
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /HC_TERMINAL_ID is not set/);
  assert.deepEqual(hcCalls(f), []);
  assert.deepEqual(piStarts(f), []);
});

test("an unavailable core probe fails closed before any terminal query", async (t) => {
  const f = fixture(t, { workerCount: 1, serverFail: true });
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /core unavailable/);
  assert.deepEqual(hcCalls(f).map((call) => call.args[0]), ["server"]);
  assert.deepEqual(hcRuns(f), []);
});

test("a plain non-exec launch is refused before any worker or Mind", async (t) => {
  const f = fixture(t, { workerCount: 1, hcState: { terminals: { t1: { state: "live", parent: null, pid: 999999999 } } } });
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /not the root program/);
  assert.match(proc.output().stderr, /mind-worker-launcher/);
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
});

test("a root terminal that is not live, not parentless or unknown is refused", async (t) => {
  for (const [record, pattern] of [
    [{ state: "finished", parent: null, pid: "self-ppid" }, /is finished; Mind needs a live terminal/],
    [{ state: "live", parent: "t9", pid: "self-ppid" }, /parentless terminal/],
  ]) {
    const f = fixture(t, { workerCount: 1, hcState: { terminals: { t1: record } } });
    const proc = startProcess(f);
    assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
    assert.match(proc.output().stderr, pattern);
    assert.deepEqual(piStarts(f), []);
    assert.deepEqual(hcRuns(f), []);
  }
  const unknown = fixture(t, { workerCount: 1, seedCurrent: false });
  const proc = startProcess(unknown);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /hc does not know terminal t1/);
  assert.deepEqual(piStarts(unknown), []);
});

test("a pid that never appears is refused after the bounded poll, not treated as a match", { timeout: 15000 }, async (t) => {
  const f = fixture(t, { workerCount: 1, hcState: { terminals: { t1: { state: "live", parent: null, pid: "never" } } } });
  const startedAt = Date.now();
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc, 10000), { code: 1, signal: null });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 2500 && elapsed < 8000, "bounded pid poll took " + elapsed + "ms");
  assert.match(proc.output().stderr, /has not reported a pid/);
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
});

test("a legacy manifest is refused without takeover or cleanup", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  const legacy = { schemaVersion: 1, terminalBackend: "herdr", generation: 5, cwd: f.project, mindInPlace: true, launcherPid: 4242 };
  writeFileSync(f.manifestFile, JSON.stringify(legacy));
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /legacy mind-worker pool/);
  assert.match(proc.output().stderr, /Nothing was archived|No automatic takeover/);
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(JSON.parse(readFileSync(f.manifestFile, "utf8")), legacy);
});

test("a restarted core with the same session is refused (core.id is the identity)", async (t) => {
  const f = fixture(t, { workerCount: 1, coreId: "core-new" });
  writeFileSync(f.manifestFile, JSON.stringify({
    schemaVersion: 2,
    terminalBackend: "hc",
    coreIdentity: { id: "core-old", session: "test-session", socket: null, scope: "scope-old" },
    rootTerminalAddress: "t1",
    cwd: f.project,
    generation: 2,
    launcherPid: 4242,
    mindPid: 4243,
  }));
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /different hc core \(id\)/);
  assert.deepEqual(piStarts(f), []);
});

test("a same-session core change between status and the root read fails closed", async (t) => {
  const f = fixture(t, { workerCount: 1, coreSequence: ["core-old", "core-new"] });
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /core mismatch/);
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
  assert.equal(existsSync(f.manifestFile), false, "no manifest may be written before Mind");
  assert.deepEqual(hcCalls(f).map((call) => call.args[0]), ["server", "server"]);
});

test("a same-session core change between root preflight and stale read leaves the manifest untouched", async (t) => {
  const f = fixture(t, {
    workerCount: 1,
    terminalId: "t2",
    coreSequence: ["core-old", "core-old", "core-new"],
    hcState: { terminals: { t1: { state: "finished", parent: null, pid: 123456 } } },
  });
  const manifest = {
    schemaVersion: 2,
    terminalBackend: "hc",
    coreIdentity: { id: "core-old", session: "test-session", socket: null },
    rootTerminalAddress: "t1",
    cwd: f.project,
    generation: 7,
    launcherPid: 123456,
    mindPid: 654321,
    state: "stopped",
  };
  writeFileSync(f.manifestFile, JSON.stringify(manifest));
  const before = readFileSync(f.manifestFile, "utf8");
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /core mismatch/);
  assert.equal(readFileSync(f.manifestFile, "utf8"), before, "stale recovery must not overwrite the manifest");
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
});

test("a missing manifest with surviving control or socket runtime state fails closed without cleanup", async (t) => {
  for (const kind of ["control", "socket"]) {
    const f = fixture(t, { workerCount: 1 });
    const path = kind === "control" ? f.controlFile : f.socketFile;
    writeFileSync(path, kind === "control"
      ? JSON.stringify({ status: "worker-connected", generation: 3 })
      : "stale socket");
    const before = readFileSync(path, "utf8");
    const proc = startProcess(f);
    assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
    assert.match(proc.output().stderr, /without a v2 manifest/);
    assert.match(proc.output().stderr, /Stop the existing pool|archive/);
    assert.equal(existsSync(f.manifestFile), false, "no fresh manifest may be written");
    assert.equal(readFileSync(path, "utf8"), before, "runtime state must not be cleaned up");
    assert.deepEqual(piStarts(f), []);
    assert.deepEqual(hcRuns(f), []);
  }
});

test("a v2 manifest without coreIdentity.id fails closed", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  writeFileSync(f.manifestFile, JSON.stringify({
    schemaVersion: 2,
    terminalBackend: "hc",
    coreIdentity: { session: "test-session" },
    rootTerminalAddress: "t1",
    cwd: f.project,
    generation: 2,
    launcherPid: 4242,
  }));
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /no coreIdentity.id/);
  assert.deepEqual(piStarts(f), []);
});

test("an unreadable or malformed manifest is fail-closed, not fresh", async (t) => {
  const f = fixture(t, { workerCount: 1, manifest: "{ this is not json" });
  const before = readFileSync(f.manifestFile, "utf8");
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /is not valid JSON/);
  assert.equal(readFileSync(f.manifestFile, "utf8"), before);
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
});

test("a live pair is refused with its root address", async (t) => {
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { sleeper.kill("SIGKILL"); } catch {} });
  const f = fixture(t, {
    workerCount: 1,
    terminalId: "t2",
    hcState: { terminals: { t1: { state: "live", parent: null, pid: sleeper.pid } } },
  });
  writeFileSync(f.manifestFile, JSON.stringify({
    schemaVersion: 2,
    terminalBackend: "hc",
    coreIdentity: { id: "core-test", session: "test-session", socket: null },
    rootTerminalAddress: "t1",
    cwd: f.project,
    generation: 2,
    launcherPid: sleeper.pid,
    mindPid: sleeper.pid,
  }));
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /Mind is already running/);
  assert.match(proc.output().stderr, /hc kill t1/);
  assert.deepEqual(piStarts(f), []);
});

test("a live root with ambiguous ownership fails closed", async (t) => {
  const f = fixture(t, {
    workerCount: 1,
    terminalId: "t2",
    hcState: { terminals: { t1: { state: "live", parent: null, pid: 999999999 } } },
  });
  writeFileSync(f.manifestFile, JSON.stringify({
    schemaVersion: 2,
    terminalBackend: "hc",
    coreIdentity: { id: "core-test", session: "test-session", socket: null },
    rootTerminalAddress: "t1",
    cwd: f.project,
    generation: 2,
    launcherPid: 999999999,
    mindPid: 999999998,
  }));
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /ownership is ambiguous/);
  assert.deepEqual(piStarts(f), []);
});

test("the launcher refuses the removed --reset and a non-hc backend", async (t) => {
  const resetFixture = fixture(t, { workerCount: 1 });
  const reset = startProcess(resetFixture, [launcher, "--reset"]);
  assert.deepEqual(await closeWithin(reset), { code: 1, signal: null });
  assert.match(reset.output().stderr, /Whole-pool reset is gone/);
  assert.deepEqual(hcCalls(resetFixture), []);

  const backendFixture = fixture(t, { workerCount: 1, config: { terminalBackend: "herdr" } });
  const backend = startProcess(backendFixture);
  assert.deepEqual(await closeWithin(backend), { code: 1, signal: null });
  assert.match(backend.output().stderr, /terminalBackend must be "hc"/);
  assert.deepEqual(hcCalls(backendFixture), []);
});

test("the wrapper refuses a launch outside an hc terminal and rejects removed flags", (t) => {
  const f = fixture(t, { workerCount: 1 });
  const testWrapper = installTestWrapper(f);

  const outside = { ...f.env };
  delete outside.HC_TERMINAL_ID;
  const missing = spawnSync("bash", [testWrapper], { cwd: f.project, env: outside, encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /HC_TERMINAL_ID is not set/);

  const reset = spawnSync("bash", [testWrapper, "--reset"], { cwd: f.project, env: f.env, encoding: "utf8" });
  assert.equal(reset.status, 2);
  assert.match(reset.stderr, /Whole-pool reset is gone/);

  const background = spawnSync("bash", [testWrapper, "--background"], { cwd: f.project, env: f.env, encoding: "utf8" });
  assert.equal(background.status, 2);
  assert.match(background.stderr, /--background is gone/);

  const envBackground = spawnSync("bash", [testWrapper], {
    cwd: f.project,
    env: { ...f.env, MIND_WORKER_LAUNCHER_BACKGROUND: "1" },
    encoding: "utf8",
  });
  assert.equal(envBackground.status, 2);
  assert.match(envBackground.stderr, /MIND_WORKER_LAUNCHER_BACKGROUND is gone/);

  const detached = spawnSync("bash", [testWrapper], { cwd: f.project, env: f.env, encoding: "utf8" });
  assert.equal(detached.status, 2);
  assert.match(detached.stderr, /must be started interactively/);

  assert.deepEqual(hcCalls(f), []);
});

// ── PTY runs (the Node preflight requires a real terminal) ──

test("starts Mind in the root terminal and static workers as direct hc children", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 2 });
  const proc = startLauncherPty(f);
  await waitPoolRunning(f);

  const mind = piStarts(f)[0];
  assert.equal(mind.role, "mind");
  assert.equal(mind.generation, "1");
  assert.equal(mind.cwd, f.project);
  assert.equal(mind.ppid, Number(mind.supervisor));
  assert.equal(mind.secret, "s3cr3t-sentinel", "Mind keeps the terminal environment");
  assert.deepEqual(mind.args, ["--model", "vendor/mind-model"]);

  const runs = hcRuns(f);
  assert.equal(runs.length, 2);
  const session0 = join(f.sessionsDir, "worker-" + f.hash + "-0");
  const session1 = join(f.sessionsDir, "worker-" + f.hash + "-1");
  const name0 = runs[0][runs[0].indexOf("--name") + 1];
  assert.match(name0, /^[0-9a-f]{12}-w0$/);
  assert.ok(name0.length <= 32);
  assert.deepEqual(runs[0], [
    "run", "--bg", "--json", "--no-notify", "--rm",
    "--parent", "t1",
    "--name", name0,
    "--cwd", f.project,
    "--", "/usr/bin/env",
    "PI_MIND_WORKER_ROLE=worker",
    "PI_MIND_WORKER_TIER=flash",
    "PI_MIND_WORKER_ID=worker-0",
    "PI_MIND_WORKER_GENERATION=1",
    "PI_MIND_WORKER_SESSION_DIR=" + session0,
    "/usr/bin/mise", "x", "node@26", "--", f.piPath,
    "--model", "vendor/worker-model", "--thinking", "max", "--session-dir", session0,
  ]);
  assert.equal(runs[1][runs[1].indexOf("--name") + 1].endsWith("-w1"), true);
  assert.ok(runs[1].includes("PI_MIND_WORKER_ID=worker-1"));
  assert.ok(runs[1].includes("PI_MIND_WORKER_SESSION_DIR=" + session1));

  const argvText = runs.flat().join(NL);
  assert.doesNotMatch(argvText, /HC_TERMINAL_ID|HC_SESSION|PI_SESSION_ID|SECRET|mind-term-should-not-leak/);
  assert.equal(runs.flat().some((part) => ["--no-parent", "--keep", "--outlive-parent", "--mode", "rpc"].includes(part)), false);
  assert.equal(runs.every((args) => args[1] === "--bg" && args[2] === "--json" && args[3] === "--no-notify" && args[4] === "--rm"), true);

  const manifest = readManifest(f);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.terminalBackend, "hc");
  assert.equal(manifest.coreIdentity.id, "core-test");
  assert.equal(manifest.coreIdentity.session, "test-session");
  assert.equal(manifest.coreIdentity.version, "0.1.16");
  assert.equal("scope" in manifest.coreIdentity, false, "HC_SCOPE is per-terminal, never core identity");
  assert.equal("terminalSocket" in manifest.coreIdentity, false);
  assert.equal(manifest.rootTerminalAddress, "t1");
  assert.equal(manifest.cwd, f.project);
  assert.equal(manifest.generation, 1);
  assert.equal(manifest.launcherPid, Number(mind.supervisor));
  assert.equal(manifest.mindPid, mind.pid);
  assert.deepEqual(manifest.workerAddresses, { "worker-0": "t101", "worker-1": "t102" });
  for (const dead of ["mindPaneId", "workerPaneId_0", "workerTabId", "workerWorkspaceId", "mindInPlace", "workerHerdrSession", "launcherTokenHash", "kittyWindowId"]) {
    assert.equal(dead in manifest, false, dead + " must not be in a v2 manifest");
  }
  assert.equal(existsSync(session0), true);

  proc.child.stdin.write("exit:23" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 23, signal: null });
  assert.equal(readManifest(f).state, "stopped");
  assert.equal(readManifest(f).launcherPid, null);
  assert.equal(readControl(f).status, "stopped");
});

test("Mind inherits the pinned terminal-socket selector for the burst extension", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const socket = await listenTerminalSocket(t, join(f.root, "terminal-core.sock"));
  const proc = startLauncherPty(f, { HC_SESSION: "", HC_TERMINAL_SOCKET: socket });
  await waitPoolRunning(f);
  const mind = piStarts(f)[0];
  assert.equal(mind.hcSocket, socket);
  assert.equal(mind.hcSession, null);
  assert.equal(hcCalls(f)[0].env.HC_SOCKET, socket);
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("Mind stderr goes to a per-generation log instead of the launcher terminal", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const proc = startLauncherPty(f);
  await waitPoolRunning(f);
  assert.match(readFileSync(f.mindLogFor(1), "utf8"), /FAKE_PI_STDERR generation=1/);
  assert.match(proc.output().all, /FAKE_PI_STDOUT generation=1/);
  assert.doesNotMatch(proc.output().all, /FAKE_PI_STDERR/);
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("a pid that appears after a few null polls is accepted", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, hcState: { terminals: { t1: { state: "live", parent: null, pid: "delayed" } } } });
  const proc = startLauncherPty(f);
  await waitPoolRunning(f);
  assert.equal(piStarts(f).length, 1);
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("a proven-stale v2 record recovers on the same core id even when HC_SCOPE changed", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, terminalId: "t2", staleSocket: true });
  const transcriptDir = join(f.sessionsDir, "worker-" + f.hash + "-0");
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(transcriptDir, "old-transcript.txt"), "keep this transcript");
  writeFileSync(join(f.stateDir, f.hash + "-results.jsonl"), "keep dashboard history" + NL);
  writeFileSync(f.manifestFile, JSON.stringify({
    schemaVersion: 2,
    terminalBackend: "hc",
    coreIdentity: { id: "core-test", session: "test-session", socket: null, scope: "scope-old", terminalSocket: "/old.sock" },
    rootTerminalAddress: "t1",
    cwd: f.project,
    cwdHash: f.hash,
    generation: 3,
    launcherPid: 123456,
    mindPid: 654321,
    workerAddresses: { "worker-0": "t50" },
    state: "stopped",
  }));

  const proc = startLauncherPty(f, { HC_SCOPE: "scope-new" });
  await waitPoolRunning(f, 4);
  const mind = piStarts(f)[0];
  assert.equal(mind.generation, "4");
  assert.equal(readManifest(f).generation, 4);
  assert.equal(readControl(f).generation, 4);
  assert.equal(readManifest(f).coreIdentity.id, "core-test");
  assert.equal(readFileSync(join(transcriptDir, "old-transcript.txt"), "utf8"), "keep this transcript");
  assert.equal(readFileSync(join(f.stateDir, f.hash + "-results.jsonl"), "utf8"), "keep dashboard history" + NL);
  assert.deepEqual(hcCalls(f).map((call) => call.args[0]).filter((op) => op === "kill"), []);
  assert.equal(existsSync(f.socketFile), true, "Mind bound the socket the launcher refreshed");
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("a finished root record is stale and recovers", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, {
    workerCount: 1,
    terminalId: "t2",
    hcState: { terminals: { t1: { state: "finished", parent: null, pid: 123456 } } },
  });
  writeFileSync(f.manifestFile, JSON.stringify({
    schemaVersion: 2,
    terminalBackend: "hc",
    coreIdentity: { id: "core-test", session: "test-session", socket: null },
    rootTerminalAddress: "t1",
    cwd: f.project,
    generation: 7,
    launcherPid: 123456,
    mindPid: 654321,
  }));
  const proc = startLauncherPty(f);
  await waitPoolRunning(f, 8);
  assert.equal(piStarts(f)[0].generation, "8");
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("Mind startup failure propagates a nonzero exit without launching workers", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, piFail: true, piExitCode: 31 });
  const proc = startLauncherPty(f);
  assert.deepEqual(await closeWithin(proc, 12000), { code: 31, signal: null });
  assert.deepEqual(hcRuns(f), []);
  assert.equal(readManifest(f).state, "stopped");
});

test("Mind exit 0 before readiness is still a nonzero startup failure", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, piFail: true, piExitCode: 0 });
  const proc = startLauncherPty(f);
  assert.deepEqual(await closeWithin(proc, 12000), { code: 1, signal: null });
  assert.deepEqual(hcRuns(f), []);
  assert.equal(readManifest(f).state, "stopped");
});

test("a worker spawn failure stops Mind and exits 1", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, runFail: true });
  const proc = startLauncherPty(f);
  assert.deepEqual(await closeWithin(proc, 12000), { code: 1, signal: null });
  assert.match(proc.output().all, /FATAL: hc run: auth blocked/);
  assert.ok(readJsonl(f.piLog).some((entry) => entry.type === "signal" && entry.signal === "SIGTERM"));
  assert.equal(readManifest(f).state, "stopped");
});

test("SIGTERM stops Mind within bounds and exits 143 without killing workers", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const proc = startLauncherPty(f);
  await waitPoolRunning(f);
  const mind = piStarts(f)[0];
  process.kill(Number(mind.supervisor), "SIGTERM");
  assert.deepEqual(await closeWithin(proc), { code: 143, signal: null });
  assert.ok(readJsonl(f.piLog).some((entry) => entry.type === "signal" && entry.signal === "SIGTERM"));
  assert.equal(hcCalls(f).some((call) => call.args[0] === "kill"), false, "the core owns worker teardown");
});

test("SIGHUP (a pane close) stops Mind and exits 129", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const proc = startLauncherPty(f);
  await waitPoolRunning(f);
  const mind = piStarts(f)[0];
  process.kill(Number(mind.supervisor), "SIGHUP");
  assert.deepEqual(await closeWithin(proc), { code: 129, signal: null });
  // The launcher owns the hangup; it terminates Mind with TERM rather than forwarding HUP.
  assert.ok(readJsonl(f.piLog).some((entry) => entry.type === "signal" && entry.signal === "SIGTERM"));
});

test("a TERM-ignoring Mind is escalated within a bounded time", { timeout: 25000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, ignorePiTerm: true });
  const proc = startLauncherPty(f);
  await waitPoolRunning(f);
  const mind = piStarts(f)[0];
  const startedAt = Date.now();
  process.kill(Number(mind.supervisor), "SIGTERM");
  assert.deepEqual(await closeWithin(proc, 12000), { code: 143, signal: null });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 4500 && elapsed < 12000, "bounded escalation took " + elapsed + "ms");
  assert.ok(readJsonl(f.piLog).some((entry) => entry.type === "signal" && entry.signal === "SIGTERM"));
});

test("thinking defaults: workers on max, Mind without --thinking", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 2 });
  const proc = startLauncherPty(f);
  await waitPoolRunning(f);
  assert.deepEqual(piStarts(f)[0].args, ["--model", "vendor/mind-model"]);
  const runs = hcRuns(f);
  assert.equal(runs.length, 2);
  for (const run of runs) assert.equal(run[run.indexOf("--thinking") + 1], "max");
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("configured mind and per-entry worker thinking levels reach the CLI", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, {
    workerCount: 2,
    config: {
      mindThinkingLevel: "high",
      workerThinkingLevel: "low",
      workerModels: [
        { model: "vendor/strong-model", count: 1, tier: "strong", thinkingLevel: "xhigh" },
        { model: "vendor/flash-model", count: 1, tier: "flash" },
      ],
    },
  });
  const proc = startLauncherPty(f);
  await waitPoolRunning(f);
  assert.deepEqual(piStarts(f)[0].args, ["--model", "vendor/mind-model", "--thinking", "high"]);
  const runs = hcRuns(f);
  assert.equal(runs.length, 2);
  assert.equal(runs[0][runs[0].indexOf("--thinking") + 1], "xhigh");
  assert.ok(runs[0].includes("PI_MIND_WORKER_TIER=strong"));
  assert.equal(runs[1][runs[1].indexOf("--thinking") + 1], "low");
  assert.ok(runs[1].includes("PI_MIND_WORKER_TIER=flash"));
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("invalid thinking settings never reach the CLI", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, config: { mindThinkingLevel: "bogus", workerThinkingLevel: "bogus" } });
  const proc = startLauncherPty(f);
  await waitPoolRunning(f);
  assert.deepEqual(piStarts(f)[0].args, ["--model", "vendor/mind-model"]);
  const run = hcRuns(f)[0];
  assert.equal(run[run.indexOf("--thinking") + 1], "max");
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("--instance keeps a second pool in the same cwd isolated", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, instance: "beta" });
  const proc = startLauncherPty(f, {}, ["--instance", "beta"]);
  await waitPoolRunning(f);
  const manifest = readManifest(f);
  assert.equal(manifest.instance, "beta");
  assert.equal(manifest.cwdHash, f.hash);
  assert.equal(piStarts(f)[0].instance, "beta");
  const run = hcRuns(f)[0];
  assert.match(run[run.indexOf("--name") + 1], /^[0-9a-f]{12}-w0$/);
  assert.ok(run.includes("PI_MIND_WORKER_INSTANCE=beta"));
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("PI_BIN with spaces stays one executable argument and is not forced through node", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const spaced = join(f.fakeBin, "fake pi");
  copyFileSync(f.piPath, spaced);
  chmodSync(spaced, 0o755);
  const proc = startLauncherPty(f, { PI_BIN: spaced });
  await waitPoolRunning(f);
  const mind = piStarts(f)[0];
  assert.equal(mind.executable, spaced);
  assert.ok(hcRuns(f)[0].includes(spaced), "PI_BIN is one argv element, not a shell line");
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("worker names include cwd, instance and generation, so long shared prefixes never collide", { timeout: 30000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, instance: "team-alpha-long" });
  const first = startLauncherPty(f, {}, ["--instance", "team-alpha-long"]);
  await waitPoolRunning(f);
  const name1 = hcRuns(f)[0][hcRuns(f)[0].indexOf("--name") + 1];
  first.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(first), { code: 0, signal: null });

  // The old root is finished; the next run is a new root (t2) and generation 2.
  writeFileSync(f.hcStateFile, JSON.stringify({
    terminals: {
      t1: { state: "finished", parent: null, pid: 12345 },
      t2: { state: "live", parent: null, pid: "self-ppid" },
    },
  }));
  const second = startLauncherPty(f, { HC_TERMINAL_ID: "t2" }, ["--instance", "team-alpha-long"]);
  await waitPoolRunning(f, 2);
  const runs = hcRuns(f);
  const name2 = runs[runs.length - 1][runs[runs.length - 1].indexOf("--name") + 1];

  assert.match(name1, /^[0-9a-f]{12}-w0$/);
  assert.match(name2, /^[0-9a-f]{12}-w0$/);
  assert.notEqual(name1, name2, "generation must change the run id");
  assert.notEqual(name1, "team-a-w0", "the old id.slice(0, 6) collision shape is gone");
  assert.ok(name1.length <= 32 && name2.length <= 32);
  const runId = name1.slice(0, 12);
  assert.ok(workerTerminalName(runId, "worker", 42).length <= 32);
  assert.notEqual(workerTerminalName(runId, "worker", 42), workerTerminalName(runId, "worker", 0));
  second.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(second), { code: 0, signal: null });
});

test("the Node preflight rejects a non-foreground process group (fake ps, no bypass)", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const fakePs = join(f.fakeBin, "ps");
  writeFileSync(fakePs, "#!/bin/sh" + NL + "echo '1 2'" + NL + "exit 0" + NL);
  chmodSync(fakePs, 0o755);
  const proc = startLauncherPty(f);
  assert.deepEqual(await closeWithin(proc, 12000), { code: 1, signal: null });
  assert.match(proc.output().all, /foreground process group/);
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
});

test("the wrapper uses a real PTY and exec keeps its PID through mise", { timeout: 25000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const testWrapper = installTestWrapper(f);
  const proc = startPtyProcess(f, testWrapper, ["--cwd", f.project]);
  await waitPoolRunning(f);

  const mind = piStarts(f)[0];
  assert.equal(mind.stdinTTY, true);
  assert.equal(mind.stdoutTTY, true);
  assert.equal(mind.ppid, Number(mind.supervisor));
  assert.equal(mind.cwd, f.project);

  const misePids = readFileSync(f.misePidFile, "utf8").trim().split(NL).filter(Boolean);
  assert.ok(misePids.length >= 2, "config read and launcher exec both run through mise");
  const rootPid = misePids[misePids.length - 1];
  assert.equal(String(mind.ppid), rootPid, "Mind is a child of the wrapper PID");
  const getCall = hcCalls(f).find((call) => call.args[0] === "get");
  assert.equal(String(getCall.ppid), rootPid, "hc get was called by the root program itself");
  assert.equal(hcRuns(f).length, 1);

  proc.child.stdin.write("exit:27" + NL);
  assert.deepEqual(await closeWithin(proc, 12000), { code: 27, signal: null });
});

// ── Lifetime lock (one pool per cwd+instance) ──

test("flock on an inherited fd holds an OFD lock after the flock child exits", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mind-lock-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = join(root, "launcher.lock");
  const tryLock = () => {
    const fd = openSync(lockPath, "a", 0o600);
    try {
      const result = spawnSync("flock", ["--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", fd] });
      return result.status;
    } finally { closeSync(fd); }
  };
  const holder = openSync(lockPath, "a", 0o600);
  assert.equal(spawnSync("flock", ["--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", holder] }).status, 0);
  assert.equal(tryLock(), 1, "a separate open file description must be refused");
  closeSync(holder);
  assert.equal(tryLock(), 0, "closing the parent fd must release the lock");

  // SIGKILL closes the holder's fd, so the lock is released without any cleanup.
  const holderScript = [
    "const { openSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "const fd = openSync(process.env.LOCK_PATH, 'a', 0o600);",
    "const r = spawnSync('flock', ['--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });",
    "process.stdout.write(String(r.status));",
    "setInterval(() => {}, 1000);",
  ].join(NL);
  const child = spawn(process.execPath, ["-e", holderScript], { env: { ...process.env, LOCK_PATH: lockPath }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const locked = await new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(String(chunk).trim())));
  assert.equal(locked, "0");
  assert.equal(tryLock(), 1);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(tryLock(), 0, "SIGKILL must release the OFD lock");
});

test("two simultaneous first launches for one cwd+instance produce exactly one pool", { timeout: 25000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, instance: "race" });
  const first = startLauncherPty(f, {}, ["--instance", "race"]);
  await waitPoolRunning(f);
  const manifestBefore = readFileSync(f.manifestFile, "utf8");

  const second = startLauncherPty(f, {}, ["--instance", "race"]);
  assert.deepEqual(await closeWithin(second, 12000), { code: 1, signal: null });
  assert.match(second.output().all, /already holds/);
  assert.equal(readFileSync(f.manifestFile, "utf8"), manifestBefore, "the losing launch must not modify the manifest");
  assert.equal(piStarts(f).length, 1);
  assert.equal(hcRuns(f).length, 1);

  first.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(first), { code: 0, signal: null });
});

test("the lock is released on normal exit, so proven-stale recovery can start", { timeout: 25000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const first = startLauncherPty(f);
  await waitPoolRunning(f);
  first.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(first), { code: 0, signal: null });

  writeFileSync(f.hcStateFile, JSON.stringify({
    terminals: {
      t1: { state: "finished", parent: null, pid: 12345 },
      t2: { state: "live", parent: null, pid: "self-ppid" },
    },
  }));
  const second = startLauncherPty(f, { HC_TERMINAL_ID: "t2" });
  await waitPoolRunning(f, 2);
  assert.equal(piStarts(f).filter((entry) => entry.generation === "2").length, 1);
  second.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(second), { code: 0, signal: null });
});

test("the lock is released by SIGKILL, so proven-stale recovery can start", { timeout: 25000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const first = startLauncherPty(f);
  await waitPoolRunning(f);
  const mind = piStarts(f)[0];
  process.kill(Number(mind.supervisor), "SIGKILL");
  await closeWithin(first, 10000).catch(() => null);

  writeFileSync(f.hcStateFile, JSON.stringify({
    terminals: {
      t1: { state: "finished", parent: null, pid: 12345 },
      t2: { state: "live", parent: null, pid: "self-ppid" },
    },
  }));
  const second = startLauncherPty(f, { HC_TERMINAL_ID: "t2" });
  await waitPoolRunning(f, 2);
  assert.equal(piStarts(f).filter((entry) => entry.generation === "2").length, 1);
  second.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(second), { code: 0, signal: null });
});

test("distinct instances in one cwd are not blocked by each other's lock", { timeout: 25000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  const envFor = (instance) => ({
    CONTROL_FILE: join(f.stateDir, instance + "-" + f.hash + "-mind-control.json"),
    SOCKET_FILE: join(f.stateDir, instance + "-" + f.hash + ".sock"),
  });
  const manifestFor = (instance) => join(f.stateDir, instance + "-" + f.hash + "-manifest.json");
  const isRunning = (instance) => {
    try { return JSON.parse(readFileSync(manifestFor(instance), "utf8")).state === "running"; } catch { return false; }
  };
  const alpha = startLauncherPty(f, envFor("alpha"), ["--instance", "alpha"]);
  await waitFor(() => piStarts(f).length === 1 && hcRuns(f).length === 1 && isRunning("alpha"));
  const beta = startLauncherPty(f, envFor("beta"), ["--instance", "beta"]);
  await waitFor(() => piStarts(f).length === 2 && hcRuns(f).length === 2 && isRunning("beta"));
  assert.equal(alpha.child.exitCode, null);
  assert.equal(beta.child.exitCode, null);
  alpha.child.stdin.write("exit:0" + NL);
  beta.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(alpha), { code: 0, signal: null });
  assert.deepEqual(await closeWithin(beta), { code: 0, signal: null });
});

test("a failing flock refuses before any hc query or Mind", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  const fakeFlock = join(f.fakeBin, "flock");
  writeFileSync(fakeFlock, "#!/bin/sh" + NL + "exit 2" + NL);
  chmodSync(fakeFlock, 0o755);
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /flock could not lock/);
  assert.deepEqual(hcCalls(f), []);
  assert.deepEqual(piStarts(f), []);
});

test("a missing flock refuses before any hc query or Mind", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  const noFlock = join(f.root, "no-flock-bin");
  mkdirSync(noFlock, { recursive: true });
  symlinkSync(process.execPath, join(noFlock, "node"));
  symlinkSync(f.hcPath, join(noFlock, "hc"));
  symlinkSync(f.misePath, join(noFlock, "mise"));
  const proc = startProcess(f, [launcher], { PATH: noFlock });
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /flock is required/);
  assert.deepEqual(hcCalls(f), []);
  assert.deepEqual(piStarts(f), []);
});

test("a signal during preflight is honored before Mind is spawned", { timeout: 25000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1, serverSleep: true });
  const proc = startLauncherPty(f);
  const serverCall = await waitFor(() => hcCalls(f).find((call) => call.args[0] === "server"), 5000);
  process.kill(Number(serverCall.ppid), "SIGTERM");
  assert.deepEqual(await closeWithin(proc, 15000), { code: 143, signal: null });
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
});


// ── Legacy archive regressions (stopped records only; live/unknown stay refused) ──

function legacyManifest(f, overrides = {}) {
  return {
    cwd: f.project,
    cwdHash: f.hash,
    generation: 5,
    workerCount: 1,
    instance: null,
    state: "stopped",
    lastUpdated: 1700000000000,
    startedAt: 1699999900000,
    mindPid: null,
    mindSupervisorPid: null,
    mindChildPid: null,
    workerPid: null,
    launcherPid: null,
    mindInPlace: true,
    launcherTokenHash: "legacy-manifest-sentinel",
    mindPaneId: "legacy-mind-pane",
    workerPaneId: null,
    mindRole: "mind",
    workerRole: "worker",
    workerTabId: null,
    mindSessionDir: "",
    workerSessionDir: join(f.sessionsDir, "worker-" + f.hash + "-0"),
    workerHerdrSession: "legacy-workers",
    workerWorkspaceId: null,
    ...overrides,
  };
}

/** Assert one legacy shape is refused before archiving or any Mind/worker spawn. */
async function assertLegacyRefused(t, label, { manifest = {}, control = {}, socket = "absent" } = {}) {
  const f = fixture(t, { workerCount: 1 });
  writeFileSync(f.manifestFile, JSON.stringify(legacyManifest(f, manifest), null, 2));
  const controlSentinel = "legacy-control-sentinel";
  if (control !== null) {
    writeFileSync(f.controlFile, JSON.stringify({
      status: "stopped", generation: 5, lastUpdated: 1234567890126, legacySentinel: controlSentinel, ...control,
    }, null, 2));
  }
  if (socket === "listen") await listenTerminalSocket(t, f.socketFile);

  const manifestBefore = readFileSync(f.manifestFile, "utf8");
  const controlBefore = control !== null ? readFileSync(f.controlFile, "utf8") : null;
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null }, label);
  assert.match(
    proc.output().stderr,
    /Refusing|unsupported|ambiguous|generation|heartbeat|socket|pid|identity|recent|fresh|booting/i,
    label + ": expected refusal, got:\n" + proc.output().all,
  );

  assert.equal(existsSync(f.manifestFile), true, label + ": manifest must stay in place");
  assert.equal(readFileSync(f.manifestFile, "utf8"), manifestBefore, label + ": manifest changed");
  if (control !== null) {
    assert.equal(existsSync(f.controlFile), true, label + ": control must stay in place");
    assert.equal(readFileSync(f.controlFile, "utf8"), controlBefore, label + ": control changed");
  }
  if (socket === "listen") {
    assert.equal(existsSync(f.socketFile), true, label + ": listening socket must stay in place");
  }
  const archivedManifest = filesContaining(f.home, "legacy-manifest-sentinel");
  assert.deepEqual(archivedManifest, [f.manifestFile], label + ": manifest archived; found " + JSON.stringify(archivedManifest));
  if (control !== null) {
    const archivedControl = filesContaining(f.home, controlSentinel);
    assert.deepEqual(archivedControl, [f.controlFile], label + ": control archived; found " + JSON.stringify(archivedControl) + " state " + JSON.stringify(readdirSync(f.stateDir)));
  }
  assert.deepEqual(piStarts(f), [], label);
  assert.deepEqual(hcRuns(f), [], label);
}

async function collectLegacyRefusals(t, cases) {
  const failures = [];
  for (const entry of cases) {
    try { await assertLegacyRefused(t, entry.label, entry); }
    catch (error) { failures.push(entry.label + ": " + String(error.message).split(NL)[0]); }
  }
  assert.deepEqual(failures, [], "must refuse without archiving:\n" + failures.join("\n"));
}

test("a stopped legacy generation 5 record in a Git cwd migrates to generation 6", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: f.project }).status, 0);
  assert.equal(existsSync(join(f.project, ".git")), true);

  const legacy = legacyManifest(f);
  const legacyControl = { status: "stopped", generation: 5, lastUpdated: 1234567890123 };
  const legacySocket = "legacy-socket-sentinel";
  writeFileSync(f.manifestFile, JSON.stringify(legacy, null, 2));
  writeFileSync(f.controlFile, JSON.stringify(legacyControl, null, 2));
  writeFileSync(f.socketFile, legacySocket);

  const sessionDir = join(f.sessionsDir, "worker-" + f.hash + "-0");
  const transcript = join(sessionDir, "transcript.jsonl");
  const history = join(f.stateDir, f.hash + "-results.jsonl");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(transcript, "session-transcript-sentinel" + NL);
  writeFileSync(history, "history-sentinel" + NL);

  const proc = startLauncherPty(f);
  await waitPoolRunning(f, 6);

  const manifest = readManifest(f);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.terminalBackend, "hc");
  assert.equal(manifest.generation, 6);
  assert.equal(manifest.state, "running");
  assert.equal(manifest.instance, null);
  assert.equal(manifest.cwd, f.project);
  assert.equal(manifest.cwdHash, f.hash);
  assert.equal(readControl(f).generation, 6);
  assert.equal(piStarts(f)[0].generation, "6");

  // Archive names are production's choice: find the moved bytes anywhere under HOME.
  const archivedManifest = filesContaining(f.home, "legacy-manifest-sentinel");
  const archivedControl = filesContaining(f.home, "1234567890123");
  const archivedSocket = filesContaining(f.home, legacySocket);
  assert.equal(archivedManifest.length, 1, "the legacy manifest must be archived exactly once");
  assert.equal(archivedControl.length, 1, "the legacy control file must be archived exactly once");
  assert.equal(archivedSocket.length, 1, "the legacy socket file must be archived exactly once");
  assert.notEqual(archivedManifest[0], f.manifestFile);
  assert.notEqual(archivedControl[0], f.controlFile);
  assert.notEqual(archivedSocket[0], f.socketFile);
  assert.equal(JSON.parse(readFileSync(archivedManifest[0], "utf8")).launcherTokenHash, "legacy-manifest-sentinel");
  assert.equal(JSON.parse(readFileSync(archivedControl[0], "utf8")).lastUpdated, 1234567890123);
  assert.equal(readFileSync(archivedSocket[0], "utf8"), legacySocket);

  // Sessions and history are not obsolete runtime metadata.
  assert.equal(readFileSync(transcript, "utf8"), "session-transcript-sentinel" + NL);
  assert.equal(readFileSync(history, "utf8"), "history-sentinel" + NL);
  assert.deepEqual(filesContaining(f.home, "session-transcript-sentinel"), [transcript]);
  assert.deepEqual(filesContaining(f.home, "history-sentinel"), [history]);

  assert.equal(piStarts(f).length, 1);
  assert.equal(hcRuns(f).length, 1);
  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("the original running legacy shape migrates to generation 6 and keeps history", { timeout: 20000 }, async (t) => {
  if (skipWithoutPty(t)) return;
  const f = fixture(t, { workerCount: 1 });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: f.project }).status, 0);
  writeFileSync(f.manifestFile, JSON.stringify(legacyManifest(f, { state: "running" }), null, 2));
  const history = join(f.stateDir, f.hash + "-results.jsonl");
  writeFileSync(history, "original-bug-history-sentinel" + NL);

  const proc = startLauncherPty(f);
  await waitPoolRunning(f, 6);
  const manifest = readManifest(f);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.generation, 6);
  assert.equal(manifest.state, "running");
  assert.equal(piStarts(f)[0].generation, "6");
  assert.ok(hcRuns(f)[0].includes("PI_MIND_WORKER_GENERATION=6"));

  const archived = filesContaining(f.home, "legacy-manifest-sentinel");
  assert.equal(archived.length, 1, "the running-but-dead legacy manifest must be archived");
  assert.notEqual(archived[0], f.manifestFile);
  assert.equal(readFileSync(history, "utf8"), "original-bug-history-sentinel" + NL);
  assert.deepEqual(filesContaining(f.home, "original-bug-history-sentinel"), [history]);

  proc.child.stdin.write("exit:0" + NL);
  assert.deepEqual(await closeWithin(proc), { code: 0, signal: null });
});

test("a legacy record with a live recorded PID is refused without archiving or takeover", { timeout: 20000 }, async (t) => {
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { sleeper.kill("SIGKILL"); } catch {} });
  const f = fixture(t, { workerCount: 1 });
  const legacy = legacyManifest(f, {
    state: "stopped",
    mindPid: sleeper.pid,
    launcherTokenHash: "live-manifest-sentinel",
  });
  const legacyControl = { status: "stopped", generation: 5, lastUpdated: 1234567890124 };
  const legacySocket = "live-socket-sentinel";
  writeFileSync(f.manifestFile, JSON.stringify(legacy, null, 2));
  writeFileSync(f.controlFile, JSON.stringify(legacyControl, null, 2));
  writeFileSync(f.socketFile, legacySocket);
  const manifestBefore = readFileSync(f.manifestFile, "utf8");
  const controlBefore = readFileSync(f.controlFile, "utf8");

  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().all, /legacy|live|ambiguous|refus/i, "a live legacy PID must fail closed");

  assert.equal(existsSync(f.manifestFile), true, "manifest must stay in place");
  assert.equal(existsSync(f.controlFile), true, "control must stay in place");
  assert.equal(existsSync(f.socketFile), true, "socket must stay in place");
  assert.equal(readFileSync(f.manifestFile, "utf8"), manifestBefore);
  assert.equal(readFileSync(f.controlFile, "utf8"), controlBefore);
  assert.equal(readFileSync(f.socketFile, "utf8"), legacySocket);
  assert.deepEqual(filesContaining(f.home, "live-manifest-sentinel"), [f.manifestFile]);
  assert.deepEqual(filesContaining(f.home, "1234567890124"), [f.controlFile]);
  assert.deepEqual(filesContaining(f.home, legacySocket), [f.socketFile]);
  assert.equal(JSON.parse(readFileSync(f.manifestFile, "utf8")).schemaVersion, undefined);
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
});

test("a legacy record with a fresh Mind heartbeat is refused without archiving", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  writeFileSync(f.manifestFile, JSON.stringify(legacyManifest(f), null, 2));
  writeFileSync(f.controlFile, JSON.stringify({
    status: "ready", generation: 5, lastUpdated: Date.now(),
  }, null, 2));
  writeFileSync(f.socketFile, "heartbeat-socket-sentinel");
  const manifestBefore = readFileSync(f.manifestFile, "utf8");
  const controlBefore = readFileSync(f.controlFile, "utf8");

  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().all, /legacy mind-worker pool/);
  assert.equal(existsSync(f.manifestFile), true, "manifest must stay in place");
  assert.equal(existsSync(f.controlFile), true, "control must stay in place");
  assert.equal(existsSync(f.socketFile), true, "socket must stay in place");
  assert.equal(readFileSync(f.manifestFile, "utf8"), manifestBefore);
  assert.equal(readFileSync(f.controlFile, "utf8"), controlBefore);
  assert.equal(readFileSync(f.socketFile, "utf8"), "heartbeat-socket-sentinel");
  assert.deepEqual(filesContaining(f.home, "legacy-manifest-sentinel"), [f.manifestFile]);
  assert.deepEqual(filesContaining(f.home, "heartbeat-socket-sentinel"), [f.socketFile]);
  assert.equal(JSON.parse(readFileSync(f.manifestFile, "utf8")).schemaVersion, undefined);
  assert.deepEqual(piStarts(f), []);
  assert.deepEqual(hcRuns(f), []);
});

test("unknown or incomplete legacy identity is refused without archiving", async (t) => {
  const cases = [
    { label: "missing cwdHash", overrides: { cwdHash: undefined } },
    { label: "mismatched cwdHash", overrides: { cwdHash: "0".repeat(16) } },
  ];
  for (const entry of cases) {
    const f = fixture(t, { workerCount: 1 });
    writeFileSync(f.manifestFile, JSON.stringify(legacyManifest(f, entry.overrides), null, 2));
    writeFileSync(f.controlFile, JSON.stringify({ status: "stopped", generation: 5, lastUpdated: 1234567890125 }, null, 2));
    writeFileSync(f.socketFile, "unknown-legacy-socket-sentinel");
    const manifestBefore = readFileSync(f.manifestFile, "utf8");
    const controlBefore = readFileSync(f.controlFile, "utf8");

    const proc = startProcess(f);
    assert.deepEqual(await closeWithin(proc), { code: 1, signal: null }, entry.label);
    assert.match(proc.output().all, /legacy|refus|unknown|incomplete|ambiguous|identity/i, entry.label);
    assert.equal(existsSync(f.manifestFile), true, entry.label + ": manifest must stay in place");
    assert.equal(readFileSync(f.manifestFile, "utf8"), manifestBefore, entry.label + ": manifest changed");
    assert.equal(readFileSync(f.controlFile, "utf8"), controlBefore, entry.label + ": control changed");
    assert.equal(readFileSync(f.socketFile, "utf8"), "unknown-legacy-socket-sentinel", entry.label + ": socket changed");
    assert.deepEqual(filesContaining(f.home, "legacy-manifest-sentinel"), [f.manifestFile], entry.label + ": manifest archived");
    assert.deepEqual(filesContaining(f.home, "1234567890125"), [f.controlFile], entry.label + ": control archived");
    assert.deepEqual(filesContaining(f.home, "unknown-legacy-socket-sentinel"), [f.socketFile], entry.label + ": socket archived");
    assert.equal(JSON.parse(readFileSync(f.manifestFile, "utf8")).schemaVersion, undefined, entry.label);
    assert.deepEqual(piStarts(f), [], entry.label);
    assert.deepEqual(hcRuns(f), [], entry.label);
  }
});



// ── Safeguards around the legacy migration ──

test("ambiguous or unsupported legacy records are refused without archiving", async (t) => {
  await collectLegacyRefusals(t, [
    { label: "listening legacy socket despite null pids and stale heartbeat", manifest: {}, control: {}, socket: "listen" },
    { label: "malformed non-null recorded pid", manifest: { mindPid: "123" }, control: {} },
    { label: "boolean heartbeat", manifest: {}, control: { lastHeartbeat: true } },
    { label: "numeric string heartbeat", manifest: {}, control: { lastHeartbeat: "1234567890127" } },
    { label: "boolean lastUpdated", manifest: {}, control: { lastUpdated: true } },
    { label: "numeric string lastUpdated", manifest: {}, control: { lastUpdated: "1234567890128" } },
    { label: "future schema", manifest: { schemaVersion: 3 }, control: {} },
    { label: "future backend", manifest: { schemaVersion: 2, terminalBackend: "future" }, control: {} },
  ]);
});

test("a recent legacy manifest without runtime files or an unusable generation is refused", async (t) => {
  const now = Date.now();
  await collectLegacyRefusals(t, [
    { label: "recent starting manifest without control or socket", manifest: { state: "starting", lastUpdated: now, startedAt: now }, control: null, socket: "absent" },
    { label: "recent running manifest without control or socket", manifest: { state: "running", lastUpdated: now, startedAt: now }, control: null, socket: "absent" },
    { label: "missing generation", manifest: { generation: undefined }, control: {} },
    { label: "unsafe generation", manifest: { generation: Number.MAX_SAFE_INTEGER }, control: {} },
  ]);
});

// ── Stale v2 recovery safety ──
// A finished/gone root record no longer proves the pool is dead: a surviving Mind
// or server must refuse the recovery, and a generation that cannot be carried
// forward must fail closed instead of recovering.

/** A full v2/hc record for the fixture, overridable per case. */
function v2Record(f, overrides = {}) {
  return {
    schemaVersion: 2,
    terminalBackend: "hc",
    coreIdentity: { id: "core-test", session: "test-session", socket: null },
    rootTerminalAddress: "t1",
    cwd: f.project,
    cwdHash: f.hash,
    generation: 3,
    launcherPid: 123456,
    mindPid: 654321,
    workerAddresses: {},
    state: "stopped",
    ...overrides,
  };
}

/** Refuse a stale-root start and prove nothing was moved, spawned or written. */
async function assertRecoveryRefused(t, label, { overrides = {}, root = "finished", record = null, socket = "absent", expect } = {}) {
  const terminals = root === "finished" ? { t1: { state: "finished", parent: null, pid: 123456 } } : {};
  const f = fixture(t, { workerCount: 1, terminalId: "t2", hcState: { terminals } });
  const manifest = record ? record(f) : v2Record(f, overrides);
  writeFileSync(f.manifestFile, JSON.stringify(manifest, null, 2));
  writeFileSync(f.controlFile, JSON.stringify({
    status: "stopped", generation: manifest.generation ?? 0, lastUpdated: 1234567890130, controlSentinel: "stale-control-sentinel",
  }, null, 2));
  if (socket === "file") writeFileSync(f.socketFile, "stale-socket-sentinel");
  if (socket === "listen") await listenTerminalSocket(t, f.socketFile);
  const manifestBefore = readFileSync(f.manifestFile, "utf8");
  const controlBefore = readFileSync(f.controlFile, "utf8");

  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null }, label);
  assert.match(proc.output().all, expect || /Refusing|unsupported|ambiguous/, label + ": expected a refusal, got:\n" + proc.output().all);
  assert.equal(readFileSync(f.manifestFile, "utf8"), manifestBefore, label + ": manifest changed");
  assert.equal(readFileSync(f.controlFile, "utf8"), controlBefore, label + ": control changed");
  if (socket === "file") assert.equal(readFileSync(f.socketFile, "utf8"), "stale-socket-sentinel", label + ": socket changed");
  if (socket === "listen") assert.equal(existsSync(f.socketFile), true, label + ": listening socket removed");
  assert.deepEqual(readdirSync(f.stateDir).filter((name) => name.includes(".legacy-")), [], label + ": runtime state archived");
  assert.deepEqual(piStarts(f), [], label + ": Mind started");
  assert.deepEqual(hcRuns(f), [], label + ": worker spawned");
  return f;
}

test("a stale v2 root with a live recorded mindPid is refused without recovery", { timeout: 20000 }, async (t) => {
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { sleeper.kill("SIGKILL"); } catch {} });
  for (const root of ["finished", "gone"]) {
    await assertRecoveryRefused(t, "live mindPid with a " + root + " root", {
      root,
      overrides: { mindPid: sleeper.pid },
      expect: /mindPid \d+ is still running/,
    });
  }
});

test("a finished v2 root with a listening socket and no mindPid is refused without recovery", { timeout: 20000 }, async (t) => {
  await assertRecoveryRefused(t, "listening socket with null mindPid", {
    overrides: { mindPid: null, launcherPid: null },
    socket: "listen",
    expect: /socket still accepts connections/,
  });
});

test("a stale v2 root with an unusable generation is refused without recovery", { timeout: 20000 }, async (t) => {
  const cases = [
    ["malformed generation", { generation: "8" }],
    ["missing generation", { generation: undefined }],
    ["unsafe generation", { generation: Number.MAX_SAFE_INTEGER }],
  ];
  for (const [label, overrides] of cases) {
    await assertRecoveryRefused(t, label, { overrides, expect: /generation .*cannot be carried forward/ });
  }
});

test("an unmarked record with no schema, backend or old-format field is refused, not archived", { timeout: 20000 }, async (t) => {
  await assertRecoveryRefused(t, "unmarked unknown record with a correct hash and old timestamp", {
    record: (f) => ({
      cwd: f.project,
      cwdHash: f.hash,
      generation: 3,
      state: "stopped",
      lastUpdated: 1700000000000,
      startedAt: 1699999900000,
      launcherPid: null,
      mindPid: null,
      mindSupervisorPid: null,
      mindChildPid: null,
      workerPid: null,
      workerSessionDir: join(f.sessionsDir, "worker-" + f.hash + "-0"),
    }),
    expect: /unsupported record/,
  });
});
