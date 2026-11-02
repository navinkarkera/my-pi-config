// tmux-worker-window.test.mjs - private-server tests for the single reserved
// worker window, the wrapper spawn transaction, hook scope and multi-pool
// coexistence.
//
// Temp HOME/XDG, private socket, tmux -f /dev/null, fake root/worker scripts.
// No default socket, real pool, model, network or notifier is touched.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  probeTmuxRoot,
  spawnWorkerTerminal,
  retireWorkerTerminal,
  listOwnedTerminals,
  installOwnedHooks,
  cleanupPool,
  updatePoolManifest,
  getTerminal,
} from "../tmux-terminal.mjs";

const NODE = process.execPath;
const SEP = "\u001f";
const ROOT_SCRIPT = "setInterval(() => {}, 1000);\n";
const WORKER_SCRIPT = [
  'import { writeFileSync } from "node:fs";',
  "writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, cwd: process.cwd() }));",
  "setInterval(() => {}, 1000);",
  "",
].join("\n");
const EXIT_WORKER_SCRIPT = [
  'import { writeFileSync } from "node:fs";',
  "writeFileSync(process.argv[2], String(process.pid));",
  "setTimeout(() => process.exit(0), 300);",
  "",
].join("\n");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(fn, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(label + " not met within " + timeout + "ms");
    await sleep(30);
  }
}

const readRecord = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeRecord = (path, record) => writeFileSync(path, JSON.stringify(record, null, 2));

