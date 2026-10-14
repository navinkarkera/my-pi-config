import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const launcher = new URL("../herdr-launcher.mjs", import.meta.url).pathname;
const wrapper = new URL("../../../bin/mind-worker-launcher", import.meta.url).pathname;
if (!existsSync("/proc/self/stat") || !existsSync("/proc/self/cmdline")) {
  throw new Error("herdr-launcher tests require Linux /proc for safe fake-process identity tracking");
}

const fakeHerdr = [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "const args = process.argv.slice(2);",
  "const session = args[0] === '--session' ? args[1] : null;",
  "const offset = session ? 2 : 0;",
  "const op = args.slice(offset);",
  "const log = { session, args };",
  "fs.appendFileSync(process.env.HERDR_LOG, JSON.stringify(log) + '\\n');",
  "const print = value => process.stdout.write(JSON.stringify(value) + '\\n');",
  "const tabState = () => { try { const state = JSON.parse(fs.readFileSync(process.env.TAB_STATE_FILE, 'utf8')); if (!Array.isArray(state.workspaces)) state.workspaces = []; return state; } catch { return { created: 0, closed: 0, workspaces: [] }; } };",
  "if (op[0] === 'pane' && op[1] === 'list') print({ focused: true, pane_id: 'not-a-target' });",
  "else if (op[0] === 'workspace' && op[1] === 'create') {",
  "  if (process.env.FAIL_STORE_AFTER_WORKSPACE === '1') fs.mkdirSync(process.env.MANIFEST_FILE + '.tmp');",
  "  const state = tabState(); if (!state.workspaces.includes('worker-workspace')) state.workspaces.push('worker-workspace'); fs.writeFileSync(process.env.TAB_STATE_FILE, JSON.stringify(state));",
  "  print({ result: { workspace: { workspace_id: 'worker-workspace' } } });",
  "} else if (op[0] === 'workspace' && op[1] === 'close' && process.env.FAIL_STORE_AFTER_WORKSPACE === '1') {",
  "  fs.rmSync(process.env.MANIFEST_FILE + '.tmp', { recursive: true, force: true });",
  "  const state = tabState(); state.closed++; state.workspaces = state.workspaces.filter(id => id !== op[2]); fs.writeFileSync(process.env.TAB_STATE_FILE, JSON.stringify(state));",
  "}",
  "else if (op[0] === 'tab' && op[1] === 'create') { const state = tabState(); state.created++; fs.writeFileSync(process.env.TAB_STATE_FILE, JSON.stringify(state)); print({ result: { tab: { tab_id: 'worker-tab' }, root_pane: { pane_id: 'worker-pane-0' } } }); }",
  "else if ((op[0] === 'tab' && op[1] === 'close' || op[0] === 'workspace' && op[1] === 'close') && process.env.FAIL_CLOSE === '1') { process.stderr.write('fake close failure'); process.exit(8); }",
  "else if ((op[0] === 'tab' && op[1] === 'close' || op[0] === 'workspace' && op[1] === 'close') && process.env.BUMP_GENERATION_ON_CLOSE === '1' && !fs.existsSync(process.env.BUMP_MARKER)) {",
  "  fs.writeFileSync(process.env.BUMP_MARKER, '1');",
  "  if (op[0] === 'workspace') { const state = tabState(); state.closed++; state.workspaces = state.workspaces.filter(id => id !== op[2]); fs.writeFileSync(process.env.TAB_STATE_FILE, JSON.stringify(state)); }",
  "  setTimeout(() => { const p = process.env.MANIFEST_FILE; const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.generation++; fs.writeFileSync(p, JSON.stringify(m)); }, 250);",
  "} else if (op[0] === 'workspace' && op[1] === 'close') { const state = tabState(); if (!state.workspaces.includes(op[2])) { process.stderr.write('fake workspace not found'); process.exit(9); } state.closed++; state.workspaces = state.workspaces.filter(id => id !== op[2]); fs.writeFileSync(process.env.TAB_STATE_FILE, JSON.stringify(state)); }",
  "else if (op[0] === 'pane' && op[1] === 'split') print({ result: { pane: { pane_id: 'worker-pane-extra' } } });",
  "else if (op[0] === 'pane' && op[1] === 'run') {",
  "  if (process.env.FAIL_WORKER === '1') { process.stderr.write('fake worker failure'); process.exit(7); }",
  "  const match = /PI_MIND_WORKER_GENERATION=(\\d+)/.exec(op[3] || '');",
  "  const gen = match ? Number(match[1]) : 0;",
  "  const countPath = process.env.CONTROL_FILE + '.workers-' + gen;",
  "  let count = 0; try { count = Number(fs.readFileSync(countPath, 'utf8')); } catch {}",
  "  count++; fs.writeFileSync(countPath, String(count));",
  "  fs.writeFileSync(process.env.CONTROL_FILE, JSON.stringify({ status: 'worker-connected', generation: gen, connectedWorkers: count, lastUpdated: Date.now() }));",
  "} else if (op[0] === 'workspace' && op[1] === 'list') print({ workspaces: tabState().workspaces.map(workspace_id => ({ workspace_id })) });",
].join("\n");

