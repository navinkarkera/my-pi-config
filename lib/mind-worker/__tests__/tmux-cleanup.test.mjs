// tmux-cleanup.test.mjs - private-server tests for the hook helper, owned hook
// index removal/normalization, stale-helper fencing, --check-stopped and the
// read-only --locate-root source proof.
//
// Temp HOME/XDG/agent dirs, private socket, tmux -f /dev/null, fake scripts.
// No default socket, real pool, model, network or notifier is touched. Every
// test creates its own tmux server; no foreign/older fixture is addressed.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  probeTmuxRoot,
  spawnWorkerTerminal,
  installOwnedHooks,
  cleanupPool,
} from "../tmux-terminal.mjs";

const NODE = process.execPath;
const CLEANUP = fileURLToPath(new URL("../tmux-cleanup.mjs", import.meta.url));
const SEP = "\u001f";
const DEAD = 2_000_000_000;
const ROOT_SCRIPT = "setInterval(() => {}, 1000);\n";
const WORKER_SCRIPT = [
  'import { writeFileSync } from "node:fs";',
  "writeFileSync(process.argv[2], String(process.pid));",
  "setInterval(() => {}, 1000);",
  "",
].join("\n");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(fn, label, timeout = 10000) {
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

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tmux-cleanup-"));
  const socket = join(dir, "sock");
  const env = {
    ...process.env,
    HOME: dir,
    XDG_RUNTIME_DIR: join(dir, "run"),
    XDG_STATE_HOME: join(dir, "state"),
  };
  delete env.TMUX;
  delete env.TMUX_PANE;

  const tmux = (args) =>
    spawnSync("tmux", ["-S", socket, "-N", ...args], { encoding: "utf8", timeout: 10000, env });

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
  const editor = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "$0:", "-c", dir, "--", "/bin/sleep", "300"]);
  assert.equal(editor.status, 0, editor.stderr);
  const editorPane = editor.stdout.trim();
  const sessionId = tmux(["display-message", "-p", "-t", rootPane, "-F", "#{session_id}"]).stdout.trim();

  const tuple = tmux([
    "display-message", "-p", "-t", rootPane, "-F",
    ["#{socket_path}", "#{pid}", "#{start_time}", "#{version}", "#{session_id}", "#{session_created}"].join(SEP),
  ]).stdout.trim().split(SEP);
  const probe = probeTmuxRoot({
    clientEnv: { TMUX: [tuple[0], tuple[1], tuple[2]].join(","), TMUX_PANE: rootPane },
    expectedPid: rootPid,
  });

  const manifestPath = join(dir, "a-manifest.json");
  const base = {
    schemaVersion: 3,
    terminalBackend: "tmux",
    owner: "owner-a",
    run: "run-a",
    generation: 1,
    cwd: dir,
    server: probe.server,
    session: probe.session,
    rootPane: probe.rootPane,
    workerWindow: null,
    workerPanes: {},
    hooks: {},
  };
  writeRecord(manifestPath, base);

  const fx = {
    dir,
    socket,
    env,
    tmux,
    rootPane,
    rootPid,
    editorPane,
    sessionId,
    probe,
    manifestPath,
    base,
    coreId: probe.coreIdentity.id,
    paneIds: () => tmux(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.trim().split("\n").filter(Boolean),
    paneAlive: (paneId) => fx.paneIds().includes(paneId),
    record: () => readRecord(manifestPath),
    write: (record) => writeRecord(manifestPath, record),
    spawn: (workerId, readyPath) =>
      spawnWorkerTerminal({
        manifestPath,
        workerId,
        rootAddress: probe.rootPane.paneId,
        name: workerId,
        cwd: dir,
        argv: [NODE, join(dir, "worker.mjs"), readyPath],
        env: { PI_MIND_WORKER_ID: workerId, PI_MIND_WORKER_ROLE: "worker" },
        expectedCoreId: probe.coreIdentity.id,
      }),
    install: () => installOwnedHooks({
      manifestPath, owner: "owner-a", run: "run-a", generation: 1, expectedCoreId: probe.coreIdentity.id,
    }),
    cleanup: (extra = {}) => cleanupPool({
      manifestPath, owner: "owner-a", run: "run-a", generation: 1,
      expectedCoreId: probe.coreIdentity.id, ...extra,
    }),
    hookText: (event) => tmux(["show-hooks", "-g", event]).stdout,
  };
  t.after(async () => {
    try { tmux(["kill-server"]); } catch { /* gone */ }
    // A hook-driven sweep already spawned by tmux may still be writing; let it
    // finish, then remove this one fixture directory (never a glob).
    await sleep(250);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return fx;
}

function runCleanupCli(fx, args, extraEnv = {}) {
  return spawnSync(NODE, [CLEANUP, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...fx.env, ...extraEnv },
  });
}

function stateCase(fx, records, prefix) {
  const caseDir = mkdtempSync(join(fx.dir, prefix + "-"));
  const agentDir = join(caseDir, "agent");
  const dir = join(agentDir, "mindworker");
  mkdirSync(dir, { recursive: true });
  for (const [name, record] of Object.entries(records)) writeRecord(join(dir, name + "-manifest.json"), record);
  return { caseDir, agentDir, dir };
}

function guard(fx, records, root = fx.dir) {
  const state = stateCase(fx, records, "guard");
  const result = runCleanupCli(fx, ["--check-stopped", root], { PI_CODING_AGENT_DIR: state.agentDir });
  return { ...result, ...state };
}

function locate(fx, records, overrides = {}) {
  const state = stateCase(fx, records, "locate");
  const args = [
    "--locate-root", overrides.root ?? fx.dir,
    "--session", overrides.session ?? fx.sessionId,
    "--socket", overrides.socket ?? fx.socket,
    "--server-pid", String(overrides.serverPid ?? Number(fx.probe.server.pid)),
  ];
  const result = runCleanupCli(fx, args, { PI_CODING_AGENT_DIR: state.agentDir });
  return { ...result, ...state };
}

function liveHookCommand(fx, event, index) {
  const prefix = event + "[" + index + "]";
  const line = fx.hookText(event).split("\n").find((value) => value === prefix || value.startsWith(prefix + " "));
  return line ? line.slice(prefix.length).trim() : null;
}

function goneServerRecord(fx, overrides = {}) {
  return {
    ...fx.base,
    server: { socketPath: join(fx.dir, "gone.sock"), pid: 999_999, startTime: 1, version: "3.8" },
    rootPane: { paneId: "%98", panePid: DEAD, startCommand: "gone" },
    workerWindow: null,
    workerPanes: {},
    hooks: {},
    state: "stopped",
    ...overrides,
  };
}

test("cleanup removes only owned hook entries and never a foreign entry at its index", async (t) => {
  const fx = await fixture(t);
  for (const [event, marker] of [["pane-exited", "foreign-pane"], ["after-kill-pane", "foreign-kill"], ["window-unlinked", "foreign-window"]]) {
    fx.tmux(["set-hook", "-g", event + "[0]", 'run-shell -b "echo ' + marker + '"']);
  }
  const installed = await fx.install();
  // The record stores the live show-hooks normalization, not our raw quoting.
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    const entry = installed.hooks[event];
    assert.equal(fx.record().hooks[event].command, liveHookCommand(fx, event, entry.index));
  }

  const ready = join(fx.dir, "ready.json");
  const worker = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");

  // Someone replaces our pane-exited entry at the same index.
  fx.tmux(["set-hook", "-g", "pane-exited[" + installed.hooks["pane-exited"].index + "]", 'run-shell -b "echo foreign-takeover"']);

  fx.tmux(["kill-pane", "-t", fx.rootPane]);
  await waitFor(() => !fx.paneAlive(worker.address), "owned worker killed", 10000);
  await waitFor(() => !/tmux-cleanup/.test(fx.hookText("after-kill-pane")), "other owned hooks removed", 10000);

  assert.equal(fx.paneAlive(fx.editorPane), true);
  assert.match(fx.hookText("pane-exited"), /foreign-takeover/);
  assert.match(fx.hookText("pane-exited"), /foreign-pane/);
  assert.doesNotMatch(fx.hookText("pane-exited"), /tmux-cleanup/);
  for (const event of ["after-kill-pane", "window-unlinked"]) {
    assert.ok(fx.hookText(event).includes(event === "after-kill-pane" ? "foreign-kill" : "foreign-window"));
    assert.doesNotMatch(fx.hookText(event), /tmux-cleanup/);
  }

  const result = await fx.cleanup();
  assert.equal(result.stopped, false);
  assert.ok(result.unconfirmed.some((item) => item.hook === "pane-exited" && item.reason === "foreign-entry"));
  assert.match(fx.hookText("pane-exited"), /foreign-takeover/, "a foreign entry at our index is never unset");
  assert.equal(fx.record().state === "stopped", false, "an unconfirmed sweep never claims success");
});

