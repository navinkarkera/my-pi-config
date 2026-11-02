// tmux-launcher.test.mjs — end-to-end launcher tests for the tmux backend.
//
// Every test runs on its own private tmux server (-f /dev/null, -S <temp
// socket>), with a temp HOME/XDG tree, a fake Pi (no model, no network) and
// fake notifiers first on PATH, and the real mise toolchain pinned read-only
// (MISE_DATA_DIR/MISE_OFFLINE) so nothing is installed. No default socket, no
// real pool, no notification.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NL = String.fromCharCode(10);
const SEP = "\u001f";
const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, "..", "hc-launcher.mjs");
const wrapper = join(here, "..", "..", "..", "bin", "mind-worker-launcher");
// The worker argv goes through the installed mise toolchain (/usr/bin/mise).
// Pinning the data dir keeps a fake HOME from installing anything.
const MISE_DATA = process.env.MISE_DATA_DIR || join(homedir(), ".local", "share", "mise");
const TMUX_FMT = ["#{socket_path}", "#{pid}", "#{start_time}", "#{version}", "#{session_id}", "#{session_created}"].join(SEP);

const FAKE_PI = [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  "const readline = require('node:readline');",
  "const NL = String.fromCharCode(10);",
  "const role = process.env.PI_MIND_WORKER_ROLE || '';",
  "const log = value => fs.appendFileSync(process.env.PI_LOG, JSON.stringify(value) + NL);",
  "log({",
  "  type: 'start', role, pid: process.pid, ppid: process.ppid,",
  "  cwd: process.cwd(), args: process.argv.slice(2),",
  "  generation: process.env.PI_MIND_WORKER_GENERATION || null,",
  "  workerId: process.env.PI_MIND_WORKER_ID || null,",
  "  tier: process.env.PI_MIND_WORKER_TIER || null,",
  "  instance: process.env.PI_MIND_WORKER_INSTANCE || null,",
  "  backend: process.env.PI_MIND_WORKER_BACKEND || null,",
  "  manifest: process.env.PI_MIND_WORKER_MANIFEST || null,",
  "  sessionDir: process.env.PI_MIND_WORKER_SESSION_DIR || null,",
  "  stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY,",
  "  secret: process.env.SECRET || null,",
  "});",
  "process.stdout.write('FAKE_PI_STDOUT role=' + role + ' generation=' + process.env.PI_MIND_WORKER_GENERATION + NL);",
  "process.stderr.write('FAKE_PI_STDERR role=' + role + ' generation=' + process.env.PI_MIND_WORKER_GENERATION + NL);",
  "if (role === 'worker') { setInterval(() => {}, 1000); } else {",
  "  const finish = (code, reason) => { log({ type: 'exit', pid: process.pid, code, reason }); process.exit(code); };",
  "  if (process.env.FAKE_PI_FAIL_BEFORE_READY === '1') finish(Number(process.env.FAKE_PI_EXIT_CODE || 31), 'startup-failure');",
  "  else {",
  "    const server = net.createServer(socket => socket.end());",
  "    server.on('error', error => finish(32, 'listen-error: ' + error.message));",
  "    const serve = () => server.listen(process.env.SOCKET_FILE, () => {",
  "      const generation = Number(process.env.PI_MIND_WORKER_GENERATION);",
  "      const writeControl = (status, connected) => fs.writeFileSync(process.env.CONTROL_FILE, JSON.stringify({",
  "        status, generation, lastUpdated: Date.now(),",
  "        ...(connected === undefined ? {} : { connectedWorkers: connected }),",
  "      }));",
  "      writeControl('ready');",
  "      // Stand in for the extension: report the workers the record proves.",
  "      setInterval(() => {",
  "        let count = 0;",
  "        try { count = Object.keys(JSON.parse(fs.readFileSync(process.env.PI_MIND_WORKER_MANIFEST, 'utf8')).workerPanes || {}).length; } catch {}",
  "        if (count > 0) writeControl('worker-connected', count);",
  "      }, 50);",
  "      process.on('SIGTERM', () => finish(0, 'SIGTERM'));",
  "      readline.createInterface({ input: process.stdin }).on('line', line => {",
  "        log({ type: 'input', line });",
  "        if (line.startsWith('exit:')) finish(Number(line.slice(5)), 'stdin');",
  "      });",
  "    });",
  // A test may hold Mind before readiness (a bounded start-up signal case);
  // unset, readiness is immediate and every existing journey is unaffected.
  "    const readyDelay = Math.min(60000, Number(process.env.FAKE_PI_READY_DELAY_MS) || 0);",
  "    if (readyDelay > 0) setTimeout(serve, readyDelay); else serve();",
  "  }",
  "}",
].join(NL);