function paneIds(fx) {
  return fx.tmux(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.trim().split("\n").filter(Boolean);
}
const paneAlive = (fx, paneId) => paneIds(fx).includes(paneId);

function hookText(fx, event) {
  return fx.tmux(["show-hooks", "-g", event]).stdout;
}

async function fixture(t, { makeExitWorker = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tmux-window-"));
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
  writeFileSync(join(dir, "exit-worker.mjs"), EXIT_WORKER_SCRIPT);

  const start = spawnSync(
    "tmux",
    ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}",
      "-s", "task", "-c", dir, "--", NODE, join(dir, "root.mjs")],
    { encoding: "utf8", timeout: 10000, env },
  );
  assert.equal(start.status, 0, start.stderr);
  const [rootPane, rootPidText] = start.stdout.trim().split(" ");
  const rootPid = Number(rootPidText);

  const editor = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "$0:", "-c", dir, "--", "/bin/sleep", "300"]);
  assert.equal(editor.status, 0, editor.stderr);
  const editorPane = editor.stdout.trim();
  const sessionId = tmux(["display-message", "-p", "-t", rootPane, "-F", "#{session_id}"]).stdout.trim();

  const tuple = tmux([
    "display-message", "-p", "-t", rootPane, "-F",
    ["#{socket_path}", "#{pid}", "#{start_time}", "#{version}", "#{session_id}", "#{session_created}"].join(SEP),
  ]).stdout.trim().split(SEP);
  const server = { socketPath: tuple[0], pid: Number(tuple[1]), startTime: Number(tuple[2]), version: tuple[3] };
  const session = { id: tuple[4], created: Number(tuple[5]) };
  const clientEnv = { TMUX: [tuple[0], tuple[1], tuple[2]].join(","), TMUX_PANE: rootPane };
  const probe = probeTmuxRoot({ clientEnv, expectedPid: rootPid });

  const makePool = (id, info) => {
    const manifestPath = join(dir, id + "-manifest.json");
    const record = {
      schemaVersion: 3,
      terminalBackend: "tmux",
      owner: "owner-" + id,
      run: "run-" + id,
      generation: 1,
      cwd: dir,
      server: info.server,
      session: info.session,
      rootPane: info.rootPane,
      workerWindow: null,
      workerPanes: {},
      hooks: {},
    };
    writeRecord(manifestPath, record);
    return {
      id,
      manifestPath,
      owner: record.owner,
      run: record.run,
      generation: 1,
      coreId: "tmux:" + info.server.socketPath + "#" + info.server.pid + "." + info.server.startTime + "/" + info.session.id,
      rootAddress: info.rootPane.paneId,
      record: () => readRecord(manifestPath),
      write: (next) => writeRecord(manifestPath, next),
      spawn: (workerId, readyPath, workerScript = join(dir, "worker.mjs")) =>
        spawnWorkerTerminal({
          manifestPath,
          workerId,
          rootAddress: info.rootPane.paneId,
          name: workerId,
          cwd: dir,
          argv: [NODE, workerScript, readyPath],
          env: { PI_MIND_WORKER_ID: workerId, PI_MIND_WORKER_ROLE: "worker" },
          expectedCoreId: "tmux:" + info.server.socketPath + "#" + info.server.pid + "." + info.server.startTime + "/" + info.session.id,
        }),
      installHooks: () => installOwnedHooks({
        manifestPath, owner: record.owner, run: record.run, generation: 1,
        expectedCoreId: "tmux:" + info.server.socketPath + "#" + info.server.pid + "." + info.server.startTime + "/" + info.session.id,
      }),
      cleanup: (extra = {}) => cleanupPool({
        manifestPath, owner: record.owner, run: record.run, generation: 1, ...extra,
      }),
    };
  };

  const fx = {
    dir,
    socket,
    env,
    tmux,
    rootPane,
    rootPid,
    editorPane,
    sessionId,
    server,
    session,
    clientEnv,
    probe,
    workerPath: join(dir, "worker.mjs"),
    exitWorkerPath: join(dir, "exit-worker.mjs"),
    poolA: makePool("a", { server, session, rootPane: probe.rootPane }),
    paneIds: () => paneIds(fx),
    paneAlive: (paneId) => paneAlive(fx, paneId),
    hookText: (event) => hookText(fx, event),
    makeRoot: (sessionTarget = "$0:") => {
      const created = tmux(["new-window", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-t", sessionTarget, "-c", dir, "--", NODE, join(dir, "root.mjs")]);
      assert.equal(created.status, 0, created.stderr);
      const [paneId, pidText] = created.stdout.trim().split(" ");
      const paneProbe = tmux([
        "display-message", "-p", "-t", paneId, "-F",
        ["#{pane_id}", "#{pane_pid}", "#{pane_start_command}", "#{window_id}", "#{session_id}",
          "#{@mind.owner}", "#{@mind.run}", "#{@mind.generation}", "#{@mind.worker}"].join(SEP),
      ]).stdout.trim().split(SEP);
      return {
        paneId,
        pid: Number(pidText),
        rootPane: { paneId: paneProbe[0], panePid: Number(paneProbe[1]), startCommand: paneProbe[2] },
      };
    },
    makePoolForRoot: (id, root) => {
      const p = probeTmuxRoot({ clientEnv: { TMUX: [server.socketPath, String(server.pid), String(server.startTime)].join(","), TMUX_PANE: root.paneId }, expectedPid: root.pid });
      return makePool(id, { server: p.server, session: p.session, rootPane: p.rootPane });
    },
  };
  void makeExitWorker;
  t.after(() => {
    try { tmux(["kill-server"]); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_TMUX_BIN;
    delete process.env.PI_TMUX_DROP;
    delete process.env.PI_TMUX_LOSE;
    delete process.env.PI_TMUX_KILL_ROOT;
    delete process.env.PI_TMUX_TAMPER_START;
    delete process.env.PI_TMUX_LOG;
  });
  return fx;
}

function writeShim(fx) {
  const shim = join(fx.dir, "tmux-shim.sh");
  const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real.startsWith("/"), "real tmux path");
  writeFileSync(shim, [
    "#!/bin/sh",
    'if [ -n "$PI_TMUX_LOG" ]; then',
    '  case "$*" in',
    '    *"new-window"*|*"split-window"*|*"select-layout"*) echo "$*" >> "$PI_TMUX_LOG" ;;',
    "  esac",
    "fi",
    'if [ -n "$PI_TMUX_DROP" ] && [ -e "$PI_TMUX_DROP" ]; then',
    '  case "$*" in',
    '    *"new-window"*|*"split-window"*) rm -f "$PI_TMUX_DROP"; exit 0 ;;',
    "  esac",
    "fi",
    'if [ -n "$PI_TMUX_LOSE" ] && [ -e "$PI_TMUX_LOSE" ]; then',
    '  case "$*" in',
    '    *"new-window"*|*"split-window"*)',
    '      rm -f "$PI_TMUX_LOSE"',
    '      if [ -n "$PI_TMUX_KILL_ROOT" ]; then kill -9 "$PI_TMUX_KILL_ROOT" 2>/dev/null; fi',
    '      exec "' + real + '" "$@" >/dev/null',
    "      ;;",
    "  esac",
    "fi",
    // Rewrite only the start command of the pane carrying the given worker
    // marker. The reconciler reads tmux through this shim; the wrapper in the
    // pane reads the real server, so the record keeps the true command.
    'if [ -n "$PI_TMUX_TAMPER_START" ]; then',
    '  case "$*" in',
    '    *display-message*"#{pane_start_command}"*)',
    '      "' + real + '" "$@" | awk -v FS="$(printf \'\\037\')" -v OFS="$(printf \'\\037\')" -v w="$PI_TMUX_TAMPER_START" \'$9==w{$3="tampered-start-command"}1\'',
    "      exit 0",
    "      ;;",
    "  esac",
    "fi",
    'exec "' + real + '" "$@"',
    "",
  ].join("\n"));
  chmodSync(shim, 0o755);
  return shim;
}

test("concurrent static+burst spawns keep one reserved window and refuse duplicates", async (t) => {
  const fx = await fixture(t);
  const ready = [];
  const jobs = [];
  for (let i = 0; i < 6; i++) {
    const path = join(fx.dir, "ready-" + i + ".json");
    ready.push(path);
    jobs.push(fx.poolA.spawn("worker-" + i, path));
  }
  const results = await Promise.all(jobs);
  await waitFor(() => ready.every((path) => existsSync(path)), "all workers ready");

  const record = fx.poolA.record();
  assert.match(record.workerWindow, /^@[0-9]+$/);
  assert.equal(fx.paneIds().filter((id) => id !== fx.rootPane && id !== fx.editorPane).length, 6);
  const workerWindows = fx.tmux(["list-windows", "-t", fx.sessionId + ":", "-F", "#{window_id}"]).stdout.trim().split("\n");
  assert.equal(workerWindows.length, 3, "Mind + one worker window + editor");
  assert.equal(results.filter((r) => r.address).length, 6);
  assert.equal(new Set(results.map((r) => r.address)).size, 6);

  // A duplicate worker id is refused without touching the existing pane.
  await assert.rejects(
    async () => fx.poolA.spawn("worker-0", join(fx.dir, "dup.json")),
    (error) => error.kind === "already_exists",
  );
  assert.equal(fx.paneAlive(record.workerPanes["worker-0"].paneId), true);
});

test("the reserved worker window is created as workers and keeps the name", async (t) => {
  const fx = await fixture(t);
  // The deployed tmux.conf sets both globally; the reserved window's own name
  // must survive that, and turning automatic-rename off must stay window-local.
  assert.equal(fx.tmux(["set-option", "-g", "automatic-rename", "on"]).status, 0);
  assert.equal(fx.tmux(["set-option", "-g", "automatic-rename-format", "ZZ:#{pane_current_command}"]).status, 0);
  const detail = (windowId) =>
    fx.tmux(["display-message", "-p", "-t", windowId, "-F", "#{window_name}\t#{automatic-rename}"]).stdout.trim().split("\t");

  const first = await fx.poolA.spawn("worker-0", join(fx.dir, "ready-name-0.json"));
  const workerWindow = fx.poolA.record().workerWindow;
  assert.deepEqual(detail(workerWindow), ["workers", "0"], "named at creation, auto-rename off on that window");

  const second = await fx.poolA.spawn("worker-1", join(fx.dir, "ready-name-1.json"));
  assert.equal(fx.poolA.record().workerWindow, workerWindow, "the second worker splits the same window");
  assert.deepEqual(detail(workerWindow), ["workers", "0"], "the name survives the split");

  // No global option changed and no other window was touched.
  assert.equal(fx.tmux(["show-options", "-g", "-v", "automatic-rename"]).stdout.trim(), "on");
  assert.equal(fx.tmux(["show-options", "-g", "-v", "automatic-rename-format"]).stdout.trim(), "ZZ:#{pane_current_command}");
  const others = fx.tmux(["list-windows", "-t", fx.sessionId + ":", "-F", "#{window_id}\t#{automatic-rename}"])
    .stdout.trim().split("\n").map((line) => line.split("\t")).filter(([id]) => id !== workerWindow);
  assert.equal(others.length, 2, "Mind and the editor keep their windows");
  assert.ok(others.every(([, auto]) => auto === "1"), "other windows still auto-rename");
  assert.equal(fx.paneAlive(first.address), true);
  assert.equal(fx.paneAlive(second.address), true);
});

test("an empty worker window is recreated only in the same live pool", async (t) => {
  const fx = await fixture(t);
  const first = await fx.poolA.spawn("worker-0", join(fx.dir, "ready-0.json"), fx.exitWorkerPath);
  const firstWindow = fx.poolA.record().workerWindow;
  await waitFor(() => !fx.paneAlive(first.address), "worker 0 to exit by itself");

  // remain-on-exit is off: the empty worker window (and its pane) is gone.
  await waitFor(() => fx.tmux(["display-message", "-p", "-t", firstWindow, "-F", "#{window_id}"]).stdout.trim() === "", "worker window destroyed");

  const second = await fx.poolA.spawn("worker-1", join(fx.dir, "ready-1.json"));
  const record = fx.poolA.record();
  assert.notEqual(record.workerWindow, firstWindow, "a fresh window is created in the same live pool");
  assert.equal(fx.paneAlive(second.address), true);
  assert.equal(fx.paneAlive(fx.rootPane), true);
  assert.equal(fx.paneAlive(fx.editorPane), true);

  // A stale server tuple must not create another window.
  const stale = { ...record, server: { ...record.server, startTime: record.server.startTime + 1 } };
  fx.poolA.write(stale);
  await assert.rejects(
    async () => fx.poolA.spawn("worker-2", join(fx.dir, "ready-2.json")),
    (error) => error.kind === "stale_tuple",
  );
  assert.equal(fx.poolA.record().workerPanes["worker-2"], undefined);
  assert.equal(fx.paneIds().filter((id) => id !== fx.rootPane && id !== fx.editorPane).length, 1);
});

test("a lost new-window or split-window reply is reconciled by the unique registered pane", async (t) => {
  const fx = await fixture(t);
  const shim = writeShim(fx);
  const lose = join(fx.dir, "lose-reply");
  const log = join(fx.dir, "create.log");
  process.env.PI_TMUX_BIN = shim;
  process.env.PI_TMUX_LOSE = lose;
  process.env.PI_TMUX_LOG = log;

  writeFileSync(lose, "1");
  const firstReady = join(fx.dir, "ready-lost-new.json");
  const first = await fx.poolA.spawn("worker-lost-new", firstReady);
  await waitFor(() => existsSync(firstReady), "worker after lost new-window reply");
  assert.equal(fx.poolA.record().workerPanes["worker-lost-new"].paneId, first.address);
  assert.equal(fx.tmux(["list-windows", "-t", fx.sessionId + ":", "-F", "#{window_id}"]).stdout.trim().split("\n").length, 3);

  writeFileSync(lose, "1");
  const secondReady = join(fx.dir, "ready-lost-split.json");
  const second = await fx.poolA.spawn("worker-lost-split", secondReady);
  await waitFor(() => existsSync(secondReady), "worker after lost split-window reply");
  assert.equal(fx.poolA.record().workerPanes["worker-lost-split"].paneId, second.address);
  assert.equal(fx.tmux(["list-windows", "-t", fx.sessionId + ":", "-F", "#{window_id}"]).stdout.trim().split("\n").length, 3);

  // Exactly two create commands were attempted; the lost replies caused no retry.
  const creates = readFileSync(log, "utf8").split("\n")
    .filter((line) => line.includes("new-window") || line.includes("split-window"));
  assert.equal(creates.length, 2);
  assert.equal(fx.paneAlive(first.address), true);
  assert.equal(fx.paneAlive(second.address), true);
});

test("a lost create reply never accepts a recorded pane whose start command changed", { timeout: 30000 }, async (t) => {
  const fx = await fixture(t);
  const shim = writeShim(fx);
  const lose = join(fx.dir, "lose-reply");
  const log = join(fx.dir, "create.log");
  process.env.PI_TMUX_BIN = shim;
  process.env.PI_TMUX_LOSE = lose;
  process.env.PI_TMUX_LOG = log;
  process.env.PI_TMUX_TAMPER_START = "worker-start";

  writeFileSync(lose, "1");
  const ready = join(fx.dir, "ready-start.json");
  await assert.rejects(
    async () => fx.poolA.spawn("worker-start", ready),
    (error) => error.spawnUnconfirmed === true && error.kind === "spawn_unconfirmed",
  );
  await waitFor(() => existsSync(ready), "the registered worker to start");

  // The wrapper registered the pane it created from the real server, so the
  // recorded pid and start command are true; only the reconciler's probe was
  // rewritten. Same pane, same pid, different start command: not proof.
  const record = fx.poolA.record();
  const entry = record.workerPanes["worker-start"];
  assert.ok(entry, "the wrapper registered the pane");
  const live = fx.tmux([
    "display-message", "-p", "-t", entry.paneId, "-F", ["#{pane_pid}", "#{pane_start_command}"].join(SEP),
  ]).stdout.trim().split(SEP);
  assert.equal(Number(live[0]), entry.panePid, "the recorded pane pid still matches");
  assert.equal(live[1], entry.startCommand, "the record keeps the pane's true start command");
  assert.equal(fx.paneAlive(entry.paneId), true, "an unproven pane is never killed");
  assert.deepEqual(fx.poolA.record(), record, "the record is left as it is");
  const creates = readFileSync(log, "utf8").split("\n")
    .filter((line) => line.includes("new-window") || line.includes("split-window"));
  assert.equal(creates.length, 1, "no blind retry");
});

test("a create racing root death leaves no orphan and stays unconfirmed", async (t) => {
  const fx = await fixture(t);
  const shim = writeShim(fx);
  const lose = join(fx.dir, "lose-reply");
  const log = join(fx.dir, "create.log");
  process.env.PI_TMUX_BIN = shim;
  process.env.PI_TMUX_LOSE = lose;
  process.env.PI_TMUX_KILL_ROOT = String(fx.rootPid);
  process.env.PI_TMUX_LOG = log;
  writeFileSync(lose, "1");

  const ready = join(fx.dir, "ready-late.json");
  await assert.rejects(
    async () => fx.poolA.spawn("worker-late", ready),
    (error) => error.spawnUnconfirmed === true && error.kind === "spawn_unconfirmed",
  );
  await sleep(500);
  assert.equal(existsSync(ready), false, "the worker program never started");
  assert.equal(fx.poolA.record().workerPanes["worker-late"], undefined);
  assert.equal(fx.paneIds().some((id) => id !== fx.editorPane), false, "no orphan pane or window");
  const creates = readFileSync(log, "utf8").split("\n")
    .filter((line) => line.includes("new-window") || line.includes("split-window"));
  assert.equal(creates.length, 1, "no blind retry");
});

test("a lost reply never adopts a marked pane the record does not list", { timeout: 30000 }, async (t) => {
  const fx = await fixture(t);
  const shim = writeShim(fx);
  const drop = join(fx.dir, "drop-create");
  process.env.PI_TMUX_BIN = shim;
  process.env.PI_TMUX_DROP = drop;

  const first = await fx.poolA.spawn("worker-0", join(fx.dir, "ready-0.json"));
  const workerWindow = fx.poolA.record().workerWindow;
  // A pane that carries this pool's markers for a worker id the record never
  // lists: markers alone are not the create proof.
  const decoy = fx.tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", workerWindow, "-c", fx.dir, "--", "/bin/sleep", "300"]).stdout.trim();
  for (const [name, value] of [
    ["@mind.owner", "owner-a"], ["@mind.run", "run-a"], ["@mind.generation", "1"], ["@mind.worker", "worker-lost"],
  ]) {
    fx.tmux(["set-option", "-p", "-t", decoy, name, value]);
  }

  // The create itself produces no pane and its reply is lost.
  writeFileSync(drop, "1");
  await assert.rejects(
    async () => fx.poolA.spawn("worker-lost", join(fx.dir, "ready-lost.json")),
    (error) => error.spawnUnconfirmed === true && error.kind === "spawn_unconfirmed",
  );
  assert.equal(fx.paneAlive(decoy), true, "an unrecorded marked pane is never adopted or killed");
  const record = fx.poolA.record();
  assert.equal(record.workerPanes["worker-lost"], undefined);
  assert.equal(record.workerPanes["worker-0"].paneId, first.address);
});

test("worker removals retile only the reserved worker window and never focus it", async (t) => {
  const fx = await fixture(t);
  const shim = writeShim(fx);
  const log = join(fx.dir, "create.log");
  process.env.PI_TMUX_BIN = shim;
  process.env.PI_TMUX_LOG = log;

  const a = await fx.poolA.spawn("worker-a", join(fx.dir, "ready-a.json"));
  const b = await fx.poolA.spawn("worker-b", join(fx.dir, "ready-b.json"));
  const workerWindow = fx.poolA.record().workerWindow;
  // A manual pane keeps the window alive across both removals.
  const manual = fx.tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", workerWindow, "-c", fx.dir, "--", "/bin/sleep", "300"]).stdout.trim();
  const activeWindow = () => fx.tmux(["display-message", "-p", "-t", fx.sessionId + ":", "-F", "#{window_active}"]).stdout.trim();
  const focusBefore = activeWindow();
  const layoutCalls = () => readFileSync(log, "utf8").split("\n").filter((line) => line.includes("select-layout"));
  writeFileSync(log, "");

  await retireWorkerTerminal(a.address, {
    manifestPath: fx.poolA.manifestPath, expectedCoreId: fx.poolA.coreId, rootAddress: fx.rootPane,
  });
  const retired = layoutCalls();
  assert.equal(retired.length, 1, "one retile after the retire");
  assert.match(retired[0], new RegExp("-t " + workerWindow + " tiled"));
  assert.equal(activeWindow(), focusBefore, "retiling never steals focus");

  // The sweep after the root dies retiles the same window once more.
  writeFileSync(log, "");
  process.kill(fx.rootPid, "SIGTERM");
  await waitFor(
    () => fx.tmux(["display-message", "-p", "-t", fx.rootPane, "-F", "#{pane_id}"]).stdout.trim() === "",
    "root pane to close",
  );
  const swept = await fx.poolA.cleanup();
  assert.deepEqual(swept.killed, [b.address]);
  const sweepLayouts = layoutCalls();
  assert.equal(sweepLayouts.length, 1, "one retile after the sweep");
  assert.match(sweepLayouts[0], new RegExp("-t " + workerWindow + " tiled"));
  assert.equal(fx.paneAlive(manual), true, "an unmarked pane in the worker window survives");
  assert.equal(fx.paneAlive(fx.editorPane), true);
});

test("kill-pane of the root sweeps only marked workers and keeps the editor", async (t) => {
  const fx = await fixture(t);
  await fx.poolA.installHooks();
  const worker = await fx.poolA.spawn("worker-0", join(fx.dir, "ready.json"));
  const manual = fx.tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", fx.poolA.record().workerWindow, "-c", fx.dir, "--", "/bin/sleep", "300"]).stdout.trim();
  assert.equal(fx.paneAlive(manual), true);

  fx.tmux(["kill-pane", "-t", fx.rootPane]);
  const stopped = await waitFor(() => (fx.poolA.record().state === "stopped" ? fx.poolA.record() : null), "cleanup after kill-pane", 10000);
  assert.equal(fx.paneAlive(worker.address), false);
  assert.equal(fx.paneAlive(manual), true, "unmarked pane in the worker window survives");
  assert.equal(fx.paneAlive(fx.editorPane), true);
  assert.deepEqual(stopped.hooks, {});
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.doesNotMatch(fx.hookText(event), /run-shell|tmux-cleanup/, event + " entry removed");
  }
});