test("a modified entry that still contains the pool tokens is foreign: left installed and reported", async (t) => {
  const fx = await fixture(t);
  const installed = await fx.install();
  const entry = installed.hooks["pane-exited"];
  const stored = fx.record().hooks["pane-exited"].command;
  // Exact identity, not a token match: the stored intent is the live command.
  assert.equal(stored, liveHookCommand(fx, "pane-exited", entry.index));
  // Same pool path/owner/run/generation, one extra command before ours.
  const modified = stored.replace('run-shell -b "', 'run-shell -b "true; ');
  assert.notEqual(modified, stored);
  fx.tmux(["set-hook", "-g", "pane-exited[" + entry.index + "]", modified]);
  assert.match(liveHookCommand(fx, "pane-exited", entry.index), /true; /);

  const ready = join(fx.dir, "ready.json");
  const worker = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");
  fx.tmux(["kill-pane", "-t", fx.rootPane]);

  // The modified entry still runs (it contains our command), so the sweep runs,
  // kills the owned worker, and refuses the hook instead of unsetting it.
  await waitFor(() => !fx.paneAlive(worker.address), "owned worker killed", 10000);
  // Whichever sweep killed the worker, one has finished: its record write is
  // what the explicit sweep below must reproduce.
  await waitFor(() => !fx.record().hooks?.["after-kill-pane"], "a sweep finished", 10000);
  const result = await fx.cleanup();
  assert.equal(result.stopped, false);
  assert.ok(result.unconfirmed.some((item) => item.hook === "pane-exited" && item.reason === "foreign-entry"));
  assert.match(fx.hookText("pane-exited"), /true; /, "a modified entry is never unset");
  assert.match(liveHookCommand(fx, "pane-exited", entry.index), /true; /);
  for (const event of ["after-kill-pane", "window-unlinked"]) {
    assert.doesNotMatch(fx.hookText(event), /tmux-cleanup/);
  }
  const record = fx.record();
  assert.deepEqual(Object.keys(record.hooks), ["pane-exited"], "only the foreign entry stays recorded");
  assert.equal(record.state === "stopped", false, "an unconfirmed sweep never claims success");
  assert.equal(fx.paneAlive(fx.editorPane), true);
});

