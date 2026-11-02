// tmux-terminal.test.mjs - private-server tests for the tmux host seam.
//
// Every test uses its own temp HOME/XDG dirs, its own socket and tmux -f
// /dev/null. No default socket, no real pool, no model, no network and no
// notifier is touched. Panes run a fake root/worker script only.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  probeTmuxRoot,
  probeTmuxSource,
  spawnWorkerTerminal,
  getTerminal,
  retireWorkerTerminal,
  listOwnedTerminals,
  capturePane,
  installOwnedHooks,
} from "../tmux-terminal.mjs";

const NODE = process.execPath;
const MODULE = fileURLToPath(new URL("../tmux-terminal.mjs", import.meta.url));
const SEP = "\u001f";
const ROOT_SCRIPT = "setInterval(() => {}, 1000);\n";
const WORKER_SCRIPT = [
  'import { writeFileSync } from "node:fs";',
  "writeFileSync(process.argv[2], JSON.stringify({",
  "  pid: process.pid,",
  "  script: process.argv[1],",
  "  args: process.argv.slice(2),",
  "  cwd: process.cwd(),",
  "  identity: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith(\"PI_MIND_WORKER_\"))),",
  "}));",
  'process.stdout.write("worker-ready\\n");',
  "setInterval(() => {}, 1000);",
  "",
].join("\n");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const paneAlive = (fx, paneId) =>
  fx.tmux(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.trim().split("\n").includes(paneId);

async function waitFor(fn, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(label + " not met within " + timeout + "ms");
    await sleep(25);
  }
}