test("window-unlinked or an unrelated pane exit with a live root sweeps nothing", async (t) => {
  const fx = await fixture(t);
  await fx.poolA.installHooks();
  const worker = await fx.poolA.spawn("worker-0", join(fx.dir, "ready.json"));
  const before = JSON.stringify(fx.poolA.record());

  // An unrelated pane exit fires pane-exited; the root is live, so refuse.
  const other = fx.tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "$0:", "-c", fx.dir, "--", "/bin/sleep", "300"]).stdout.trim();
  fx.tmux(["kill-pane", "-t", other]);
  await sleep(300);
  assert.equal(JSON.stringify(fx.poolA.record()), before, "record untouched while the root is live");
  assert.equal(fx.paneAlive(worker.address), true);
  assert.match(fx.hookText("pane-exited"), /tmux-cleanup/);

  // window-unlinked alone (root live) must not sweep or remove owned hooks.
  fx.tmux(["kill-window", "-t", fx.poolA.record().workerWindow]);
  await sleep(300);
  assert.equal(JSON.stringify(fx.poolA.record()), before, "window-unlinked refused while the root is live");
  assert.match(fx.hookText("after-kill-pane"), /tmux-cleanup/);

  // Now the root dies: the hook may sweep the stale record and remove hooks.
  fx.tmux(["kill-pane", "-t", fx.rootPane]);
  const stopped = await waitFor(() => (fx.poolA.record().state === "stopped" ? fx.poolA.record() : null), "cleanup after root exit", 10000);
  assert.deepEqual(stopped.workerPanes, {});
  assert.deepEqual(stopped.hooks, {});
  assert.equal(fx.paneAlive(fx.editorPane), true);
});