test("install never adopts a modified entry at the recorded index", async (t) => {
  const fx = await fixture(t);
  const first = (await fx.install()).hooks["pane-exited"].index;
  // Someone rewrites our entry, keeping every token, then the pool reinstalls.
  fx.tmux(["set-hook", "-g", "pane-exited[" + first + "]", 'run-shell -b "true; /x/node /x/tmux-cleanup.mjs"']);
  const again = await fx.install();
  assert.notEqual(again.hooks["pane-exited"].index, first, "a modified entry is not adopted");
  assert.ok(again.unconfirmed.some((item) => item.event === "pane-exited" && item.reason === "foreign-entry"));
  assert.match(liveHookCommand(fx, "pane-exited", first), /true; /, "the modified entry is left alone");
  assert.equal(liveHookCommand(fx, "pane-exited", again.hooks["pane-exited"].index), again.hooks["pane-exited"].command);

  const ready = join(fx.dir, "ready.json");
  const worker = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");
  fx.tmux(["kill-pane", "-t", fx.rootPane]);
  await waitFor(() => !fx.paneAlive(worker.address), "owned worker killed", 10000);
  await waitFor(() => fx.record().state === "stopped", "stopped", 10000);
  assert.equal(liveHookCommand(fx, "pane-exited", again.hooks["pane-exited"].index), null);
  assert.match(fx.hookText("pane-exited"), /true; /, "the foreign entry survives the sweep");
});

test("a SIGKILL inside the first set-hook window leaves removable intents, not a leaked hook", async (t) => {
  const fx = await fixture(t);
  // A foreign entry the install and the sweep must both preserve.
  fx.tmux(["set-hook", "-g", "pane-exited[0]", 'run-shell -b "echo foreign-pane"']);

  const flag = join(fx.dir, "shim-fired");
  const shim = join(fx.dir, "tmux-shim.sh");
  writeFileSync(shim, [
    "#!/bin/sh",
    'if [ ! -f "' + flag + '" ]; then',
    '  case " $* " in',
    '    *" set-hook "*)',
    '      tmux "$@" || exit $?',
    '      : > "' + flag + '"',
    '      kill -9 "$PPID"',
    '      exit 0',
    '      ;;',
    '  esac',
    'fi',
    'exec tmux "$@"',
    "",
  ].join("\n"), { mode: 0o755 });

  const childScript = join(fx.dir, "install-child.mjs");
  writeFileSync(childScript, [
    "import { installOwnedHooks } from " + JSON.stringify(new URL("../tmux-terminal.mjs", import.meta.url).href) + ";",
    "await installOwnedHooks({ manifestPath: process.argv[2], owner: 'owner-a', run: 'run-a', generation: 1,",
    "  expectedCoreId: process.argv[3] });",
    "",
  ].join("\n"));
  const child = spawnSync(NODE, [childScript, fx.manifestPath, fx.coreId], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...fx.env, PI_TMUX_BIN: shim },
  });
  assert.equal(child.signal, "SIGKILL", "install child died inside the set-hook window: " + child.stderr);

  // Every index was persisted before the first set-hook, so the record can be
  // swept even though the install never reached its canonical update.
  const intents = fx.record().hooks;
  assert.deepEqual(Object.keys(intents).sort(), ["after-kill-pane", "pane-exited", "window-unlinked"]);
  const installedIndex = intents["pane-exited"].index;
  assert.equal(installedIndex, 1, "a free index next to the foreign entry");
  assert.match(liveHookCommand(fx, "pane-exited", installedIndex), /tmux-cleanup/);
  assert.equal(liveHookCommand(fx, "pane-exited", 0), 'run-shell -b "echo foreign-pane"');
  for (const event of ["after-kill-pane", "window-unlinked"]) {
    assert.equal(liveHookCommand(fx, event, intents[event].index), null, event + " was never installed");
  }

  // The installed hook is the one that sweeps after the root dies; it must find
  // and remove its own entry from the pre-readback intent. pane-exited (not
  // after-kill-pane, which kill-pane would fire) is the one installed here.
  process.kill(fx.rootPid, "SIGKILL");
  const stopped = await waitFor(() => (fx.record().state === "stopped" ? fx.record() : null), "swept after the crash", 10000);
  assert.deepEqual(stopped.hooks, {});
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.doesNotMatch(fx.hookText(event), /tmux-cleanup/, event + " has no owned entry left");
  }
  assert.equal(liveHookCommand(fx, "pane-exited", 0), 'run-shell -b "echo foreign-pane"');
});