function readRecord(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeRecord(path, record) {
  writeFileSync(path, JSON.stringify(record, null, 2));
}

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tmux-terminal-"));
  const socket = join(dir, "sock");
  const env = {
    ...process.env,
    HOME: dir,
    XDG_RUNTIME_DIR: join(dir, "run"),
    XDG_STATE_HOME: join(dir, "state"),
  };
  delete env.TMUX;
  delete env.TMUX_PANE;

  const tmux = (args, extraEnv = null) =>
    spawnSync("tmux", ["-S", socket, "-N", ...args], {
      encoding: "utf8",
      timeout: 10000,
      env: extraEnv ? { ...env, ...extraEnv } : env,
    });

  writeFileSync(join(dir, "root.mjs"), ROOT_SCRIPT);
  writeFileSync(join(dir, "worker.mjs"), WORKER_SCRIPT);

  const start = spawnSync(
    "tmux",
    ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}",
      "-s", "task", "-c", dir, "--", NODE, join(dir, "root.mjs")],
    { encoding: "utf8", timeout: 10000, env },
  );
  assert.equal(start.status, 0, start.stderr);
  const [rootPane, rootPidText] = start.stdout.trim().split(" ");
  const rootPid = Number(rootPidText);
  assert.match(rootPane, /^%[0-9]+$/);

  // Keep the session (and server) alive independently of the root program.
  const editor = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "$0:", "-c", dir, "--", "/bin/sleep", "300"]);
  assert.equal(editor.status, 0, editor.stderr);
  const editorPane = editor.stdout.trim();

  const sessionId = tmux(["display-message", "-p", "-t", rootPane, "-F", "#{session_id}"]).stdout.trim();
  assert.match(sessionId, /^\$[0-9]+$/);

  const tupleText = tmux([
    "display-message", "-p", "-t", rootPane, "-F",
    ["#{socket_path}", "#{pid}", "#{start_time}", "#{version}", "#{session_id}", "#{session_created}"].join(SEP),
  ]).stdout.trim();
  const tuple = tupleText.split(SEP);

  const clientEnv = { TMUX: [tuple[0], tuple[1], tuple[2]].join(","), TMUX_PANE: rootPane };
  const probe = probeTmuxRoot({ clientEnv, expectedPid: rootPid });
  const manifestPath = join(dir, "pool-manifest.json");
  const record = {
    schemaVersion: 3,
    terminalBackend: "tmux",
    owner: "owner",
    run: "run1",
    generation: 1,
    cwd: dir,
    server: probe.server,
    session: probe.session,
    rootPane: probe.rootPane,
    workerWindow: null,
    workerPanes: {},
    hooks: {},
  };
  writeRecord(manifestPath, record);

  const fx = {
    dir,
    socket,
    env,
    tmux,
    rootPane,
    rootPid,
    editorPane,
    sessionId,
    tuple,
    clientEnv,
    probe,
    manifestPath,
    coreId: probe.coreIdentity.id,
    record: () => readRecord(manifestPath),
    workerPath: join(dir, "worker.mjs"),
    spawn: (workerId, readyPath, identity = { PI_MIND_WORKER_ID: workerId, PI_MIND_WORKER_ROLE: "worker" }) =>
      spawnWorkerTerminal({
        manifestPath,
        workerId,
        rootAddress: rootPane,
        name: workerId,
        cwd: dir,
        argv: [NODE, join(dir, "worker.mjs"), readyPath],
        env: identity,
        expectedCoreId: probe.coreIdentity.id,
      }),
  };
  t.after(() => {
    try { tmux(["kill-server"]); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return fx;
}

test("probeTmuxRoot proves the live server/session/root tuple without a shell", async (t) => {
  const fx = await fixture(t);
  assert.equal(fx.probe.server.pid, Number(fx.tuple[1]));
  assert.equal(fx.probe.server.startTime, Number(fx.tuple[2]));
  assert.equal(fx.probe.server.socketPath, fx.socket);
  assert.equal(fx.probe.session.id, fx.sessionId);
  assert.equal(fx.probe.rootPane.paneId, fx.rootPane);
  assert.equal(fx.probe.rootPane.panePid, fx.rootPid);
  assert.match(fx.probe.rootPane.startCommand, /root\.mjs/);
  assert.equal(fx.probe.coreIdentity.id, "tmux:" + fx.socket + "#" + fx.tuple[1] + "." + fx.tuple[2] + "/" + fx.sessionId);

  // A non-exec root (this test process is not the pane program) is refused.
  await assert.rejects(
    async () => probeTmuxRoot({ clientEnv: fx.clientEnv, expectedPid: process.pid }),
    (error) => error.kind === "root_pid_mismatch",
  );

  // No TMUX at all is refused rather than selecting a default server.
  await assert.rejects(
    async () => probeTmuxRoot({ clientEnv: {}, expectedPid: fx.rootPid }),
    (error) => error.kind === "root_not_tmux",
  );
});

test("a stale/missing socket is refused and -N never starts a server", async (t) => {
  const fx = await fixture(t);
  const absent = join(fx.dir, "absent.sock");
  await assert.rejects(
    async () => probeTmuxRoot({ clientEnv: { TMUX: absent + ",123,0", TMUX_PANE: "%99" }, expectedPid: process.pid }),
    (error) => error.kind === "root_not_live",
  );
  assert.equal(existsSync(absent), false, "tmux -N must not start a server on a stale socket");
});

test("three concurrent spawns share one worker window and exec argv directly", async (t) => {
  const fx = await fixture(t);
  const activeBefore = fx.tmux(["list-windows", "-t", fx.sessionId + ":", "-F", "#{window_id} #{window_active}"])
    .stdout.trim().split("\n").find((line) => line.endsWith(" 1"))?.split(" ")[0];
  assert.match(activeBefore, /^@[0-9]+$/);

  const ready = [0, 1, 2].map((i) => join(fx.dir, "ready-" + i + ".json"));
  const results = await Promise.all(ready.map((path, i) => fx.spawn("worker-" + i, path)));
  assert.equal(results.length, 3);
  assert.equal(new Set(results.map((r) => r.address)).size, 3);

  const record = fx.record();
  assert.match(record.workerWindow, /^@[0-9]+$/);
  const windows = fx.tmux(["list-windows", "-t", fx.sessionId + ":", "-F", "#{window_id}"]).stdout.trim().split("\n");
  assert.equal(windows.filter((id) => id === record.workerWindow).length, 1);
  assert.equal(windows.length, 3, "one Mind window, one worker window, one editor window");

  const panes = fx.tmux(["list-panes", "-t", record.workerWindow, "-F", "#{pane_id}"]).stdout.trim().split("\n");
  assert.equal(panes.length, 3);

  // Focus is never stolen: the active window is still the pre-spawn one.
  const activeAfter = fx.tmux(["list-windows", "-t", fx.sessionId + ":", "-F", "#{window_id} #{window_active}"])
    .stdout.trim().split("\n").find((line) => line.endsWith(" 1"))?.split(" ")[0];
  assert.equal(activeAfter, activeBefore);

  for (let i = 0; i < 3; i++) {
    await waitFor(() => existsSync(ready[i]), "worker " + i + " ready", 5000);
    const info = JSON.parse(readFileSync(ready[i], "utf8"));
    const entry = record.workerPanes["worker-" + i];
    assert.equal(info.pid, entry.panePid, "execve preserves the pane pid");
    assert.equal(info.script, fx.workerPath);
    assert.equal(info.cwd, fx.dir);
    assert.equal(info.identity.PI_MIND_WORKER_ID, "worker-" + i);
    assert.match(entry.startCommand, /--worker-exec/);
    assert.doesNotMatch(entry.startCommand, /(^|\s)(sh|bash)(\s+-c)?\s/, "no shell wrapping");
    assert.doesNotMatch(entry.startCommand, /send-keys/);
  }
});

test("getTerminal and capturePane report only the owned pane", async (t) => {
  const fx = await fixture(t);
  const ready = join(fx.dir, "ready-0.json");
  const { address } = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");

  const terminal = await getTerminal(address, {
    manifestPath: fx.manifestPath,
    expectedCoreId: fx.coreId,
    rootAddress: fx.rootPane,
  });
  assert.equal(terminal.address, address);
  assert.equal(terminal.name, "worker-0");
  assert.equal(terminal.state, "live");
  assert.equal(terminal.parent, fx.rootPane);
  assert.equal(terminal.pid, fx.record().workerPanes["worker-0"].panePid);

  const captured = await capturePane(address, {
    manifestPath: fx.manifestPath,
    expectedCoreId: fx.coreId,
    rootAddress: fx.rootPane,
    lines: 50,
  });
  assert.match(captured, /worker-ready/);

  await assert.rejects(
    async () => getTerminal(address, { manifestPath: fx.manifestPath, expectedCoreId: "tmux:other" }),
    (error) => error.kind === "stale_tuple",
  );
  await assert.rejects(
    async () => getTerminal(address, {
      manifestPath: fx.manifestPath, expectedCoreId: fx.coreId, clientEnv: { TMUX: join(fx.dir, "other.sock") + ",1,0" },
    }),
    (error) => error.kind === "stale_tuple",
  );
  await assert.rejects(
    async () => getTerminal(address, { manifestPath: fx.manifestPath, expectedCoreId: fx.coreId, rootAddress: "%999" }),
    (error) => error.kind === "not_owned",
  );
});

test("retire kills only the owned pane and drops its record", async (t) => {
  const fx = await fixture(t);
  const third = fx.tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "$0:", "-c", fx.dir, "--", "/bin/sleep", "300"]).stdout.trim();
  assert.match(third, /^%[0-9]+$/);

  const readyA = join(fx.dir, "ready-a.json");
  const readyB = join(fx.dir, "ready-b.json");
  const a = await fx.spawn("worker-a", readyA);
  const b = await fx.spawn("worker-b", readyB);
  await waitFor(() => existsSync(readyA) && existsSync(readyB), "workers ready");

  // An unmarked pane in the same worker window is never a retire target.
  const workerWindow = fx.record().workerWindow;
  const manual = fx.tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", workerWindow, "-c", fx.dir, "--", "/bin/sleep", "300"]).stdout.trim();
  await assert.rejects(
    async () => retireWorkerTerminal(manual, { manifestPath: fx.manifestPath, expectedCoreId: fx.coreId, rootAddress: fx.rootPane }),
    (error) => error.kind === "not_owned",
  );
  assert.equal(paneAlive(fx, manual), true, "manual pane must be alive");

  await retireWorkerTerminal(a.address, { manifestPath: fx.manifestPath, expectedCoreId: fx.coreId, rootAddress: fx.rootPane });
  assert.equal(await getTerminal(a.address, { manifestPath: fx.manifestPath, expectedCoreId: fx.coreId }), null);
  assert.equal(fx.record().workerPanes["worker-a"], undefined);
  assert.equal(paneAlive(fx, manual), true, "manual pane survives");
  assert.equal(paneAlive(fx, b.address), true, "other worker survives");
  assert.equal(paneAlive(fx, fx.editorPane), true, "editor survives");

  assert.deepEqual((await listOwnedTerminals({
    manifestPath: fx.manifestPath, expectedCoreId: fx.coreId, rootAddress: fx.rootPane,
  })).map((entry) => entry.address).sort(), [b.address].sort());
});