test("two pools share the server hook lists without disturbing each other or foreign entries", async (t) => {
  const fx = await fixture(t);
  // Pre-existing, non-pool entries in the same global hook arrays.
  fx.tmux(["set-hook", "-g", "pane-exited[0]", 'run-shell -b "echo foreign-pane"']);
  fx.tmux(["set-hook", "-g", "after-kill-pane[0]", 'run-shell -b "echo foreign-kill"']);
  fx.tmux(["set-hook", "-g", "window-unlinked[0]", 'run-shell -b "echo foreign-window"']);

  const rootB = fx.makeRoot();
  const poolB = fx.makePoolForRoot("b", rootB);
  const hooksA = await fx.poolA.installHooks();
  const hooksB = await poolB.installHooks();

  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.notEqual(hooksA.hooks[event].index, hooksB.hooks[event].index, event + " indexes are distinct");
    assert.ok(fx.hookText(event).includes(foreignCommand(event)), "foreign entry preserved");
  }

  const workerA = await fx.poolA.spawn("worker-a", join(fx.dir, "ready-a.json"));
  const workerB = await poolB.spawn("worker-b", join(fx.dir, "ready-b.json"));
  assert.equal(fx.paneAlive(workerA.address), true);
  assert.equal(fx.paneAlive(workerB.address), true);

  fx.tmux(["kill-pane", "-t", fx.rootPane]);
  await waitFor(() => fx.poolA.record().state === "stopped", "pool A stopped", 10000);
  assert.equal(fx.paneAlive(workerA.address), false);
  assert.equal(fx.paneAlive(workerB.address), true, "pool B worker survives A's sweep");
  assert.deepEqual(fx.poolA.record().hooks, {});
  assert.match(fx.hookText("pane-exited"), /owner-b/);
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.ok(fx.hookText(event).includes(foreignCommand(event)));
  }

  fx.tmux(["kill-pane", "-t", rootB.paneId]);
  await waitFor(() => poolB.record().state === "stopped", "pool B stopped", 10000);
  assert.equal(fx.paneAlive(workerB.address), false);
  assert.equal(fx.paneAlive(fx.editorPane), true);
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.doesNotMatch(fx.hookText(event), /tmux-cleanup/, "owned " + event + " entries removed");
    assert.ok(fx.hookText(event).includes(foreignCommand(event)), "foreign " + event + " entry survives");
  }
});