const fakePi = [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  "const readline = require('node:readline');",
  "const processIdentity = pid => { try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/); const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(String.fromCharCode(0)).filter(Boolean); return { state: fields[0], startTime: fields[19], cmdline }; } catch { return null; } };",
  "const ownIdentity = processIdentity(process.pid);",
  "const supervisorIdentity = processIdentity(Number(process.env.PI_MIND_WORKER_LAUNCHER_PID));",
  "let priorGenerationAlive = false;",
  "try { const prior = fs.readFileSync(process.env.PI_LOG, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line)); priorGenerationAlive = prior.some(entry => entry.type === 'start' && Number(entry.generation) < Number(process.env.PI_MIND_WORKER_GENERATION) && (() => { const p = processIdentity(entry.pid); return p && p.state !== 'Z' && p.startTime === String(entry.startTime) && p.cmdline.includes(entry.executable); })()); } catch {}",
  "const record = {",
  "  type: 'start', pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), executable: process.argv[1], startTime: ownIdentity?.startTime, cmdline: ownIdentity?.cmdline,",
  "  stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY, priorGenerationAlive,",
  "  role: process.env.PI_MIND_WORKER_ROLE, generation: process.env.PI_MIND_WORKER_GENERATION,",
  "  supervisor: process.env.PI_MIND_WORKER_LAUNCHER_PID, supervisorStartTime: supervisorIdentity?.startTime, supervisorCmdline: supervisorIdentity?.cmdline, token: process.env.PI_MIND_WORKER_LAUNCHER_TOKEN,",
  "};",
  "const log = value => fs.appendFileSync(process.env.PI_LOG, JSON.stringify(value) + '\\n');",
  "log(record);",
  "process.stdout.write('FAKE_PI_STDOUT generation=' + record.generation + '\\n');",
  "let server = null, finishing = false;",
  "function finish(code, reason) {",
  "  if (finishing) return; finishing = true; log({ type: 'exit', pid: process.pid, generation: record.generation, code, reason });",
  "  try { fs.unlinkSync(process.env.SOCKET_FILE); } catch {}",
  "  process.exit(code);",
  "}",
  "if (process.env.FAKE_PI_IGNORE_TERM === '1') process.on('SIGTERM', () => log({ type: 'signal', pid: process.pid, generation: record.generation, signal: 'SIGTERM' }));",
  "else process.on('SIGTERM', () => finish(0, 'SIGTERM'));",
  "if (process.env.FAKE_PI_FAIL_BEFORE_READY === '1') finish(Number(process.env.FAKE_PI_EXIT_CODE || 31), 'startup-failure');",
  "else {",
  "  try { fs.unlinkSync(process.env.SOCKET_FILE); } catch {}",
  "  server = net.createServer(socket => socket.end());",
  "  server.listen(process.env.SOCKET_FILE, () => {",
  "    fs.writeFileSync(process.env.CONTROL_FILE, JSON.stringify({ status: 'ready', generation: Number(record.generation), lastUpdated: Date.now() }));",
  "    const input = readline.createInterface({ input: process.stdin });",
  "    input.on('line', line => { log({ type: 'input', generation: record.generation, line }); if (line.startsWith('exit:')) finish(Number(line.slice(5)), 'stdin'); });",
  "  });",
  "}",
].join("\n");

function readJsonl(path) {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return { state: fields[0], startTime: fields[19], cmdline };
  } catch { return null; }
}

function isRecordedProcessAlive(record) {
  const current = processIdentity(record.pid);
  return !!current && current.state !== "Z" && current.startTime === String(record.startTime) &&
    JSON.stringify(current.cmdline) === JSON.stringify(record.cmdline);
}