const FAKE_NOTIFIER = ["#!/bin/sh", 'printf "%s\n" "$0 $*" >> "$NOTIFY_LOG"', "exit 0"].join(NL);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(label + " not met within " + timeout + "ms");
    await sleep(40);
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").trim().split(NL).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "mind-tmux-launcher-"));
  const home = join(root, "home");
  // PI_CODING_AGENT_DIR relocates pi's agent dir. A fixture may prove the
  // launcher stores state there: absolute outside $HOME, a literal "~/" value,
  // or a path whose trailing space must survive (no trimming).
  const overrideMode = options.agentDirOverride
    ? "absolute"
    : options.agentDirSpaces
      ? "spaces"
      : options.agentDirTilde
        ? "tilde"
        : null;
  const agentDir = options.agentDir !== undefined
    ? options.agentDir
    : overrideMode === "absolute"
      ? join(root, "coding-agent")
      : overrideMode === "spaces"
        ? join(root, "agent dir ")
        : overrideMode === "tilde"
          ? join(home, options.agentDirTilde)
          : join(home, ".pi", "agent");
  const agentDirValue = overrideMode === "tilde" ? "~/" + options.agentDirTilde : overrideMode ? agentDir : undefined;
  const stateDir = join(agentDir, "mindworker");
  const sessionsDir = join(agentDir, "sessions");
  const project = join(root, "project");
  const fakeBin = join(root, "bin");
  for (const dir of [agentDir, stateDir, sessionsDir, project, fakeBin]) mkdirSync(dir, { recursive: true });

  const socket = join(root, "tmux.sock");
  const piPath = join(fakeBin, "fake-pi");
  writeFileSync(piPath, FAKE_PI);
  chmodSync(piPath, 0o755);
  for (const name of ["notify-send", "curl", "paplay"]) {
    const path = join(fakeBin, name);
    writeFileSync(path, FAKE_NOTIFIER);
    chmodSync(path, 0o755);
  }

  const workerCount = options.workerCount === undefined ? 2 : options.workerCount;
  const hash = createHash("sha256").update(realpathSync(project)).digest("hex").slice(0, 16);
  const instance = options.instance ?? null;
  const id = instance ? instance + "-" + hash : hash;
  const controlFile = join(stateDir, id + "-mind-control.json");
  const socketFile = join(stateDir, id + ".sock");
  const manifestFile = join(stateDir, id + "-manifest.json");
  const piLog = join(root, "pi.jsonl");
  const notifyLog = join(root, "notify.log");
  const paneLog = join(root, "pane.log");
  const configFile = join(agentDir, "mind-worker.json");

  writeFileSync(configFile, JSON.stringify({
    terminalBackend: options.configBackend === undefined ? "tmux" : options.configBackend,
    mindModel: "vendor/mind-model",
    workerModels: [{ model: "vendor/worker-model", count: workerCount, tier: "flash" }],
    ...(options.config ?? {}),
  }, null, 2));

  const env = {
    ...process.env,
    HOME: home,
    XDG_RUNTIME_DIR: join(root, "run"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    PATH: fakeBin + ":" + (process.env.PATH || ""),
    PI_BIN: piPath,
    PI_LOG: piLog,
    NOTIFY_LOG: notifyLog,
    CONTROL_FILE: controlFile,
    SOCKET_FILE: socketFile,
    MISE_DATA_DIR: MISE_DATA,
    MISE_OFFLINE: "1",
    SECRET: "tmux-secret-sentinel",
  };
  for (const key of [
    "TMUX", "TMUX_PANE", "HC_TERMINAL_ID", "HC_SESSION", "HC_SOCKET", "HC_TERMINAL_SOCKET",
    "PI_MIND_WORKER_ROLE", "PI_MIND_WORKER_ID", "PI_MIND_WORKER_TIER", "PI_MIND_WORKER_GENERATION",
    "PI_MIND_WORKER_SESSION_DIR", "PI_MIND_WORKER_INSTANCE", "PI_MIND_WORKER_LAUNCHER_PID",
    "PI_MIND_WORKER_BACKEND", "PI_MIND_WORKER_MANIFEST", "MISE_BIN", "PI_CODING_AGENT_DIR",
  ]) delete env[key];
  if (agentDirValue !== undefined) env.PI_CODING_AGENT_DIR = agentDirValue;

  const tmux = (args, extraEnv = null) => spawnSync("tmux", ["-S", socket, "-N", ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...env, ...(extraEnv || {}) },
  });
  // -N never starts a server, so the very first command that creates the
  // private server must not carry it.
  const tmuxStart = (args, extraEnv = null) => spawnSync("tmux", ["-f", "/dev/null", "-S", socket, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...env, ...(extraEnv || {}) },
  });

  const f = {
    root, home, agentDir, stateDir, sessionsDir, project, fakeBin, piPath, socket, env,
    hash, id, instance, controlFile, socketFile, manifestFile, piLog, notifyLog, paneLog, configFile,
    workerCount, tmux, tmuxStart, children: [],
    record: () => readJson(manifestFile),
    control: () => readJson(controlFile),
    piStarts: () => readJsonl(piLog).filter((entry) => entry.type === "start"),
    notifications: () => {
      try { return readFileSync(notifyLog, "utf8").trim(); } catch { return ""; }
    },
    windows: () => tmux(["list-windows", "-t", f.sessionId + ":", "-F", "#{window_id} #{window_index} #{window_name}"]).stdout.trim().split(NL).filter(Boolean),
    panes: () => tmux(["list-panes", "-a", "-F", "#{pane_id} #{window_id} #{pane_pid} #{pane_current_command}"]).stdout.trim().split(NL).filter(Boolean),
    paneAlive: (paneId) => f.panes().some((line) => line.startsWith(paneId + " ")),
    hooks: (event) => tmux(["show-hooks", "-g", event]).stdout.trim(),
    paneText: () => {
      try { return readFileSync(paneLog, "utf8"); } catch { return ""; }
    },
    startLauncher: (args = [], extraEnv = null) => {
      const result = f.tmuxStart([
        "new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}",
        "-s", "task", "-c", project, "--", "/bin/sleep", "600",
      ], extraEnv);
      assert.equal(result.status, 0, result.stderr);
      const [placeholder, placeholderPid] = result.stdout.trim().split(" ");
      f.sessionId = tmux(["display-message", "-p", "-t", placeholder, "-F", "#{session_id}"]).stdout.trim();
      assert.match(f.sessionId, /^\$[0-9]+$/);
      // The session tag is set before any pool program runs (no race with Alt keys).
      assert.equal(tmux(["set-option", "-t", f.sessionId, "@project_dir", realpathSync(project)]).status, 0);
      // An unrelated editor window that must never be touched.
      const editor = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", f.sessionId + ":", "-c", project, "--", "/bin/sleep", "600"]);
      assert.equal(editor.status, 0, editor.stderr);
      f.editorPane = editor.stdout.trim();
      // Capture the root pane's output even after the pane closes.
      assert.equal(tmux(["pipe-pane", "-O", "-t", placeholder, "exec cat >> " + paneLog]).status, 0);
      const respawn = tmux(["respawn-pane", "-k", "-t", placeholder, "-c", project, "--",
        process.execPath, launcher, "--backend", "tmux", "--cwd", project, ...args]);
      assert.equal(respawn.status, 0, respawn.stderr);
      f.rootPane = placeholder;
      f.placeholderPid = Number(placeholderPid);
      f.rootPid = Number(tmux(["display-message", "-p", "-t", placeholder, "-F", "#{pane_pid}"]).stdout.trim());
      assert.ok(Number.isSafeInteger(f.rootPid) && f.rootPid > 0);
      return placeholder;
    },
  };

  t.after(() => {
    try { tmux(["kill-server"]); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}

const tupleOf = (f, paneId) => {
  const [socketPath, pid, startTime, version, sessionId, created] = f.tmux([
    "display-message", "-p", "-t", paneId, "-F", TMUX_FMT,
  ]).stdout.trim().split(SEP);
  return {
    server: { socketPath, pid: Number(pid), startTime: Number(startTime), version },
    session: { id: sessionId, created: Number(created) },
  };
};

function v3Record(f, tuple, overrides = {}) {
  return {
    schemaVersion: 3,
    terminalBackend: "tmux",
    owner: f.id,
    run: "11111111-2222-3333-4444-555555555555",
    generation: 1,
    cwd: f.project,
    cwdHash: f.hash,
    id: f.id,
    instance: f.instance,
    server: tuple.server,
    session: tuple.session,
    rootPane: { paneId: "%99", panePid: 999999, startCommand: "gone" },
    workerWindow: null,
    workerPanes: {},
    hooks: {},
    state: "stopped",
    launcherPid: null,
    mindPid: null,
    workerCount: f.workerCount,
    ...overrides,
  };
}

async function waitPoolRunning(f, generation = 1) {
  await waitFor(() => {
    const record = f.record();
    return record && record.generation === generation && record.state === "running";
  }, "pool running (generation " + generation + ")");
}

async function waitPaneClosed(f, paneId, timeout = 15000) {
  await waitFor(() => !f.paneAlive(paneId), "pane " + paneId + " closed", timeout);
}

/** ESRCH-only proof, the same rule the pool guards use. */
function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

const EVENTS = ["pane-exited", "after-kill-pane", "window-unlinked"];

/** A refusal keeps the pane's output (pipe-pane) and changes no state. */
async function expectRefusal(f, pattern) {
  await waitPaneClosed(f, f.rootPane);
  const text = await waitFor(() => (/FATAL/.test(f.paneText()) ? f.paneText() : null), "launcher FATAL output");
  assert.match(text, /FATAL/);
  assert.match(text, pattern, text);
}

// ── Backend selection (flag > config > hc) ──

test("the wrapper takes --backend over the config and never rewrites the config", { timeout: 30000 }, async (t) => {
  const f = fixture(t, { workerCount: 1, configBackend: "hc" });
  const configBefore = readFileSync(f.configFile, "utf8");
  assert.equal(f.tmuxStart(["new-session", "-d", "-s", "task", "-c", f.project, "--", "/bin/sleep", "600"]).status, 0);
  const sessionId = f.tmux(["display-message", "-p", "-F", "#{session_id}"]).stdout.trim();
  f.tmux(["set-option", "-t", sessionId, "@project_dir", realpathSync(f.project)]);
  const root = f.tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", sessionId + ":", "-c", f.project, "--", "/bin/sleep", "600"]).stdout.trim();
  f.tmux(["pipe-pane", "-O", "-t", root, "exec cat >> " + f.paneLog]);
  const started = f.tmux(["respawn-pane", "-k", "-t", root, "-c", f.project, "--", "bash", wrapper, "--backend=tmux", "--cwd", f.project]);
  assert.equal(started.status, 0, started.stderr);
  f.rootPane = root;
  f.sessionId = sessionId;
  f.editorPane = null;
  const record = await waitFor(() => {
    const value = f.record();
    return value && value.state === "running" ? value : null;
  }, "tmux pool running through the wrapper");
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.terminalBackend, "tmux");
  assert.equal(readFileSync(f.configFile, "utf8"), configBefore, "the config must not be rewritten");
  assert.equal(f.tmux(["kill-server"]).status, 0);
  assert.equal(f.notifications(), "", "no notifier may run");
});

const CLEANUP_CLI = join(here, "..", "tmux-cleanup.mjs");

/** One relocated-agent-dir journey: the record, the config and the guard agree. */
async function assertRelocatedPool(f) {
  f.startLauncher();
  const record = await waitFor(() => f.record(), "v3 record under PI_CODING_AGENT_DIR");
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.terminalBackend, "tmux");
  assert.equal(record.cwd, realpathSync(f.project));
  assert.ok(f.manifestFile.startsWith(f.agentDir + "/"), f.manifestFile);
  assert.equal(existsSync(join(f.home, ".pi")), false, "nothing may be written under the default agent dir");
  assert.equal(existsSync(join(f.home, ".pi", "agent", "mindworker", f.id + "-manifest.json")), false);
  await waitPoolRunning(f, 1);

  const live = f.record();
  const locate = spawnSync(process.execPath, [
    CLEANUP_CLI, "--locate-root", realpathSync(f.project),
    "--session", live.session.id, "--socket", live.server.socketPath,
    "--server-pid", String(live.server.pid),
  ], { env: f.env, encoding: "utf8", timeout: 20000 });
  assert.equal(locate.status, 0, locate.stderr);
  const located = JSON.parse(locate.stdout);
  assert.equal(located.rootPane.paneId, live.rootPane.paneId);
  assert.equal(located.rootPane.panePid, live.rootPane.panePid);

  const check = spawnSync(process.execPath, [CLEANUP_CLI, "--check-stopped", realpathSync(f.project)], {
    env: f.env, encoding: "utf8", timeout: 20000,
  });
  assert.equal(check.status, 3, "a live pool must never be reported stopped: " + check.stderr);
  assert.match(check.stderr, /refused/);
  assert.equal(check.stdout, "");
}