function foreignCommand(event) {
  return event === "pane-exited" ? "foreign-pane" : event === "after-kill-pane" ? "foreign-kill" : "foreign-window";
}

test("stale tuple, stale generation and non-v3 records are refused untouched", async (t) => {
  const fx = await fixture(t);
  await fx.poolA.installHooks();
  const worker = await fx.poolA.spawn("worker-0", join(fx.dir, "ready.json"));
  const before = readFileSync(fx.poolA.manifestPath, "utf8");

  const staleGen = await fx.poolA.cleanup({ generation: 2 });
  assert.equal(staleGen.stopped, false);
  assert.equal(staleGen.refused, "stale_generation");
  assert.equal(readFileSync(fx.poolA.manifestPath, "utf8"), before, "stale generation writes nothing");
  assert.equal(fx.paneAlive(worker.address), true);

  const record = fx.poolA.record();
  fx.poolA.write({ ...record, server: { ...record.server, startTime: record.server.startTime + 1 } });
  const staleTuple = await fx.poolA.cleanup();
  assert.equal(staleTuple.stopped, false);
  assert.equal(staleTuple.refused, "stale_tuple");
  assert.equal(fx.paneAlive(worker.address), true);
  assert.match(fx.hookText("pane-exited"), /tmux-cleanup/);

  const v2Path = join(fx.dir, "v2-manifest.json");
  const v2 = { schemaVersion: 2, terminalBackend: "hc", generation: 1, cwd: fx.dir };
  writeRecord(v2Path, v2);
  const v2Result = await cleanupPool({ manifestPath: v2Path, owner: "owner-a", run: "run-a", generation: 1 });
  assert.equal(v2Result.stopped, false);
  assert.equal(v2Result.refused, "record");
  assert.deepEqual(readRecord(v2Path), v2, "a v2 record is never converted or touched");

  const update = await updatePoolManifest(fx.poolA.manifestPath, { state: "running" }, {
    owner: "owner-a", run: "run-a", generation: 1,
  });
  assert.equal(update.state, "running");
  assert.equal(update.owner, "owner-a");
  await assert.rejects(
    async () => updatePoolManifest(fx.poolA.manifestPath, { server: { pid: 1 } }, { owner: "owner-a", run: "run-a", generation: 1 }),
    (error) => error.kind === "invalid_params",
  );
  await assert.rejects(
    async () => updatePoolManifest(v2Path, { state: "running" }, { owner: "owner-a", run: "run-a", generation: 1 }),
    (error) => error.kind === "record",
  );
  assert.deepEqual(readRecord(v2Path), v2);
});