test("a SIGKILL after the first canonical update keeps both installed entries removable", async (t) => {
  const fx = await fixture(t);
  // Kill the installer on the second set-hook: pane-exited is then canonical in
  // the record and after-kill-pane is still an intent; window-unlinked was never
  // installed at all.
  const counter = join(fx.dir, "shim-count");
  const shim = join(fx.dir, "tmux-shim2.sh");
  writeFileSync(shim, [
    "#!/bin/sh",
    'case " $* " in',
    '  *" set-hook "*)',
    '    n=0; [ -f "' + counter + '" ] && n=$(cat "' + counter + '")',
    "    n=$((n + 1)); printf '%s' \"$n\" > \"" + counter + "\"",
    '    tmux "$@" || exit $?',
    '    [ "$n" -ge 2 ] && kill -9 "$PPID"',
    "    exit 0",
    "    ;;",
    "esac",
    'exec tmux "$@"',
    "",
  ].join("\n"), { mode: 0o755 });
  const childScript = join(fx.dir, "install-child2.mjs");
  writeFileSync(childScript, [
    "import { installOwnedHooks } from " + JSON.stringify(new URL("../tmux-terminal.mjs", import.meta.url).href) + ";",
    "await installOwnedHooks({ manifestPath: process.argv[2], owner: 'owner-a', run: 'run-a', generation: 1,",
    "  expectedCoreId: process.argv[3] });",
    "",
  ].join("\n"));
  const child = spawnSync(NODE, [childScript, fx.manifestPath, fx.coreId], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...fx.env, PI_TMUX_BIN: shim },
  });
  assert.equal(child.signal, "SIGKILL", "install child died on the second set-hook: " + child.stderr);

  const record = fx.record();
  const first = record.hooks["pane-exited"];
  const second = record.hooks["after-kill-pane"];
  const third = record.hooks["window-unlinked"];
  assert.equal(liveHookCommand(fx, "pane-exited", first.index), first.command, "canonical readback persisted");
  assert.match(liveHookCommand(fx, "after-kill-pane", second.index), /tmux-cleanup/);
  assert.equal(liveHookCommand(fx, "window-unlinked", third.index), null);
  assert.match(second.command, /^run-shell -b "/, "the unread intent is still the exact serialization");

  process.kill(fx.rootPid, "SIGKILL");
  const stopped = await waitFor(() => (fx.record().state === "stopped" ? fx.record() : null), "swept after the second-set-hook crash", 10000);
  assert.deepEqual(stopped.hooks, {});
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.doesNotMatch(fx.hookText(event), /tmux-cleanup/, event + " has no owned entry left");
  }
});

test("owned hooks stay armed until worker quiescence and a later worker exit retriggers the sweep", async (t) => {
  const fx = await fixture(t);
  await fx.install();
  const ready = join(fx.dir, "ready.json");
  const worker = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");

  // Stop proving the pane is ours: the sweep must neither kill it nor drop the
  // hooks, because only a later sweep can finish the pool.
  fx.tmux(["set-option", "-pu", "-t", worker.address, "@mind.worker"]);
  fx.tmux(["kill-pane", "-t", fx.rootPane]);
  await sleep(1200);
  const result = await fx.cleanup();
  assert.equal(result.stopped, false);
  assert.ok(result.unconfirmed.some((item) => item.paneId === worker.address && item.reason === "markers-changed"));
  assert.equal(fx.paneAlive(worker.address), true, "an unproven pane is never killed");
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.match(fx.hookText(event), /tmux-cleanup/, event + " keeps its owned entry while unconfirmed");
  }
  assert.ok(fx.record().hooks["pane-exited"], "the record keeps the owned hooks");

  // The worker finally exits: its own pane-exited runs the still-armed hook.
  fx.tmux(["kill-pane", "-t", worker.address]);
  const stopped = await waitFor(() => (fx.record().state === "stopped" ? fx.record() : null), "stopped after the worker exit", 10000);
  assert.deepEqual(stopped.hooks, {});
  assert.equal(stopped.workerWindow, null);
  for (const event of ["pane-exited", "after-kill-pane", "window-unlinked"]) {
    assert.doesNotMatch(fx.hookText(event), /tmux-cleanup/);
  }
  assert.equal(fx.paneAlive(fx.editorPane), true);
});