test("PI_CODING_AGENT_DIR relocates the pool record and the guard proves it", { timeout: 60000 }, async (t) => {
  const f = fixture(t, { workerCount: 1, agentDirOverride: true });
  assert.notEqual(f.agentDir, join(f.home, ".pi", "agent"), "the fixture must use a relocated agent dir");
  await assertRelocatedPool(f);
});

test("a literal quoted ~/ agent dir expands for the launcher and the guard", { timeout: 60000 }, async (t) => {
  const f = fixture(t, { workerCount: 1, agentDirTilde: "tilde-agent" });
  assert.equal(f.env.PI_CODING_AGENT_DIR, "~/tilde-agent", "the fixture must pass a literal tilde, not an expanded path");
  assert.equal(f.agentDir, join(f.home, "tilde-agent"));
  await assertRelocatedPool(f);
});

test("an agent dir with spaces and a trailing space is kept verbatim", { timeout: 60000 }, async (t) => {
  const f = fixture(t, { workerCount: 1, agentDirSpaces: true });
  assert.equal(f.env.PI_CODING_AGENT_DIR, f.agentDir);
  assert.ok(f.agentDir.endsWith("agent dir "), "the trailing space is part of the override");
  await assertRelocatedPool(f);
});

test("a relative PI_CODING_AGENT_DIR is refused instead of reporting stopped", { timeout: 60000 }, async (t) => {
  const f = fixture(t, { workerCount: 1 });
  await f.startLauncher();
  const live = await waitFor(() => f.record(), "record under the default agent dir");
  await waitPoolRunning(f, 1);
  const env = { ...f.env, PI_CODING_AGENT_DIR: "relative/agent" };
  const check = spawnSync(process.execPath, [CLEANUP_CLI, "--check-stopped", realpathSync(f.project)], {
    env, encoding: "utf8", timeout: 20000,
  });
  assert.notEqual(check.status, 0, "a relative override must never be accepted as stopped");
  assert.match(check.stderr, /PI_CODING_AGENT_DIR must be an absolute path/);
  assert.equal(check.stdout, "");
  assert.doesNotMatch(check.stderr, /^stopped /m);
  const locate = spawnSync(process.execPath, [
    CLEANUP_CLI, "--locate-root", realpathSync(f.project),
    "--session", live.session.id, "--socket", live.server.socketPath,
    "--server-pid", String(live.server.pid),
  ], { env, encoding: "utf8", timeout: 20000 });
  assert.notEqual(locate.status, 0, "a relative override must never locate a live pool");
  assert.match(locate.stderr, /PI_CODING_AGENT_DIR must be an absolute path/);
});