test("probeTmuxSource requires the exact session and captured server", async (t) => {
  const fx = await fixture(t);
  const live = probeTmuxSource({ socketPath: fx.socket, serverPid: Number(fx.tuple[1]), sessionId: fx.sessionId });
  assert.equal(live.state, "live");
  assert.equal(live.server.pid, Number(fx.tuple[1]));
  assert.equal(live.server.startTime, Number(fx.tuple[2]));
  assert.equal(live.session.id, fx.sessionId);
  assert.deepEqual(probeTmuxSource({ socketPath: fx.socket, serverPid: Number(fx.tuple[1]), sessionId: "$99" }), { state: "gone" });
  assert.throws(
    () => probeTmuxSource({ socketPath: fx.socket, serverPid: Number(fx.tuple[1]) + 1, sessionId: fx.sessionId }),
    (error) => error.kind === "stale_tuple",
  );
});

test("probeTmuxRoot validates the canonical @project_dir only when expectedCwd is given", async (t) => {
  const fx = await fixture(t);
  fx.tmux(["set-option", "-t", fx.sessionId + ":", "@project_dir", fx.dir]);
  const matched = probeTmuxRoot({ clientEnv: fx.clientEnv, expectedPid: fx.rootPid, expectedCwd: fx.dir });
  assert.equal(matched.session.id, fx.sessionId);
  await assert.rejects(
    async () => probeTmuxRoot({ clientEnv: fx.clientEnv, expectedPid: fx.rootPid, expectedCwd: join(fx.dir, "other") }),
    (error) => error.kind === "root_project_mismatch",
  );
  fx.tmux(["set-option", "-u", "-t", fx.sessionId + ":", "@project_dir"]);
  await assert.rejects(
    async () => probeTmuxRoot({ clientEnv: fx.clientEnv, expectedPid: fx.rootPid, expectedCwd: fx.dir }),
    (error) => error.kind === "root_project_identity",
  );
  // The general probe is unchanged when expectedCwd is omitted, even with a wrong tag.
  fx.tmux(["set-option", "-t", fx.sessionId + ":", "@project_dir", "/tmp/not-the-root"]);
  assert.equal(probeTmuxRoot({ clientEnv: fx.clientEnv, expectedPid: fx.rootPid }).session.id, fx.sessionId);
});