test("a stale generation helper after a restart mutates nothing and keeps stdout quiet", async (t) => {
  const fx = await fixture(t);
  const installed = await fx.install();
  const oldInner = installed.hooks["pane-exited"].command.slice(
    installed.hooks["pane-exited"].command.indexOf('"') + 1,
    installed.hooks["pane-exited"].command.lastIndexOf('"'),
  );
  const readyA = join(fx.dir, "ready-a.json");
  await fx.spawn("worker-a", readyA);
  await waitFor(() => existsSync(readyA), "gen1 worker ready");
  fx.tmux(["kill-pane", "-t", fx.rootPane]);
  await waitFor(() => fx.record().state === "stopped", "gen1 stopped", 10000);
  await sleep(300);

  const created = fx.tmux(["new-window", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-t", "$0:", "-c", fx.dir, "--", NODE, join(fx.dir, "root.mjs")]);
  assert.equal(created.status, 0, created.stderr);
  const [root2Pane, root2PidText] = created.stdout.trim().split(" ");
  const probe2 = probeTmuxRoot({
    clientEnv: { TMUX: [fx.probe.server.socketPath, String(fx.probe.server.pid), String(fx.probe.server.startTime)].join(","), TMUX_PANE: root2Pane },
    expectedPid: Number(root2PidText),
  });
  const { state, stoppedAt, ...base } = fx.record();
  void state;
  void stoppedAt;
  const gen2 = {
    ...base,
    generation: 2,
    server: probe2.server,
    session: probe2.session,
    rootPane: probe2.rootPane,
    workerWindow: null,
    workerPanes: {},
    hooks: {},
  };
  fx.write(gen2);
  const readyB = join(fx.dir, "ready-b.json");
  const workerB = await spawnWorkerTerminal({
    manifestPath: fx.manifestPath,
    workerId: "worker-b",
    rootAddress: probe2.rootPane.paneId,
    cwd: fx.dir,
    argv: [NODE, join(fx.dir, "worker.mjs"), readyB],
    env: { PI_MIND_WORKER_ID: "worker-b", PI_MIND_WORKER_ROLE: "worker" },
    expectedCoreId: probe2.coreIdentity.id,
  });
  await waitFor(() => existsSync(readyB), "gen2 worker ready");
  const gen2Before = readFileSync(fx.manifestPath, "utf8");

  const cli = runCleanupCli(fx, ["--cleanup", "--record", fx.manifestPath, "--owner", "owner-a", "--run", "run-a", "--generation", "1"]);
  assert.equal(cli.status, 3, cli.stderr);
  assert.equal(cli.stdout, "", "cleanup stdout must stay quiet");
  assert.match(cli.stderr, /stale_generation/);
  const staleHook = spawnSync("sh", ["-c", oldInner], { encoding: "utf8", timeout: 20000, env: fx.env });
  assert.equal(staleHook.status, 3, staleHook.stderr);
  assert.equal(staleHook.stdout, "", "stale hook stdout must stay quiet");
  assert.match(staleHook.stderr, /stale_generation/);

  assert.equal(fx.paneAlive(workerB.address), true, "gen2 worker survives the stale helper");
  assert.equal(fx.paneAlive(probe2.rootPane.paneId), true, "gen2 root survives the stale helper");
  assert.equal(readFileSync(fx.manifestPath, "utf8"), gen2Before, "stale helper writes nothing");
  assert.equal(fx.record().generation, 2);
});

test("cleanup refuses a live root, the hook CLI is a silent no-op, and allowRootLive without the root pid", async (t) => {
  const fx = await fixture(t);
  await fx.install();
  const ready = join(fx.dir, "ready.json");
  const worker = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");
  const before = readFileSync(fx.manifestPath, "utf8");

  const live = await fx.cleanup();
  assert.equal(live.stopped, false);
  assert.equal(live.refused, "root_live");
  assert.equal(readFileSync(fx.manifestPath, "utf8"), before);
  assert.equal(fx.paneAlive(worker.address), true);

  const unproven = await fx.cleanup({ allowRootLive: true });
  assert.equal(unproven.stopped, false);
  assert.equal(unproven.refused, "root_pid_unproven");
  assert.equal(fx.paneAlive(worker.address), true);
  assert.match(fx.hookText("pane-exited"), /tmux-cleanup/);

  const cliLive = runCleanupCli(fx, ["--cleanup", "--record", fx.manifestPath, "--owner", "owner-a", "--run", "run-a", "--generation", "1"]);
  assert.equal(cliLive.status, 0, cliLive.stderr);
  assert.equal(cliLive.stdout, "", "a live-root hook is silent on stdout");
  assert.equal(cliLive.stderr, "", "a live-root hook is silent on stderr");
  assert.equal(readFileSync(fx.manifestPath, "utf8"), before, "the live-root hook writes nothing");
  assert.equal(fx.paneAlive(worker.address), true, "the live-root hook kills nothing");
});

test("a normal root exit stops the pool through the global hooks", async (t) => {
  const fx = await fixture(t);
  await fx.install();
  const ready = join(fx.dir, "ready.json");
  const worker = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");

  process.kill(fx.rootPid, "SIGTERM");
  const stopped = await waitFor(() => (fx.record().state === "stopped" ? fx.record() : null), "cleanup after normal exit", 10000);
  assert.deepEqual(stopped.workerPanes, {});
  assert.deepEqual(stopped.hooks, {});
  assert.equal(fx.paneAlive(worker.address), false);
  assert.equal(fx.paneAlive(fx.editorPane), true);

  const cliStopped = runCleanupCli(fx, ["--cleanup", "--record", fx.manifestPath, "--owner", "owner-a", "--run", "run-a", "--generation", "1"]);
  assert.equal(cliStopped.status, 0, cliStopped.stderr);
  assert.equal(cliStopped.stdout, "", "a stopped-pool hook is silent on stdout");
  assert.equal(cliStopped.stderr, "", "a stopped-pool hook is silent on stderr");
});

test("an unconfirmed sweep writes a durable label the guard refuses until a proven sweep", async (t) => {
  const fx = await fixture(t);
  await fx.install();
  const ready = join(fx.dir, "ready.json");
  const worker = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");

  // Someone else's marker on our recorded pane: proven unowned, never killed.
  // The root exits so the sweep is allowed to run; the pane stays unproven.
  fx.tmux(["set-option", "-p", "-t", worker.address, "@mind.owner", "someone-else"]);
  fx.tmux(["kill-pane", "-t", fx.rootPane]);
  await waitFor(() => fx.record().state === "unconfirmed", "a durable unconfirmed record", 10000);
  const result = await fx.cleanup();
  assert.equal(result.stopped, false);
  assert.ok(result.unconfirmed.some((item) => item.paneId === worker.address && item.reason === "markers-changed"));
  const record = fx.record();
  assert.equal(Object.keys(record.hooks).length, 3, "an unconfirmed sweep keeps its hooks");
  assert.equal(fx.paneAlive(worker.address), true);

  const cliUnconfirmed = runCleanupCli(fx, ["--cleanup", "--record", fx.manifestPath, "--owner", "owner-a", "--run", "run-a", "--generation", "1"]);
  assert.equal(cliUnconfirmed.status, 3, cliUnconfirmed.stderr);
  assert.equal(cliUnconfirmed.stdout, "");
  assert.match(cliUnconfirmed.stderr, /cleanup: refused unconfirmed/);

  // The durable label alone blocks the guard on a live server whose record
  // lists no worker state left to prove.
  const labelled = {
    ...fx.base, state: "unconfirmed",
    rootPane: { paneId: "%98", panePid: DEAD, startCommand: "gone" },
    workerWindow: null, workerPanes: {}, hooks: {},
  };
  const guarded = guard(fx, { labelled });
  assert.equal(guarded.status, 3, guarded.stderr);
  assert.match(guarded.stderr, /unconfirmed record/);
  assert.equal(locate(fx, { labelled }).status, 4, "a labelled record is never located as live");

  // The pane is provably owned again; the next sweep proves quiescence, clears
  // the label and removes the owned hooks.
  fx.tmux(["set-option", "-p", "-t", worker.address, "@mind.owner", "owner-a"]);
  const stoppedSweep = await fx.cleanup();
  assert.equal(stoppedSweep.stopped, true, JSON.stringify(stoppedSweep));
  const stopped = fx.record();
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(stopped.hooks, {});
  assert.equal(fx.paneAlive(worker.address), false);
  assert.equal(guard(fx, { stopped }).status, 0);
});

test("--check-stopped is readonly and uses segment containment, not prefix or ancestor collapse", async (t) => {
  const fx = await fixture(t);
  await fx.install();
  const ready = join(fx.dir, "ready.json");
  const worker = await fx.spawn("worker-0", ready);
  await waitFor(() => existsSync(ready), "worker ready");
  const liveRecord = fx.record();
  const beforeBytes = readFileSync(fx.manifestPath, "utf8");

  const liveCase = guard(fx, { live: liveRecord });
  assert.equal(liveCase.status, 3, liveCase.stderr);
  assert.equal(liveCase.stdout, "", "check-stopped stdout is quiet");
  assert.match(liveCase.stderr, /alive|root live|owned worker panes/);
  assert.equal(readFileSync(fx.manifestPath, "utf8"), beforeBytes);
  assert.equal(fx.paneAlive(worker.address), true);
  assert.equal(fx.paneAlive(fx.rootPane), true);
  assert.equal(readdirSync(liveCase.dir).join(","), "live-manifest.json", "readonly: no lock files");

  // Root live with no workers is still blocked by the root pid.
  assert.equal(guard(fx, { rootOnly: { ...liveRecord, workerWindow: null, workerPanes: {} } }).status, 3);

  // A nested record is at/under the queried root: blocked (pids alive).
  const nested = { ...liveRecord, cwd: join(fx.dir, "nested", "config") };
  const nestedCase = guard(fx, { nested });
  assert.equal(nestedCase.status, 3, nestedCase.stderr);
  assert.match(nestedCase.stderr, /alive|root live|owned worker panes/);
  // A sibling whose name shares the prefix is not under the root.
  assert.equal(guard(fx, { nested }, fx.dir + "-sibling").status, 0);
  assert.equal(guard(fx, { nested }, fx.dir + "x").status, 0);
  // An ancestor record is not under a nested queried root.
  assert.equal(guard(fx, { ancestor: liveRecord }, join(fx.dir, "nested")).status, 0);

  // A stopped/gone host with dead pids is safe.
  const safe = goneServerRecord(fx);
  const safeCase = guard(fx, { safe });
  assert.equal(safeCase.status, 0, safeCase.stderr);
  assert.equal(safeCase.stdout, "");
  assert.match(safeCase.stderr, /stopped/);

  // Unconfirmed/inconsistent/stale states are refused.
  assert.equal(guard(fx, { unconfirmed: { ...liveRecord, state: "unconfirmed" } }).status, 3);
  assert.equal(guard(fx, { inconsistent: { ...liveRecord, state: "stopped" } }).status, 3);
  assert.equal(guard(fx, {
    stale: { ...goneServerRecord(fx), server: { ...goneServerRecord(fx).server, socketPath: fx.socket, pid: Number(fx.probe.server.pid), startTime: liveRecord.server.startTime + 1 } },
  }).status, 3);
  assert.equal(guard(fx, {}).status, 0);
});

test("--check-stopped refuses missing/invalid roots and strict schema/backend mismatches", async (t) => {
  const fx = await fixture(t);
  const noRoot = { ...fx.base };
  delete noRoot.cwd;
  assert.equal(guard(fx, { noRoot }).status, 3);
  assert.match(guard(fx, { noRoot }).stderr, /missing root/);

  const badRoot = { ...fx.base, cwd: "relative/path" };
  assert.equal(guard(fx, { badRoot }).status, 3);
  assert.match(guard(fx, { badRoot }).stderr, /invalid cwd/);

  const conflicting = { ...fx.base, rootDir: join(fx.dir, "other") };
  assert.equal(guard(fx, { conflicting }).status, 3);
  assert.match(guard(fx, { conflicting }).stderr, /conflicting root/);

  const badJson = stateCase(fx, {}, "badjson");
  writeFileSync(join(badJson.dir, "broken-manifest.json"), "{not json");
  const badJsonResult = runCleanupCli(fx, ["--check-stopped", fx.dir], { PI_CODING_AGENT_DIR: badJson.agentDir });
  assert.equal(badJsonResult.status, 3);
  assert.equal(badJsonResult.stdout, "");
  assert.match(badJsonResult.stderr, /unreadable/);

  const dead = goneServerRecord(fx);
  assert.equal(guard(fx, { v3hc: { ...dead, terminalBackend: "hc" } }).status, 3);
  assert.match(guard(fx, { v3hc: { ...dead, terminalBackend: "hc" } }).stderr, /unknown schemaVersion/);
  assert.equal(guard(fx, { v2tmux: { ...dead, schemaVersion: 2 } }).status, 3);
  assert.equal(guard(fx, { unknown: { ...dead, schemaVersion: 99 } }).status, 3);

  // v2/hc and legacy need the exact pair plus positive host proof.
  const v2 = { schemaVersion: 2, terminalBackend: "hc", cwd: fx.dir, state: "stopped" };
  assert.equal(guard(fx, { v2 }).status, 3, "no recorded pid proof");
  assert.equal(guard(fx, { v2: { ...v2, launcherPid: DEAD, mindPid: DEAD } }).status, 0);
  assert.equal(guard(fx, { v2: { ...v2, launcherPid: process.pid, mindPid: DEAD } }).status, 3);
  assert.equal(guard(fx, { v2: { ...v2, launcherPid: 1, mindPid: DEAD } }).status, 3, "EPERM is not gone");
  writeFileSync(join(fx.dir, "old.sock"), "stale socket path");
  assert.equal(guard(fx, { v2: { ...v2, launcherPid: DEAD, socketPath: join(fx.dir, "old.sock") } }).status, 3);
  assert.equal(guard(fx, { v2: { ...v2, launcherPid: DEAD, socketPath: join(fx.dir, "absent.sock") } }).status, 0);
  assert.equal(guard(fx, { v2: { ...v2, state: "running", launcherPid: DEAD } }).status, 3);

  const legacy = { cwd: fx.dir, state: "stopped", launcherPid: DEAD };
  assert.equal(guard(fx, { legacy }).status, 0);
  assert.equal(guard(fx, { legacy: { ...legacy, state: "running" } }).status, 3);
  assert.equal(guard(fx, { legacy: { ...legacy, terminalBackend: "hc" } }).status, 3, "no-schema/hc is unknown");
  assert.equal(guard(fx, { legacy: { ...legacy, schemaVersion: 1, terminalBackend: "hc" } }).status, 3);
});

test("--check-stopped requires pid proof even when the server or session is gone", async (t) => {
  const fx = await fixture(t);
  const gone = goneServerRecord(fx);
  assert.equal(guard(fx, { gone }).status, 0);
  assert.equal(guard(fx, { gone: { ...gone, rootPane: { ...gone.rootPane, panePid: process.pid } } }).status, 3);
  assert.equal(guard(fx, { gone: { ...gone, rootPane: { ...gone.rootPane, panePid: 1 } } }).status, 3, "EPERM is not gone");
  assert.equal(guard(fx, { gone: { ...gone, mindPid: process.pid } }).status, 3);
  assert.equal(guard(fx, { gone: { ...gone, launcherPid: process.pid } }).status, 3);
  assert.equal(guard(fx, {
    gone: { ...gone, workerPanes: { w0: { paneId: "%97", panePid: process.pid, startCommand: "x" } } },
  }).status, 3);

  // A live server whose recorded session is gone: dead pids permit removal.
  const sessionGone = {
    ...gone,
    server: fx.probe.server,
    session: { id: "$99", created: 1 },
    state: "stopped",
  };
  assert.equal(guard(fx, { sessionGone }).status, 0);
  assert.equal(guard(fx, {
    sessionGone: { ...sessionGone, workerPanes: { w0: { paneId: "%97", panePid: process.pid, startCommand: "x" } } },
  }).status, 3, "a live recorded worker pid blocks even with the session gone");
});

test("--locate-root returns one unique live proof, follows the moved root, and refuses ambiguity", async (t) => {
  const fx = await fixture(t);
  const record = fx.record();
  const beforePanes = fx.paneIds().join(",");
  const beforeRecord = JSON.stringify(record);

  const found = locate(fx, { live: record });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim().split("\n").length, 1);
  const parsed = JSON.parse(found.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ["manifestPath", "rootPane", "server", "session"]);
  assert.equal(parsed.manifestPath, join(found.dir, "live-manifest.json"));
  assert.deepEqual(parsed.server, record.server);
  assert.deepEqual(parsed.session, record.session);
  assert.deepEqual(parsed.rootPane, record.rootPane);
  assert.equal(fx.paneIds().join(","), beforePanes, "locate is readonly");
  assert.equal(JSON.stringify(fx.record()), beforeRecord);

  // The root pane may move to another window in the same session; pane id/pid/
  // start command remain the identity.
  const moved = fx.tmux(["break-pane", "-d", "-P", "-F", "#{pane_id} #{window_id}", "-s", fx.rootPane, "-t", fx.sessionId + ":"]);
  assert.equal(moved.status, 0, moved.stderr);
  const movedFound = locate(fx, { live: record });
  assert.equal(movedFound.status, 0, movedFound.stderr);
  assert.equal(JSON.parse(movedFound.stdout).rootPane.paneId, fx.rootPane);

  // Source/session/socket must match exactly; no default/active fallback.
  assert.equal(locate(fx, { live: record }, { session: "$99" }).status, 3);
  assert.equal(locate(fx, {}, { socket: join(fx.dir, "absent.sock") }).status, 3);
  const wrongPid = locate(fx, { live: record }, { serverPid: Number(fx.probe.server.pid) + 1 });
  assert.equal(wrongPid.status, 4);
  assert.equal(wrongPid.stdout, "");
  const cross = locate(fx, { cross: { ...record, session: { ...record.session, id: "$99" } } });
  assert.equal(cross.status, 4);
  assert.equal(cross.stdout, "");
  assert.equal(locate(fx, { legacy: { schemaVersion: 2, terminalBackend: "hc", cwd: fx.dir, state: "running", launcherPid: process.pid } }).status, 4);
  assert.equal(locate(fx, { unconfirmed: { ...record, state: "unconfirmed" } }).status, 4);
  assert.equal(locate(fx, { live: record, live2: { ...record, owner: "owner-b", run: "run-b" } }).status, 4);
  assert.equal(locate(fx, { nested: { ...record, cwd: join(fx.dir, "nested") } }).status, 3);
  assert.equal(locate(fx, {}).status, 3);

  const stoppedRecord = {
    ...record,
    state: "stopped",
    rootPane: { paneId: "%98", panePid: DEAD, startCommand: "gone" },
    workerWindow: null,
    workerPanes: {},
    hooks: {},
  };
  const stoppedCase = locate(fx, { stopped: stoppedRecord });
  assert.equal(stoppedCase.status, 3);
  assert.equal(stoppedCase.stdout, "");
  const unconfirmedStopped = { ...stoppedRecord, rootPane: { ...stoppedRecord.rootPane, panePid: process.pid } };
  assert.equal(locate(fx, { unconfirmedStopped }).status, 4, "a live recorded pid is unconfirmed, not stopped");

  const bad = stateCase(fx, { live: record }, "locate-bad");
  writeFileSync(join(bad.dir, "broken-manifest.json"), "{not json");
  const badResult = runCleanupCli(fx, [
    "--locate-root", fx.dir, "--session", fx.sessionId, "--socket", fx.socket,
    "--server-pid", String(Number(fx.probe.server.pid)),
  ], { PI_CODING_AGENT_DIR: bad.agentDir });
  assert.equal(badResult.status, 4);
  assert.equal(badResult.stdout, "");
});

test("the cleanup CLI validates identity, keeps stdout quiet and leaves v2 records untouched", async (t) => {
  const fx = await fixture(t);
  await fx.install();
  const v2Path = join(fx.dir, "v2-manifest.json");
  const v2 = { schemaVersion: 2, terminalBackend: "hc", state: "stopped", launcherPid: DEAD, cwd: fx.dir };
  writeRecord(v2Path, v2);
  const before = readFileSync(fx.manifestPath, "utf8");

  const missing = runCleanupCli(fx, ["--cleanup", "--record", fx.manifestPath, "--owner", "owner-a", "--run", "run-a"]);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /generation/);
  assert.equal(readFileSync(fx.manifestPath, "utf8"), before);

  const noMode = runCleanupCli(fx, []);
  assert.equal(noMode.status, 2);
  assert.equal(noMode.stdout, "");

  const badPath = runCleanupCli(fx, ["--check-stopped", "relative"]);
  assert.equal(badPath.status, 3);
  assert.equal(badPath.stdout, "");
  assert.match(badPath.stderr, /invalid root/);

  const v2Run = runCleanupCli(fx, ["--cleanup", "--record", v2Path, "--owner", "owner-a", "--run", "run-a", "--generation", "1"]);
  assert.equal(v2Run.status, 3);
  assert.equal(v2Run.stdout, "");
  assert.match(v2Run.stderr, /refused record/);
  assert.deepEqual(readRecord(v2Path), v2, "a v2 record is never touched");

  const missingRecord = runCleanupCli(fx, ["--cleanup", "--record", join(fx.dir, "absent-manifest.json"), "--owner", "owner-a", "--run", "run-a", "--generation", "1"]);
  assert.equal(missingRecord.status, 0);
  assert.equal(missingRecord.stdout, "");
  assert.equal(missingRecord.stderr, "", "an absent-record hook is silent on stderr");

  const command = fx.record().hooks?.["pane-exited"]?.command ?? "";
  assert.match(command, /tmux-cleanup\.mjs/);
  assert.doesNotMatch(command, /readline|prompt|password|token|secret/i);
});