function signalRecordedProcess(record, signal) {
  if (!isRecordedProcessAlive(record)) return;
  try { process.kill(record.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

function closeWithin(entry, timeoutMs = 8000) {
  let timer;
  return Promise.race([
    entry.closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`child ${entry.child.pid} did not close within ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return check();
}

function fixture(t, { workerCount = 2, failWorker = false, failPi = false, ignorePiTerm = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mind-worker-launcher-test-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const stateDir = join(agentDir, "mindworker");
  const project = join(root, "project");
  const fakeBin = join(root, "bin");
  for (const dir of [agentDir, stateDir, join(agentDir, "sessions"), project, fakeBin]) mkdirSync(dir, { recursive: true });

  const herdrPath = join(fakeBin, "herdr");
  const piPath = join(fakeBin, "fake-pi");
  const herdrLog = join(root, "herdr.jsonl");
  const piLog = join(root, "pi.jsonl");
  const cwd = project;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const controlFile = join(stateDir, hash + "-mind-control.json");
  const socketFile = join(stateDir, hash + ".sock");
  writeFileSync(herdrPath, fakeHerdr);
  writeFileSync(piPath, fakePi);
  chmodSync(herdrPath, 0o755);
  chmodSync(piPath, 0o755);
  writeFileSync(join(agentDir, "mind-worker.json"), JSON.stringify({
    terminalBackend: "herdr",
    mindModel: "vendor/mind-model",
    workerModels: [{ model: "vendor/worker-model", count: workerCount, tier: "flash" }],
  }));

  const env = {
    ...process.env,
    HOME: home,
    PATH: fakeBin + ":" + dirname(process.execPath) + ":" + (process.env.PATH || ""),
    PI_BIN: piPath,
    HERDR_ENV: "1",
    HERDR_PANE_ID: "caller-pane",
    HERDR_LOG: herdrLog,
    PI_LOG: piLog,
    CONTROL_FILE: controlFile,
    SOCKET_FILE: socketFile,
    MANIFEST_FILE: join(stateDir, hash + "-manifest.json"),
    BUMP_MARKER: join(root, "generation-bumped"),
    TAB_STATE_FILE: join(root, "tabs.json"),
    BUMP_GENERATION_ON_CLOSE: "0",
    FAIL_CLOSE: "0",
    FAIL_STORE_AFTER_WORKSPACE: "0",
    WORKER_COUNT: String(workerCount),
    FAIL_WORKER: failWorker ? "1" : "0",
    FAKE_PI_FAIL_BEFORE_READY: failPi ? "1" : "0",
    FAKE_PI_IGNORE_TERM: ignorePiTerm ? "1" : "0",
  };
  for (const key of ["MIND_WORKER_LAUNCHER_BACKGROUND", "MIND_WORKER_HERDR_BACKGROUND",
    "PI_MIND_WORKER_LAUNCHER_PID", "PI_MIND_WORKER_LAUNCHER_TOKEN", "PI_MIND_WORKER_GENERATION"]) delete env[key];

  const children = [];
  t.after(async () => {
    for (const entry of children) if (entry.child.exitCode === null) entry.child.kill("SIGTERM");
    await Promise.all(children.map(async entry => {
      try { await closeWithin(entry, 7500); }
      catch {
        if (entry.child.exitCode === null) entry.child.kill("SIGKILL");
        try { await closeWithin(entry, 1000); } catch { /* checked below */ }
      }
    }));
    const identities = [...new Map(readJsonl(piLog).filter(entry => entry.type === "start").flatMap(entry => [
      { pid: entry.pid, startTime: entry.startTime, cmdline: entry.cmdline },
      { pid: entry.supervisor, startTime: entry.supervisorStartTime, cmdline: entry.supervisorCmdline },
    ]).filter(identity => identity.pid && identity.startTime && identity.cmdline)
      .map(identity => [`${identity.pid}:${identity.startTime}`, identity])).values()];
    const active = () => identities.filter(isRecordedProcessAlive);
    for (const identity of active()) signalRecordedProcess(identity, "SIGTERM");
    // A TERM timeout must continue to the identity-checked SIGKILL pass.
    await waitUntil(() => active().length === 0, 1000);
    for (const identity of active()) signalRecordedProcess(identity, "SIGKILL");
    assert.equal(await waitUntil(() => active().length === 0, 1500), true, "fake processes must stop before fixture removal");
    assert.deepEqual(active().map(identity => identity.pid), [], "temporary fake processes must stop before fixture removal");
    assert.ok(children.every(entry => entry.child.exitCode !== null), "test child processes must be reaped before fixture removal");
    rmSync(root, { recursive: true, force: true });
  });

  return { root, home, agentDir, stateDir, project, fakeBin, piPath, cwd, hash, controlFile, socketFile, herdrLog, piLog, env, children };
}

function installTestWrapper(f) {
  const copy = join(f.agentDir, "bin", "mind-worker-launcher");
  const launcherCopy = join(f.agentDir, "lib", "mind-worker", "herdr-launcher.mjs");
  mkdirSync(dirname(copy), { recursive: true });
  mkdirSync(dirname(launcherCopy), { recursive: true });
  copyFileSync(wrapper, copy);
  copyFileSync(launcher, launcherCopy);
  chmodSync(copy, 0o755);
  const mise = join(f.fakeBin, "mise");
  writeFileSync(mise, '#!/bin/sh\nshift 3\n[ "$1" = node ] && shift\nexec ' + JSON.stringify(process.execPath) + ' "$@"\n');
  chmodSync(mise, 0o755);
  return copy;
}

function startProcess(f, command = process.execPath, args = [launcher], extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: f.project,
    env: { ...f.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const entry = { child, closed, output: () => ({ stdout, stderr }) };
  f.children.push(entry);
  return entry;
}

function findScript() {
  const result = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function startPtyProcess(f, scriptPath, command, args = [], extraEnv = {}) {
  const child = spawn(scriptPath, ["-q", "-e", "/dev/null", "--", command, ...args], {
    cwd: f.project,
    env: { ...f.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const entry = { child, closed, output: () => ({ stdout, stderr }) };
  f.children.push(entry);
  return entry;
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for launcher test condition");
}

function herdrEvents(f) {
  return readJsonl(f.herdrLog);
}

function assertNoPrimaryPaneMutation(f) {
  const mutations = herdrEvents(f).filter(event => {
    if (event.session) return false;
    const op = event.args;
    return op[0] === "pane" && ["split", "run", "close"].includes(op[1]);
  });
  assert.deepEqual(mutations, [], "caller pane must not be split, run, or closed");
}

function assertWorkerOpsUseSeparateSession(f) {
  const mutations = herdrEvents(f).filter(event => {
    const args = event.args;
    const offset = event.session ? 2 : 0;
    const op = args.slice(offset);
    return (op[0] === "pane" && ["split", "run", "close"].includes(op[1])) ||
      (op[0] === "tab" && op[1] === "close") ||
      (op[0] === "workspace" && op[1] === "close");
  });
  assert.ok(mutations.length > 0, "worker panes should be managed");
  assert.ok(mutations.every(event => event.session === "pi-workers"), "worker panes stay in pi-workers");
}

test("foreground Mind inherits stdio/cwd/env/model; workers stay in pi-workers", async t => {
  const f = fixture(t, { workerCount: 2 });
  const dashboardLog = join(f.stateDir, f.hash + "-results.jsonl");
  writeFileSync(dashboardLog, "keep dashboard history\n");
  const proc = startProcess(f);
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.status === "worker-connected" && status.connectedWorkers === 2;
  });

  const start = readJsonl(f.piLog).find(entry => entry.type === "start");
  assert.equal(start.cwd, f.cwd);
  assert.equal(start.role, "mind");
  assert.equal(start.generation, "1");
  assert.equal(start.supervisor, String(proc.child.pid));
  assert.match(start.token, /^[a-f0-9]{32}$/);
  assert.deepEqual(start.args, ["--model", "vendor/mind-model"]);
  const manifest = JSON.parse(readFileSync(join(f.stateDir, f.hash + "-manifest.json"), "utf8"));
  assert.equal(manifest.mindSessionDir, "");
  assert.equal(manifest.mindInPlace, true);
  assert.equal(manifest.mindPaneId, "caller-pane");
  assertNoPrimaryPaneMutation(f);
  assertWorkerOpsUseSeparateSession(f);
  assert.match(proc.output().stdout, /FAKE_PI_STDOUT generation=1/);

  proc.child.stdin.write("exit:23\n");
  assert.deepEqual(await closeWithin(proc), { code: 23, signal: null });
  assert.ok(readJsonl(f.piLog).some(entry => entry.type === "input" && entry.line === "exit:23"));
  assert.equal(JSON.parse(readFileSync(join(f.stateDir, f.hash + "-manifest.json"), "utf8")).state, "stopped");
  assert.equal(readFileSync(dashboardLog, "utf8"), "keep dashboard history\n");
  assert.ok(existsSync(join(f.agentDir, "sessions", "worker-" + f.hash + "-0")));
});

test("Mind startup failure propagates its exit status without closing the caller pane", async t => {
  const f = fixture(t, { workerCount: 1, failPi: true });
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 31, signal: null });
  assertNoPrimaryPaneMutation(f);
  assert.equal(readJsonl(f.herdrLog).filter(event => event.args.includes("run")).length, 0);
  assert.equal(JSON.parse(readFileSync(join(f.stateDir, f.hash + "-mind-control.json"), "utf8")).status, "stopped");
});

test("worker startup failure terminates Mind and cleans only worker resources", async t => {
  const f = fixture(t, { workerCount: 1, failWorker: true });
  const proc = startProcess(f);
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assertNoPrimaryPaneMutation(f);
  assertWorkerOpsUseSeparateSession(f);
  const ops = herdrEvents(f).map(event => event.args.slice(event.session ? 2 : 0));
  assert.ok(ops.some(op => op[0] === "workspace" && op[1] === "close"));
  assert.ok(readJsonl(f.piLog).some(event => event.type === "exit" && event.reason === "SIGTERM"));
  assert.equal(JSON.parse(readFileSync(join(f.stateDir, f.hash + "-manifest.json"), "utf8")).state, "stopped");
});

test("in-memory ownership closes a worker workspace when manifest persistence fails", async t => {
  const f = fixture(t, { workerCount: 1 });
  const proc = startProcess(f, process.execPath, [launcher], { FAIL_STORE_AFTER_WORKSPACE: "1" });
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  const ops = herdrEvents(f).map(event => event.args.slice(event.session ? 2 : 0));
  assert.ok(ops.some(op => op[0] === "workspace" && op[1] === "create"));
  assert.ok(ops.some(op => op[0] === "workspace" && op[1] === "close"));
  assert.ok(!ops.some(op => op[0] === "tab" && op[1] === "create"));
  assert.equal(JSON.parse(readFileSync(f.env.MANIFEST_FILE, "utf8")).state, "stopped");
  assertNoPrimaryPaneMutation(f);
});

test("stale live generation 1 auto-resets into generation 2 without touching the caller pane", async t => {
  const f = fixture(t, { workerCount: 2 });
  const deadPid = 2147483647;
  writeFileSync(f.env.MANIFEST_FILE, JSON.stringify({
    cwd: f.cwd, cwdHash: f.hash, generation: 1, workerCount: 2,
    state: "running", mindInPlace: true, mindPaneId: "caller-pane",
    launcherPid: deadPid, mindSupervisorPid: deadPid, mindPid: deadPid,
    workerPid: null, workerTabId: null, workerWorkspaceId: null, workerHerdrSession: null,
  }));
  writeFileSync(f.controlFile, JSON.stringify({ status: "ready", generation: 1, lastUpdated: Date.now() }));

  const proc = startProcess(f);
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.generation === 2 && status.status === "worker-connected" && status.connectedWorkers === 2;
  });
  const start = readJsonl(f.piLog).find(entry => entry.type === "start");
  assert.equal(start.generation, "2");
  assert.equal(start.cwd, f.cwd);
  assert.equal(start.role, "mind");
  assert.doesNotMatch(proc.output().stderr, /findFocusedPane/);
  assertNoPrimaryPaneMutation(f);
  assertWorkerOpsUseSeparateSession(f);

  proc.child.stdin.write("exit:29\n");
  assert.deepEqual(await closeWithin(proc), { code: 29, signal: null });
});

test("authenticated /mind-reset request restarts Mind in the same pane and rejects stale generations", async t => {
  const f = fixture(t, { workerCount: 1 });
  const testWrapper = installTestWrapper(f);
  const proc = startProcess(f);
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.status === "worker-connected" && status.generation === 1;
  });
  const first = readJsonl(f.piLog).find(entry => entry.type === "start");
  const stale = startProcess(f, process.execPath, [launcher, "--reset", "--cwd", f.cwd], {
    PI_MIND_WORKER_LAUNCHER_PID: first.supervisor,
    PI_MIND_WORKER_LAUNCHER_TOKEN: first.token,
    PI_MIND_WORKER_GENERATION: "99",
  });
  assert.deepEqual(await closeWithin(stale), { code: 1, signal: null });
  assert.equal(readJsonl(f.piLog).filter(entry => entry.type === "start").length, 1);
  assert.equal(existsSync(join(f.stateDir, f.hash + "-reset-request.json")), false);

  const stalePid = startProcess(f, process.execPath, [launcher, "--reset", "--cwd", f.cwd], {
    PI_MIND_WORKER_LAUNCHER_PID: "2147483647",
    PI_MIND_WORKER_LAUNCHER_TOKEN: first.token,
    PI_MIND_WORKER_GENERATION: first.generation,
  });
  assert.deepEqual(await closeWithin(stalePid), { code: 1, signal: null });
  assert.equal(readJsonl(f.piLog).filter(entry => entry.type === "start").length, 1);
  assert.equal(existsSync(join(f.stateDir, f.hash + "-reset-request.json")), false);

  const wrongToken = startProcess(f, process.execPath, [launcher, "--reset", "--cwd", f.cwd], {
    PI_MIND_WORKER_LAUNCHER_PID: first.supervisor,
    PI_MIND_WORKER_LAUNCHER_TOKEN: "0".repeat(32),
    PI_MIND_WORKER_GENERATION: first.generation,
  });
  assert.deepEqual(await closeWithin(wrongToken), { code: 1, signal: null });
  assert.equal(readJsonl(f.piLog).filter(entry => entry.type === "start").length, 1);
  assert.equal(existsSync(join(f.stateDir, f.hash + "-reset-request.json")), false);

  const request = startProcess(f, "bash", [testWrapper, "--background", "--reset", "--cwd", f.cwd], {
    MIND_WORKER_LAUNCHER_BACKGROUND: "1",
    PI_MIND_WORKER_LAUNCHER_PID: first.supervisor,
    PI_MIND_WORKER_LAUNCHER_TOKEN: first.token,
    PI_MIND_WORKER_GENERATION: first.generation,
  });
  assert.deepEqual(await closeWithin(request), { code: 0, signal: null });
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const starts = readJsonl(f.piLog).filter(entry => entry.type === "start");
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return starts.length === 2 && status.generation === 2 && status.status === "worker-connected";
  });

  assertNoPrimaryPaneMutation(f);
  assertWorkerOpsUseSeparateSession(f);
  proc.child.stdin.write("exit:17\n");
  assert.deepEqual(await closeWithin(proc), { code: 17, signal: null });
});

test("reset cleanup refuses to delete artifacts after the manifest generation changes", async t => {
  const f = fixture(t, { workerCount: 1 });
  const testWrapper = installTestWrapper(f);
  const proc = startProcess(f, process.execPath, [launcher], {
    BUMP_GENERATION_ON_CLOSE: "1",
  });
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.status === "worker-connected";
  });
  const first = readJsonl(f.piLog).find(entry => entry.type === "start");
  const request = startProcess(f, "bash", [testWrapper, "--background", "--reset", "--cwd", f.cwd], {
    MIND_WORKER_LAUNCHER_BACKGROUND: "1",
    PI_MIND_WORKER_LAUNCHER_PID: first.supervisor,
    PI_MIND_WORKER_LAUNCHER_TOKEN: first.token,
    PI_MIND_WORKER_GENERATION: first.generation,
  });
  assert.deepEqual(await closeWithin(request), { code: 0, signal: null });
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /Reset cleanup refused/);
  assert.ok(existsSync(f.env.MANIFEST_FILE));
  assert.equal(JSON.parse(readFileSync(f.env.MANIFEST_FILE, "utf8")).generation, 2);
  assert.ok(existsSync(join(f.agentDir, "sessions", "worker-" + f.hash + "-0")));
  assert.equal(readJsonl(f.piLog).filter(entry => entry.type === "start").length, 1);

  const retry = startProcess(f);
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.generation === 3 && status.status === "worker-connected";
  });
  assert.equal(JSON.parse(readFileSync(f.env.MANIFEST_FILE, "utf8")).generation, 3);
  assert.equal(readJsonl(f.piLog).filter(entry => entry.type === "start").length, 2);
  assert.deepEqual(JSON.parse(readFileSync(f.env.TAB_STATE_FILE, "utf8")), { created: 2, closed: 1, workspaces: ["worker-workspace"] });
  retry.child.stdin.write("exit:19\n");
  assert.deepEqual(await closeWithin(retry), { code: 19, signal: null });
  assertNoPrimaryPaneMutation(f);
});

test("reset cleanup preserves ownership on close failure and retries successfully", async t => {
  const f = fixture(t, { workerCount: 1 });
  const testWrapper = installTestWrapper(f);
  const proc = startProcess(f, process.execPath, [launcher], { FAIL_CLOSE: "1" });
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.status === "worker-connected";
  });
  const first = readJsonl(f.piLog).find(entry => entry.type === "start");
  const request = startProcess(f, "bash", [testWrapper, "--background", "--reset", "--cwd", f.cwd], {
    MIND_WORKER_LAUNCHER_BACKGROUND: "1",
    PI_MIND_WORKER_LAUNCHER_PID: first.supervisor,
    PI_MIND_WORKER_LAUNCHER_TOKEN: first.token,
    PI_MIND_WORKER_GENERATION: first.generation,
  });
  assert.deepEqual(await closeWithin(request), { code: 0, signal: null });
  assert.deepEqual(await closeWithin(proc), { code: 1, signal: null });
  assert.match(proc.output().stderr, /pane closure failed/);
  assert.ok(existsSync(f.env.MANIFEST_FILE));
  const retained = JSON.parse(readFileSync(f.env.MANIFEST_FILE, "utf8"));
  assert.equal(retained.generation, 1);
  assert.equal(retained.workerWorkspaceId, "worker-workspace");
  assert.deepEqual(JSON.parse(readFileSync(f.env.TAB_STATE_FILE, "utf8")), { created: 1, closed: 0, workspaces: ["worker-workspace"] });
  assert.ok(existsSync(join(f.agentDir, "sessions", "worker-" + f.hash + "-0")));
  assert.equal(readJsonl(f.piLog).filter(entry => entry.type === "start").length, 1);

  const retry = startProcess(f);
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.generation === 2 && status.status === "worker-connected";
  });
  assert.equal(JSON.parse(readFileSync(f.env.MANIFEST_FILE, "utf8")).generation, 2);
  assert.equal(readJsonl(f.piLog).filter(entry => entry.type === "start").length, 2);
  assert.deepEqual(JSON.parse(readFileSync(f.env.TAB_STATE_FILE, "utf8")), { created: 2, closed: 1, workspaces: ["worker-workspace"] });
  retry.child.stdin.write("exit:17\n");
  assert.deepEqual(await closeWithin(retry), { code: 17, signal: null });
  assertNoPrimaryPaneMutation(f);
  assertWorkerOpsUseSeparateSession(f);
});

test("foreground shell wrapper uses a real PTY and keeps launcher progress out of the Pi UI", { timeout: 15000 }, async t => {
  const scriptPath = findScript();
  if (!scriptPath) return t.skip("util-linux script is unavailable; no PTY runner installed");
  const f = fixture(t, { workerCount: 2 });
  const testWrapper = installTestWrapper(f);
  const proc = startPtyProcess(f, scriptPath, testWrapper);
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.status === "worker-connected" && status.connectedWorkers === 2;
  });
  const start = readJsonl(f.piLog).find(entry => entry.type === "start");
  assert.equal(start.stdinTTY, true);
  assert.equal(start.stdoutTTY, true);
  assert.equal(start.cwd, f.cwd);
  assert.equal(start.role, "mind");
  assert.equal(start.generation, "1");
  assert.deepEqual(start.args, ["--model", "vendor/mind-model"]);
  assertNoPrimaryPaneMutation(f);
  assertWorkerOpsUseSeparateSession(f);
  proc.child.stdin.write("exit:27\n");
  assert.deepEqual(await closeWithin(proc, 5000), { code: 27, signal: null });
  const terminal = proc.output().stdout + proc.output().stderr;
  assert.doesNotMatch(terminal, /Mind is ready\.|Spawning \d+ worker panes\.|Worker session:|Worker tab:|workers connected\./);
});

test("/mind-reset waits for a TERM-ignoring Mind before generation 2 starts", { timeout: 16000 }, async t => {
  const f = fixture(t, { workerCount: 1, ignorePiTerm: true });
  const testWrapper = installTestWrapper(f);
  const proc = startProcess(f);
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.status === "worker-connected" && status.generation === 1;
  });
  const first = readJsonl(f.piLog).find(entry => entry.type === "start");
  const requestAt = Date.now();
  const request = startProcess(f, "bash", [testWrapper, "--background", "--reset", "--cwd", f.cwd], {
    MIND_WORKER_LAUNCHER_BACKGROUND: "1",
    PI_MIND_WORKER_LAUNCHER_PID: first.supervisor,
    PI_MIND_WORKER_LAUNCHER_TOKEN: first.token,
    PI_MIND_WORKER_GENERATION: first.generation,
  });
  assert.deepEqual(await closeWithin(request, 2000), { code: 0, signal: null });
  await waitFor(() => readJsonl(f.piLog).some(entry => entry.type === "signal" && entry.generation === "1" && entry.signal === "SIGTERM"), 3000);
  await waitFor(() => {
    if (!existsSync(f.controlFile)) return false;
    const status = JSON.parse(readFileSync(f.controlFile, "utf8"));
    return status.status === "worker-connected" && status.generation === 2;
  }, 12000);
  const starts = readJsonl(f.piLog).filter(entry => entry.type === "start");
  const second = starts.find(entry => entry.generation === "2");
  assert.ok(second);
  assert.equal(second.priorGenerationAlive, false, "generation 2 must not start before generation 1 exits");
  assert.equal(isRecordedProcessAlive({ pid: first.pid, startTime: first.startTime, cmdline: first.cmdline }), false);
  const elapsed = Date.now() - requestAt;
  assert.ok(elapsed >= 4000 && elapsed < 12000, `TERM grace/escalation took ${elapsed}ms (expected 4-12s)`);
  assertNoPrimaryPaneMutation(f);
  assertWorkerOpsUseSeparateSession(f);

  proc.child.stdin.write("exit:37\n");
  assert.deepEqual(await closeWithin(proc, 4000), { code: 37, signal: null });
});

test("startup failure escalates after a TERM-ignoring Mind without touching the caller pane", { timeout: 14000 }, async t => {
  const f = fixture(t, { workerCount: 1, failWorker: true, ignorePiTerm: true });
  const proc = startProcess(f);
  const first = await waitFor(() => readJsonl(f.piLog).find(entry => entry.type === "start"), 3000);
  await waitFor(() => readJsonl(f.piLog).some(entry => entry.type === "signal" && entry.generation === "1" && entry.signal === "SIGTERM"), 3000);
  const termAt = Date.now();
  const result = await closeWithin(proc, 9500);
  const elapsed = Date.now() - termAt;
  assert.deepEqual(result, { code: 1, signal: null });
  assert.ok(elapsed >= 3500 && elapsed < 9500, `startup termination took ${elapsed}ms (expected bounded ~5s grace)`);
  assert.equal(readJsonl(f.piLog).filter(entry => entry.type === "start").length, 1);
  assert.equal(isRecordedProcessAlive({ pid: first.pid, startTime: first.startTime, cmdline: first.cmdline }), false);
  assert.equal(JSON.parse(readFileSync(f.env.MANIFEST_FILE, "utf8")).state, "stopped");
  assertNoPrimaryPaneMutation(f);
  assertWorkerOpsUseSeparateSession(f);
});

test("background start is rejected before launching a detached Mind", t => {
  const f = fixture(t, { workerCount: 1 });
  const result = spawnSync("bash", [wrapper, "--background"], {
    cwd: f.project,
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires its foreground terminal/);
  assert.match(result.stderr, /without --background/);

  const envBackground = spawnSync("bash", [wrapper], {
    cwd: f.project,
    env: { ...f.env, MIND_WORKER_LAUNCHER_BACKGROUND: "1" },
    encoding: "utf8",
  });
  assert.equal(envBackground.status, 2);
  assert.match(envBackground.stderr, /requires its foreground terminal/);

  const detached = spawnSync("bash", [wrapper], {
    cwd: f.project,
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(detached.status, 2);
  assert.match(detached.stderr, /must be started interactively/);

  const outsideHerdr = { ...f.env };
  delete outsideHerdr.HERDR_ENV;
  const outside = spawnSync("bash", [wrapper], {
    cwd: f.project,
    env: outsideHerdr,
    encoding: "utf8",
  });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /from a Herdr pane/);
  assert.deepEqual(readJsonl(f.herdrLog), []);
});