test("a non-self root with remain-on-exit on is refused before hooks and workers", async (t) => {
  const fx = await fixture(t);
  fx.tmux(["set-option", "-w", "-t", fx.rootPane, "remain-on-exit", "on"]);
  const ready = join(fx.dir, "ready.json");
  const windowsBefore = fx.tmux(["list-windows", "-t", fx.sessionId + ":", "-F", "#{window_id}"]).stdout.trim().split("\n").length;

  await assert.rejects(
    async () => fx.spawn("worker-0", ready),
    (error) => error.kind === "root_remain_on_exit",
  );
  await assert.rejects(
    async () => installOwnedHooks({ manifestPath: fx.manifestPath, owner: "owner", run: "run1", generation: 1, expectedCoreId: fx.coreId }),
    (error) => error.kind === "root_remain_on_exit",
  );
  assert.equal(existsSync(ready), false);
  assert.equal(fx.tmux(["list-windows", "-t", fx.sessionId + ":", "-F", "#{window_id}"]).stdout.trim().split("\n").length, windowsBefore);
  assert.doesNotMatch(fx.tmux(["show-hooks", "-g", "pane-exited"]).stdout, /tmux-cleanup/);
  assert.equal(fx.record().workerWindow, null);
});

test("the actual root self-clears an inherited remain-on-exit before continuing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tmux-remain-"));
  const socket = join(dir, "sock");
  const env = { ...process.env, HOME: dir, XDG_RUNTIME_DIR: join(dir, "run") };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const tmux = (args) => spawnSync("tmux", ["-S", socket, "-N", ...args], { encoding: "utf8", timeout: 10000, env });
  t.after(() => {
    try { tmux(["kill-server"]); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const out = join(dir, "probe.json");
  const probeScript = join(dir, "root-probe.mjs");
  writeFileSync(probeScript, [
    'import { writeFileSync } from "node:fs";',
    'import { probeTmuxRoot } from ' + JSON.stringify(new URL("../tmux-terminal.mjs", import.meta.url).href) + ";",
    "try {",
    "  const probe = probeTmuxRoot({ clientEnv: process.env, expectedPid: process.pid });",
    '  writeFileSync(' + JSON.stringify(out) + ', JSON.stringify({ ok: true, server: probe.server, session: probe.session, rootPane: probe.rootPane }));',
    "} catch (error) {",
    '  writeFileSync(' + JSON.stringify(out) + ', JSON.stringify({ ok: false, kind: error.kind, message: error.message }));',
    "}",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));

  const start = spawnSync(
    "tmux",
    ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "task", "-c", dir, "--", "/bin/sleep", "300"],
    { encoding: "utf8", timeout: 10000, env },
  );
  assert.equal(start.status, 0, start.stderr);
  assert.equal(tmux(["set-option", "-g", "remain-on-exit", "on"]).status, 0);
  const created = tmux(["new-window", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-t", "$0:", "-c", dir, "--", NODE, probeScript]);
  assert.equal(created.status, 0, created.stderr);
  const [probePane, probePidText] = created.stdout.trim().split(" ");
  const probePid = Number(probePidText);

  await waitFor(() => existsSync(out), "self root probe", 8000);
  const result = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(result.ok, true, result.message);
  assert.equal(tmux(["display-message", "-p", "-t", probePane, "-F", "#{remain-on-exit}"]).stdout.trim(), "off");
  // A pane split into the same window keeps the inherited window/global value:
  // the root cleared only its own pane-local option.
  const other = tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", probePane, "-c", dir, "--", "/bin/sleep", "300"]);
  assert.equal(other.status, 0, other.stderr);
  const otherPane = other.stdout.trim();
  assert.equal(tmux(["display-message", "-p", "-t", otherPane, "-F", "#{remain-on-exit}"]).stdout.trim(), "on");
  assert.equal(tmux(["display-message", "-p", "-t", probePane, "-F", "#{remain-on-exit}"]).stdout.trim(), "off");

  const tuple = tmux([
    "display-message", "-p", "-t", probePane, "-F",
    ["#{socket_path}", "#{pid}", "#{start_time}", "#{version}", "#{session_id}", "#{session_created}"].join(SEP),
  ]).stdout.trim().split(SEP);
  const clientEnv = { TMUX: [tuple[0], tuple[1], tuple[2]].join(","), TMUX_PANE: probePane };
  assert.equal(probeTmuxRoot({ clientEnv, expectedPid: probePid }).rootPane.paneId, probePane);

  // A non-self caller must refuse rather than modify this pane or start a worker.
  assert.equal(tmux(["set-option", "-p", "-t", probePane, "remain-on-exit", "on"]).status, 0);
  await assert.rejects(
    async () => probeTmuxRoot({ clientEnv, expectedPid: probePid }),
    (error) => error.kind === "root_remain_on_exit",
  );
  const startCommand = tmux(["display-message", "-p", "-t", probePane, "-F", "#{pane_start_command}"]).stdout.trim();
  const manifestPath = join(dir, "pool-manifest.json");
  writeRecord(manifestPath, {
    schemaVersion: 3,
    terminalBackend: "tmux",
    owner: "owner",
    run: "run1",
    generation: 1,
    cwd: dir,
    server: { socketPath: tuple[0], pid: Number(tuple[1]), startTime: Number(tuple[2]), version: tuple[3] },
    session: { id: tuple[4], created: Number(tuple[5]) },
    rootPane: { paneId: probePane, panePid: probePid, startCommand },
    workerWindow: null,
    workerPanes: {},
    hooks: {},
  });
  const coreId = "tmux:" + tuple[0] + "#" + tuple[1] + "." + tuple[2] + "/" + tuple[4];
  await assert.rejects(
    async () => spawnWorkerTerminal({
      manifestPath, workerId: "worker-0", rootAddress: probePane, cwd: dir,
      argv: [NODE, join(dir, "worker.mjs")], env: { PI_MIND_WORKER_ID: "worker-0" }, expectedCoreId: coreId,
    }),
    (error) => error.kind === "root_remain_on_exit",
  );
  await assert.rejects(
    async () => installOwnedHooks({ manifestPath, owner: "owner", run: "run1", generation: 1, expectedCoreId: coreId }),
    (error) => error.kind === "root_remain_on_exit",
  );
  assert.doesNotMatch(tmux(["show-hooks", "-g", "pane-exited"]).stdout, /tmux-cleanup/);
});

test("SIGKILL of the root leaves no owned worker pane and no owned hook entry", async (t) => {
  const fx = await fixture(t);
  await installOwnedHooks({
    manifestPath: fx.manifestPath, owner: "owner", run: "run1", generation: 1, expectedCoreId: fx.coreId,
  });
  assert.match(fx.record().hooks["pane-exited"].command, /tmux-cleanup\.mjs/);
  assert.doesNotMatch(fx.tmux(["show-hooks", "-g", "client-detached"]).stdout, /run-shell|tmux-cleanup/,
    "detach is never hooked");

  const ready = join(fx.dir, "ready-0.json");
  const { address } = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");

  process.kill(fx.rootPid, "SIGKILL");
  const stopped = await waitFor(() => {
    const record = fx.record();
    return record.state === "stopped" ? record : null;
  }, "hook cleanup to stop the pool", 10000);

  assert.deepEqual(stopped.workerPanes, {});
  assert.deepEqual(stopped.hooks, {});
  assert.equal(paneAlive(fx, address), false, "worker pane is gone");
  assert.equal(paneAlive(fx, fx.editorPane), true, "editor survives");
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.doesNotMatch(fx.tmux(["show-hooks", "-g", event]).stdout, /run-shell|tmux-cleanup/,
      "owned " + event + " entry removed");
  }
});