test("a relative PI_CODING_AGENT_DIR is refused by the launcher before any state", async (t) => {
  const f = fixture(t, { workerCount: 0 });
  const out = spawnSync(process.execPath, [launcher, "--backend", "tmux", "--cwd", f.project], {
    cwd: f.project, env: { ...f.env, PI_CODING_AGENT_DIR: "relative/agent" }, encoding: "utf8", timeout: 20000,
  });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /PI_CODING_AGENT_DIR must be an absolute path/);
  assert.equal(existsSync(join(f.project, "relative")), false, "no relative directory may be created");
  assert.equal(existsSync(join(f.stateDir, f.id + "-manifest.json")), false, "no record may be written");
  assert.equal(existsSync(join(f.home, ".pi", "agent", "mindworker", "relative")), false);
});

test("the wrapper reads its config from PI_CODING_AGENT_DIR (spaces kept)", async (t) => {
  const f = fixture(t, { workerCount: 1, agentDirSpaces: true, configBackend: "__probe__" });
  const out = spawnSync("bash", [wrapper], { cwd: f.project, env: f.env, encoding: "utf8", timeout: 30000 });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /unknown terminal backend "__probe__"/);
  assert.equal(existsSync(f.manifestFile), false);
});

test("an unknown --backend is refused before tmux or any state change", async (t) => {
  const f = fixture(t, { workerCount: 1 });
  const proc = spawnSync("bash", [wrapper, "--backend=herdr"], { cwd: f.project, env: f.env, encoding: "utf8" });
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /--backend must be hc or tmux/);
  assert.equal(existsSync(f.manifestFile), false);

  const noTmux = spawnSync("bash", [wrapper, "--backend", "tmux"], { cwd: f.project, env: f.env, encoding: "utf8" });
  assert.equal(noTmux.status, 2);
  assert.match(noTmux.stderr, /TMUX is not set/);
  assert.equal(existsSync(f.manifestFile), false);

  // The explicit flag also overrides a configured backend in the other
  // direction: --backend hc never probes tmux, even with tmux configured.
  const hc = spawnSync(process.execPath, [launcher, "--backend", "hc", "--cwd", f.project], { cwd: f.project, env: f.env, encoding: "utf8" });
  assert.equal(hc.status, 1);
  assert.match(hc.stderr, /HC_SESSION \(or HC_SOCKET\) is not set/, "the hc path was taken, not tmux");
  assert.equal(existsSync(f.manifestFile), false);
});

// ── Root proof and readiness ──

test("the direct pane program is the launcher; the v3 record, hooks and workers prove readiness", { timeout: 45000 }, async (t) => {
  const f = fixture(t, { workerCount: 2 });
  const started = f.startLauncher();
  await waitPoolRunning(f);

  const record = f.record();
  const mind = f.piStarts().find((entry) => entry.role === "mind");
  assert.ok(mind, "Mind started");
  assert.equal(record.rootPane.paneId, started);
  assert.equal(record.rootPane.panePid, f.rootPid, "pane_pid is the launcher itself");
  assert.equal(record.launcherPid, f.rootPid);
  assert.equal(record.mindPid, mind.pid);
  assert.match(record.run, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(record.owner, f.id);
  assert.equal(
    record.coreIdentity.id,
    "tmux:" + record.server.socketPath + "#" + record.server.pid + "." + record.server.startTime + "/" + record.session.id,
    "Mind pins the same core id the host module derives",
  );
  assert.equal(record.generation, 1);
  assert.equal(record.state, "running");
  assert.equal(record.workerPanes && Object.keys(record.workerPanes).length, 2, "the serialized update kept the worker panes");
  assert.deepEqual(Object.keys(record.hooks).sort(), ["after-kill-pane", "pane-exited", "window-unlinked"]);
  for (const entry of Object.values(record.hooks)) {
    assert.ok(Number.isSafeInteger(entry.index));
    assert.match(entry.command, /tmux-cleanup\.mjs/);
  }
  const procs = spawnSync("ps", ["-o", "pgid=", "-o", "tpgid=", "-p", String(f.rootPid)], { encoding: "utf8" }).stdout.trim().split(/\s+/);
  assert.equal(procs[0], procs[1], "the launcher is in the pane's foreground process group");
  assert.equal(mind.stdinTTY, true);
  assert.equal(mind.stdoutTTY, true);
  assert.equal(mind.cwd, realpathSync(f.project));
  assert.equal(mind.backend, "tmux", "Mind gets the pinned backend identity");
  assert.equal(mind.manifest, f.manifestFile, "Mind gets the pinned manifest path");
  assert.equal(mind.secret, "tmux-secret-sentinel", "Mind keeps the terminal environment");

  // One Mind window and one reserved worker window with one pane per worker.
  const rootWindow = f.tmux(["display-message", "-p", "-t", started, "-F", "#{window_id}"]).stdout.trim();
  assert.equal(f.windows().length, 3, "Mind, the worker window and the editor: " + f.windows().join(", "));
  const workerWindow = f.tmux(["display-message", "-p", "-t", record.workerPanes["worker-0"].paneId, "-F", "#{window_id}"]).stdout.trim();
  assert.equal(workerWindow, record.workerWindow);
  assert.notEqual(workerWindow, rootWindow, "workers never share Mind's window");
  const workerPanes = f.tmux(["list-panes", "-t", workerWindow, "-F", "#{pane_id}"]).stdout.trim().split(NL).filter(Boolean);
  assert.deepEqual(workerPanes.sort(), [record.workerPanes["worker-0"].paneId, record.workerPanes["worker-1"].paneId].sort());
  assert.equal(f.paneAlive(f.editorPane), true, "the editor window is untouched");

  // The global hooks are installed at their recorded indexes.
  for (const [event, entry] of Object.entries(record.hooks)) {
    assert.match(f.hooks(event), new RegExp(event + "\\[" + entry.index + "\\]"));
  }
  // Workers are direct argv children with identity env only.
  const workers = f.piStarts().filter((entry) => entry.role === "worker").sort((a, b) => a.workerId.localeCompare(b.workerId));
  assert.equal(workers.length, 2);
  assert.deepEqual(workers.map((entry) => entry.workerId), ["worker-0", "worker-1"]);
  for (const entry of workers) {
    assert.equal(entry.sessionDir, join(f.sessionsDir, "worker-" + f.id + "-" + entry.workerId.slice(-1)));
    assert.equal(entry.secret, "tmux-secret-sentinel", "the worker wrapper keeps the pane environment");
  }
  assert.equal(f.control().status, "worker-connected");
  assert.equal(f.control().connectedWorkers, 2);
  assert.equal(f.notifications(), "", "no notifier may run");
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

// ── Teardown ──

test("a clean Mind exit stops the pool, removes only its hooks and keeps the editor", { timeout: 45000 }, async (t) => {
  const f = fixture(t, { workerCount: 2 });
  f.startLauncher();
  await waitPoolRunning(f);
  const before = f.record();
  const workerPanes = Object.values(before.workerPanes).map((entry) => entry.paneId);

  assert.equal(f.tmux(["send-keys", "-t", f.rootPane, "exit:0", "Enter"]).status, 0);
  await waitPaneClosed(f, f.rootPane);
  await waitFor(() => {
    const record = f.record();
    return record && record.state === "stopped" && !record.workerWindow && !Object.keys(record.workerPanes).length ? record : null;
  }, "stopped record");

  for (const paneId of workerPanes) assert.equal(f.paneAlive(paneId), false, "worker pane " + paneId + " must be gone");
  assert.equal(f.paneAlive(f.editorPane), true, "the editor pane is never killed");
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.equal(f.hooks(event).includes(f.manifestFile), false, event + " must not keep this pool's entry");
  }
  assert.equal(f.control().status, "stopped");
  assert.equal(f.notifications(), "", "no notifier may run");
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

test("SIGKILL of the root lets the owned global hook sweep the pool and its entries", { timeout: 45000 }, async (t) => {
  const f = fixture(t, { workerCount: 2 });
  f.startLauncher();
  await waitPoolRunning(f);
  const before = f.record();
  const workerPanes = Object.values(before.workerPanes).map((entry) => entry.paneId);

  process.kill(before.launcherPid, "SIGKILL");
  await waitFor(() => !f.paneAlive(f.rootPane), "root pane gone");
  await waitFor(() => {
    const record = f.record();
    return record && record.state === "stopped" && !record.workerWindow && !Object.keys(record.workerPanes).length ? record : null;
  }, "hook sweep marked the pool stopped", 20000);

  for (const paneId of workerPanes) assert.equal(f.paneAlive(paneId), false, "worker pane " + paneId + " must be swept");
  assert.equal(f.paneAlive(f.editorPane), true, "the editor pane survives a SIGKILL");
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.equal(f.hooks(event).includes(f.manifestFile), false, event + " must not keep this pool's entry");
  }
  assert.equal(f.notifications(), "", "no notifier may run");
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

// ── Strict v3 startup ──

test("a stopped v3 record hands over the next generation in the same server", { timeout: 60000 }, async (t) => {
  const f = fixture(t, { workerCount: 1 });
  f.startLauncher();
  await waitPoolRunning(f);
  assert.equal(f.record().generation, 1);
  f.tmux(["send-keys", "-t", f.rootPane, "exit:0", "Enter"]);
  await waitPaneClosed(f, f.rootPane);
  await waitFor(() => f.record()?.state === "stopped", "generation 1 stopped");

  // A new root pane in the surviving session must carry the generation.
  const root = f.tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", f.sessionId + ":", "-c", f.project, "--",
    process.execPath, launcher, "--backend", "tmux", "--cwd", f.project]).stdout.trim();
  f.rootPane = root;
  assert.match(root, /^%[0-9]+$/);
  await waitPoolRunning(f, 2);
  assert.equal(f.record().generation, 2);
  assert.equal(f.piStarts().filter((entry) => entry.role === "mind").map((entry) => entry.generation).sort().join(","), "1,2");
  assert.equal(f.record().state, "running");
  assert.equal(f.record().hooks && Object.keys(f.record().hooks).length, 3, "generation 2 re-installed owned hooks");
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

test("v2/hc, legacy and another pool's records are refused untouched", { timeout: 45000 }, async (t) => {
  const cases = [
    ["a v2/hc record", (f, tuple) => v2HcRecord(f), /unsupported record/],
    ["a v3 record for another owner", (f, tuple) => v3Record(f, tuple, { owner: "other-pool" }), /owner "other-pool" is not the pool id/],
    ["a v3 record for another cwd", (f, tuple) => v3Record(f, tuple, { cwdHash: "0".repeat(16) }), /does not belong to/],
    ["a v3 record with a live mind pid", (f, tuple) => v3Record(f, tuple, { mindPid: process.pid }), /mindPid \d+ is still running/],
    // The ids in a v3 record only mean anything on their own server and session.
    ["a v3 record for another server", (f, tuple) => v3Record(f, tuple, { server: { ...tuple.server, pid: tuple.server.pid + 1 } }), /tmux server tuple does not match/],
    ["a v3 record for another session", (f, tuple) => v3Record(f, tuple, { session: { ...tuple.session, id: "$99" } }), /is not the live session/],
  ];
  for (const [label, build, pattern] of cases) {
    const f = fixture(t, { workerCount: 1 });
    f.startLauncher();
    // The placeholder pane is still the root program: write the record under the live tuple.
    f.rootPid = Number(f.tmux(["display-message", "-p", "-t", f.rootPane, "-F", "#{pane_pid}"]).stdout.trim());
    const windowsBefore = f.tmux(["list-windows", "-a", "-F", "#{window_id}"]).stdout.trim().split(NL).filter(Boolean).sort();
    const tuple = tupleOf(f, f.rootPane);
    const record = build(f, tuple);
    writeFileSync(f.manifestFile, JSON.stringify(record, null, 2));
    const before = readFileSync(f.manifestFile, "utf8");
    // Now start the real launcher in that pane.
    f.tmux(["respawn-pane", "-k", "-t", f.rootPane, "-c", f.project, "--",
      process.execPath, launcher, "--backend", "tmux", "--cwd", f.project]);
    await expectRefusal(f, pattern);
    assert.equal(readFileSync(f.manifestFile, "utf8"), before, label + ": the record must stay untouched");
    assert.equal(f.piStarts().length, 0, label + ": Mind must not start");
    const windowsAfter = f.tmux(["list-windows", "-a", "-F", "#{window_id}"]).stdout.trim().split(NL).filter(Boolean);
    assert.deepEqual(
      windowsAfter.filter((windowId) => !windowsBefore.includes(windowId)),
      [],
      label + ": no worker window may appear",
    );
    assert.equal(f.hooks("pane-exited").includes(f.manifestFile), false, label + ": no hook may be installed");
    assert.equal(f.tmux(["kill-server"]).status, 0);
  }
});

function v2HcRecord(f) {
  return {
    schemaVersion: 2, terminalBackend: "hc",
    coreIdentity: { id: "core-old", session: "s" }, rootTerminalAddress: "t1",
    cwd: f.project, cwdHash: f.hash, generation: 4, launcherPid: 123456, mindPid: 654321,
    state: "stopped",
  };
}

test("a missing manifest with surviving runtime state fails closed without cleanup", { timeout: 30000 }, async (t) => {
  const f = fixture(t, { workerCount: 1 });
  f.startLauncher();
  writeFileSync(f.controlFile, JSON.stringify({ status: "worker-connected", generation: 2 }));
  writeFileSync(f.socketFile, "stale socket");
  const before = readFileSync(f.controlFile, "utf8");
  f.tmux(["respawn-pane", "-k", "-t", f.rootPane, "-c", f.project, "--",
    process.execPath, launcher, "--backend", "tmux", "--cwd", f.project]);
  await expectRefusal(f, /without a v3 manifest/);
  assert.equal(existsSync(f.manifestFile), false, "no fresh record may be written");
  assert.equal(readFileSync(f.controlFile, "utf8"), before, "runtime state must not be cleaned up");
  assert.equal(f.piStarts().length, 0);
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

// ── Root program refusal ──

test("a plain non-exec root is refused before any record, worker or hook", { timeout: 30000 }, async (t) => {
  const f = fixture(t, { workerCount: 1 });
  assert.equal(f.tmuxStart(["new-session", "-d", "-s", "task", "-c", f.project, "--", "/bin/sleep", "600"]).status, 0);
  const root = f.tmux(["display-message", "-p", "-F", "#{pane_id}"]).stdout.trim();
  const sessionId = f.tmux(["display-message", "-p", "-F", "#{session_id}"]).stdout.trim();
  f.tmux(["set-option", "-t", sessionId, "@project_dir", realpathSync(f.project)]);
  f.tmux(["pipe-pane", "-O", "-t", root, "exec cat >> " + f.paneLog]);
  // A shell runs the launcher, so pane_pid stays the shell and is not the launcher.
  const started = f.tmux(["respawn-pane", "-k", "-t", root, "-c", f.project, "--", "/bin/sh", "-c",
    "'" + process.execPath + "' '" + launcher + "' --backend tmux --cwd '" + f.project + "'; printf 'LAUNCHER_EXIT=%s\n' \"$?\"; /bin/sleep 600"]);
  assert.equal(started.status, 0, started.stderr);
  f.rootPane = root;
  f.sessionId = sessionId;
  const text = await waitFor(() => (/LAUNCHER_EXIT=/.test(f.paneText()) ? f.paneText() : null), "launcher refusal");
  assert.match(text, /not the direct root program/);
  assert.match(text, /pane_pid/);
  assert.notEqual(text.match(/LAUNCHER_EXIT=(\d+)/)[1], "0");
  assert.equal(existsSync(f.manifestFile), false, "no record may be written before the root is proven");
  assert.equal(f.piStarts().length, 0);
  assert.equal(f.hooks("pane-exited").includes(f.manifestFile), false, "no hook may be installed");
  assert.equal(f.tmux(["list-windows", "-a", "-F", "#{window_id}"]).stdout.trim().split(NL).filter(Boolean).length, 1,
    "the shell pane is the only window: no worker window was created");
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

test("a failing Mind start stops the pool and leaves no worker or hook", { timeout: 45000 }, async (t) => {
  const f = fixture(t, { workerCount: 1 });
  const started = f.startLauncher([], { FAKE_PI_FAIL_BEFORE_READY: "1", FAKE_PI_EXIT_CODE: "31" });
  f.rootPane = started;
  await waitPaneClosed(f, started);
  assert.match(f.paneText(), /Starting Mind in this terminal/);
  assert.match(
    readFileSync(join(f.stateDir, f.id + "-mind-gen1.log"), "utf8"),
    /FAKE_PI_STDERR role=mind/,
    "Mind's stderr goes to its own log, not the editor",
  );
  assert.doesNotMatch(f.paneText(), /FAKE_PI_STDERR/, "the launcher terminal stays clean");
  const record = await waitFor(() => {
    const value = f.record();
    return value && value.state === "stopped" ? value : null;
  }, "stopped record after Mind failure");
  assert.deepEqual(record.workerPanes, {});
  assert.deepEqual(record.hooks, {}, "owned hooks must be removed after a failed start");
  assert.equal(f.hooks("pane-exited").includes(f.manifestFile), false);
  assert.equal(f.piStarts().filter((entry) => entry.role === "worker").length, 0, "no worker may start");
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

// ── Signal teardown and an unconfirmed sweep ──

test("SIGTERM while the pool runs stops Mind in bounds, sweeps its workers and hooks, and keeps the editor", { timeout: 60000 }, async (t) => {
  const f = fixture(t, { workerCount: 2 });
  f.startLauncher();
  await waitPoolRunning(f);
  const before = f.record();
  const workerPanes = Object.values(before.workerPanes).map((entry) => entry.paneId);
  // Keep the root pane after the launcher exits so its exit status is readable.
  const rootWindow = f.tmux(["display-message", "-p", "-t", f.rootPane, "-F", "#{window_id}"]).stdout.trim();
  assert.equal(f.tmux(["set-option", "-w", "-t", rootWindow, "remain-on-exit", "on"]).status, 0);

  process.kill(before.launcherPid, "SIGTERM");
  await waitFor(() => {
    const record = f.record();
    return record && record.state === "stopped" && !record.workerWindow && !Object.keys(record.workerPanes).length ? record : null;
  }, "the SIGTERM sweep proved the pool stopped", 30000);

  const dead = await waitFor(() => {
    const out = f.tmux(["display-message", "-p", "-t", f.rootPane, "-F", "#{pane_dead} #{pane_dead_status}"]).stdout.trim();
    return /^1 [0-9]+$/.test(out) ? out.split(" ") : null;
  }, "the launcher pane ended with an exit status", 15000);
  assert.equal(dead[1], "143", "SIGTERM exits 128+15, never 0");
  for (const paneId of workerPanes) assert.equal(f.paneAlive(paneId), false, "worker pane " + paneId + " must be swept");
  assert.equal(f.paneAlive(f.editorPane), true, "the editor pane is never killed");
  for (const event of EVENTS) {
    assert.equal(f.hooks(event).includes(f.manifestFile), false, event + " must not keep this pool's entry");
  }
  assert.equal(f.control().status, "stopped");
  assert.equal(readJsonl(f.piLog).find((entry) => entry.type === "exit")?.reason, "SIGTERM", "Mind was terminated, not left running");
  await waitFor(() => !isAlive(before.mindPid), "Mind " + before.mindPid + " is gone", 15000);
  assert.equal(f.notifications(), "", "no notifier may run");
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

test("SIGTERM before Mind is ready starts no worker, leaves no orphan and never claims a false stop", { timeout: 60000 }, async (t) => {
  const f = fixture(t, { workerCount: 2 });
  const started = f.startLauncher([], { FAKE_PI_READY_DELAY_MS: "30000" });
  f.rootPane = started;
  const pending = await waitFor(() => {
    const record = f.record();
    const mind = f.piStarts().find((entry) => entry.role === "mind");
    return record && record.state === "starting" && Number.isSafeInteger(record.mindPid) && mind ? { record, mind } : null;
  }, "a starting record with Mind spawned but not ready");
  assert.equal(f.control().status, "", "Mind has not reported readiness");
  assert.equal(f.piStarts().filter((entry) => entry.role === "worker").length, 0, "no static worker was spawned");

  process.kill(pending.record.launcherPid, "SIGTERM");
  await waitPaneClosed(f, f.rootPane);
  const settled = await waitFor(() => {
    const record = f.record();
    const control = f.control();
    if (!record || !control) return null;
    if (record.state === "stopped") return { record, control, outcome: "stopped" };
    if (control.status === "cleanup-unconfirmed") return { record, control, outcome: "unconfirmed" };
    return null;
  }, "the startup SIGTERM settled", 30000);

  assert.equal(f.piStarts().filter((entry) => entry.role === "worker").length, 0, "no static worker may start");
  assert.deepEqual(settled.record.workerPanes, {}, "no worker pane is recorded");
  assert.equal(settled.record.workerWindow, null, "no worker window exists");
  assert.equal(f.paneAlive(f.editorPane), true, "the editor pane is untouched");
  assert.equal(f.windows().length, 1, "only the editor window is left");
  assert.equal(f.notifications(), "", "no notifier may run");
  await waitFor(() => !isAlive(pending.mind.pid), "Mind " + pending.mind.pid + " is gone", 15000);
  if (settled.outcome === "stopped") {
    assert.equal(settled.control.status, "stopped");
    assert.deepEqual(settled.record.hooks, {}, "the owned hooks are removed");
    for (const event of EVENTS) {
      assert.equal(f.hooks(event).includes(f.manifestFile), false, event + " must not keep this pool's entry");
    }
    for (const pid of [settled.record.launcherPid, settled.record.mindPid, settled.record.rootPane.panePid]) {
      if (Number.isSafeInteger(pid)) {
        assert.equal(isAlive(pid), false, "recorded pid " + pid + " is gone, so the stop is not false");
      }
    }
  } else {
    assert.notEqual(settled.record.state, "stopped", "an unconfirmed sweep must never claim stopped");
    assert.equal(Object.keys(settled.record.hooks).length, 3, "an unconfirmed sweep keeps its hooks");
  }
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

test("an unconfirmed sweep kills no foreign-marked pane, keeps the record and hooks, and the guard refuses", { timeout: 90000 }, async (t) => {
  const f = fixture(t, { workerCount: 2 });
  f.startLauncher();
  await waitPoolRunning(f);
  const before = f.record();
  const tampered = before.workerPanes["worker-1"];
  const owned = before.workerPanes["worker-0"];
  // This pane no longer proves the pool, so it must never become a kill target.
  assert.equal(f.tmux(["set-option", "-p", "-t", tampered.paneId, "@mind.owner", "foreign-pool"]).status, 0);
  assert.equal(f.tmux(["display-message", "-p", "-t", tampered.paneId, "-F", "#{@mind.owner}"]).stdout.trim(), "foreign-pool");

  assert.equal(f.tmux(["send-keys", "-t", f.rootPane, "exit:0", "Enter"]).status, 0);
  await waitPaneClosed(f, f.rootPane);
  const record = await waitFor(() => {
    const value = f.record();
    return value && f.control()?.status === "cleanup-unconfirmed" ? value : null;
  }, "the sweep reported itself unconfirmed", 30000);
  await waitFor(() => (/WARNING: pool cleanup was not confirmed/.test(f.paneText()) ? true : null), "the unconfirmed warning", 10000);

  assert.notEqual(record.state, "stopped", "an unconfirmed sweep must never claim stopped");
  assert.deepEqual(record.hooks, before.hooks, "the owned hooks are retained for the retry");
  assert.deepEqual(Object.keys(record.workerPanes), ["worker-1"], "only the proven-gone entry is pruned");
  assert.equal(record.workerPanes["worker-1"].paneId, tampered.paneId);
  assert.equal(record.workerWindow, before.workerWindow, "the worker window claim is kept, not dropped");
  assert.equal(f.paneAlive(tampered.paneId), true, "a pane whose markers changed is never killed");
  assert.equal(f.tmux(["display-message", "-p", "-t", tampered.paneId, "-F", "#{@mind.owner}"]).stdout.trim(), "foreign-pool", "the foreign marker is left untouched");
  assert.equal(f.paneAlive(owned.paneId), false, "the owned pane is swept");
  assert.equal(f.paneAlive(f.editorPane), true, "the editor pane is never killed");
  for (const event of EVENTS) {
    assert.match(f.hooks(event), new RegExp(event + "\\[" + before.hooks[event].index + "\\]"), event + " stays installed");
  }
  assert.match(f.paneText(), /markers-changed/);

  // The read-only guard behind the filesystem-removal path must refuse.
  const cleanupCli = join(here, "..", "tmux-cleanup.mjs");
  const guard = spawnSync(process.execPath, [cleanupCli, "--check-stopped", f.project], { env: f.env, encoding: "utf8" });
  assert.equal(guard.status, 3, guard.stderr);
  assert.match(guard.stderr, /workerPanes\.worker-1\.panePid is alive/);
  assert.equal(guard.stdout, "", "the guard writes only diagnostics");
  assert.equal(f.notifications(), "", "no notifier may run");
  assert.equal(f.tmux(["kill-server"]).status, 0);
});

