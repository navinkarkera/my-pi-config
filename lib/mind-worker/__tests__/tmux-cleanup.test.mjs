// tmux-cleanup.test.mjs - the read-only removal guard behind dotfiles tmux-mind.
//
// Every case uses a temp HOME/XDG/agent dir and a private tmux server on a temp
// socket with "tmux -f /dev/null": no default socket, no real pool, no model and
// no mutation. The retired mutating sweep (--cleanup) and locator (--locate-root)
// cases are gone with their backend; the guard's fail-closed coverage stays.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE = process.execPath;
const GUARD = fileURLToPath(new URL("../tmux-cleanup.mjs", import.meta.url));
const SEP = "\u001f";
const DEAD = 2_000_000_000;
const ROOT_SCRIPT = "setInterval(() => {}, 1000);\n";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
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
  delete env.PI_CODING_AGENT_DIR;

  const tmux = (args) =>
    spawnSync("tmux", ["-S", socket, "-N", ...args], { encoding: "utf8", timeout: 10000, env });

  writeFileSync(join(dir, "root.mjs"), ROOT_SCRIPT);

  const start = spawnSync(
    "tmux",
    ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}",
      "-s", "task", "-c", dir, "--", NODE, join(dir, "root.mjs")],
    { encoding: "utf8", timeout: 10000, env },
  );
  assert.equal(start.status, 0, start.stderr);
  const [rootPane, rootPidText] = start.stdout.trim().split(" ");
  const editor = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "$0:", "-c", dir, "--", "/bin/sleep", "300"]);
  assert.equal(editor.status, 0, editor.stderr);
  const editorPane = editor.stdout.trim();

  const tuple = tmux([
    "display-message", "-p", "-t", rootPane, "-F",
    ["#{socket_path}", "#{pid}", "#{start_time}", "#{version}", "#{session_id}", "#{session_created}"].join(SEP),
  ]).stdout.replace(/\n$/, "").split(SEP);
  const startCommand = tmux(["display-message", "-p", "-t", rootPane, "-F", "#{pane_start_command}"])
    .stdout.replace(/\n$/, "");

  const base = {
    schemaVersion: 3,
    terminalBackend: "tmux",
    owner: "owner-a",
    run: "run-a",
    generation: 1,
    cwd: dir,
    server: { socketPath: tuple[0], pid: Number(tuple[1]), startTime: Number(tuple[2]), version: tuple[3] },
    session: { id: tuple[4], created: Number(tuple[5]) },
    rootPane: { paneId: rootPane, panePid: Number(rootPidText), startCommand },
    workerWindow: null,
    workerPanes: {},
    hooks: {},
  };

  const fx = {
    dir,
    socket,
    env,
    tmux,
    rootPane,
    rootPid: Number(rootPidText),
    editorPane,
    base,
    paneIds: () => tmux(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.trim().split("\n").filter(Boolean),
    mark: (paneId, values) => {
      for (const [option, value] of Object.entries(values)) {
        const done = tmux(["set-option", "-p", "-t", paneId, option, value]);
        assert.equal(done.status, 0, done.stderr);
      }
    },
    newPane: () => {
      const created = tmux(["new-window", "-d", "-P", "-F", "#{pane_id} #{window_id}", "-t", "$0:", "-c", dir, "--", NODE, join(dir, "root.mjs")]);
      assert.equal(created.status, 0, created.stderr);
      const [paneId, windowId] = created.stdout.trim().split(" ");
      return { paneId, windowId };
    },
  };
  t.after(async () => {
    try { tmux(["kill-server"]); } catch { /* gone */ }
    await sleep(100);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return fx;
}

function stateCase(fx, records, prefix) {
  const caseDir = mkdtempSync(join(fx.dir, prefix + "-"));
  const agentDir = join(caseDir, "agent");
  const dir = join(agentDir, "mindworker");
  mkdirSync(dir, { recursive: true });
  for (const [name, record] of Object.entries(records)) writeRecord(join(dir, name + "-manifest.json"), record);
  return { caseDir, agentDir, dir };
}

function runGuard(fx, args, extraEnv = {}) {
  return spawnSync(NODE, [GUARD, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...fx.env, ...extraEnv },
  });
}

function guard(fx, records, root = fx.dir) {
  const state = stateCase(fx, records, "guard");
  const result = runGuard(fx, ["--check-stopped", root], { PI_CODING_AGENT_DIR: state.agentDir });
  return { ...result, ...state };
}

function goneHostRecord(fx, overrides = {}) {
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

test("--check-stopped is readonly and uses segment containment, not prefix or ancestor collapse", async (t) => {
  const fx = await fixture(t);
  const live = fx.base;
  const beforeBytes = JSON.stringify(live);
  const beforePanes = fx.paneIds().join(",");

  const liveCase = guard(fx, { live });
  assert.equal(liveCase.status, 3, liveCase.stderr);
  assert.equal(liveCase.stdout, "", "check-stopped stdout is quiet");
  assert.match(liveCase.stderr, /alive|root live|owned worker panes/);
  assert.equal(JSON.stringify(readRecord(join(liveCase.dir, "live-manifest.json"))), beforeBytes);
  assert.equal(readdirSync(liveCase.dir).join(","), "live-manifest.json", "readonly: no lock or state files");
  assert.equal(fx.paneIds().join(","), beforePanes, "readonly: no pane was touched");

  // Root live with no workers is still blocked by the root pid.
  assert.equal(guard(fx, { rootOnly: { ...live, workerWindow: null, workerPanes: {} } }).status, 3);

  // A nested record is at/under the queried root: blocked (pids alive).
  const nested = { ...live, cwd: join(fx.dir, "nested", "config") };
  const nestedCase = guard(fx, { nested });
  assert.equal(nestedCase.status, 3, nestedCase.stderr);
  assert.match(nestedCase.stderr, /alive|root live|owned worker panes/);
  // A sibling whose name shares the prefix is not under the root.
  assert.equal(guard(fx, { nested }, fx.dir + "-sibling").status, 0);
  assert.equal(guard(fx, { nested }, fx.dir + "x").status, 0);
  // An ancestor record is not under a nested queried root.
  assert.equal(guard(fx, { ancestor: live }, join(fx.dir, "nested")).status, 0);

  // A stopped/gone host with dead pids is safe.
  const safeCase = guard(fx, { safe: goneHostRecord(fx) });
  assert.equal(safeCase.status, 0, safeCase.stderr);
  assert.equal(safeCase.stdout, "");
  assert.match(safeCase.stderr, /stopped/);

  // Unconfirmed/inconsistent/stale states are refused.
  assert.equal(guard(fx, { unconfirmed: { ...live, state: "unconfirmed" } }).status, 3);
  assert.equal(guard(fx, { inconsistent: { ...live, state: "stopped" } }).status, 3);
  const stale = goneHostRecord(fx, {
    server: { socketPath: fx.socket, pid: Number(live.server.pid), startTime: live.server.startTime + 1, version: "3.8" },
  });
  assert.equal(guard(fx, { stale }).status, 3);
  assert.equal(guard(fx, { stale }).stderr.match(/stale server tuple/).length, 1);
  assert.equal(guard(fx, {}).status, 0);
});

test("a dead legacy root on a live server is safe, and an unmarked pane is never this pool", async (t) => {
  const fx = await fixture(t);
  const worker = fx.newPane();
  fx.mark(worker.paneId, { "@mind.owner": "other-owner", "@mind.run": "run-a", "@mind.generation": "1", "@mind.worker": "w0" });

  // The root program exits: its pane is gone while the session and server stay.
  process.kill(fx.rootPid, "SIGKILL");
  await waitFor(() => !fx.paneIds().includes(fx.rootPane), "root pane gone");

  const stopped = { ...fx.base, state: "stopped" };
  const result = guard(fx, { stopped });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /stopped/);
  assert.equal(fx.paneIds().includes(fx.editorPane), true, "an unmarked editor pane is left alone");
  assert.equal(fx.paneIds().includes(worker.paneId), true, "another owner's marker never matches");
});

test("an owned worker pane the record no longer lists still blocks removal", async (t) => {
  const fx = await fixture(t);
  const worker = fx.newPane();
  fx.mark(worker.paneId, { "@mind.owner": "owner-a", "@mind.run": "run-a", "@mind.generation": "1", "@mind.worker": "w0" });

  const record = {
    ...goneHostRecord(fx),
    // The server is the live one, but every recorded pid is gone.
    server: fx.base.server,
    session: fx.base.session,
    rootPane: { paneId: "%98", panePid: DEAD, startCommand: "gone" },
    workerWindow: null,
    workerPanes: {},
    state: "stopped",
  };
  const result = guard(fx, { record });
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /owned worker panes live: %[0-9]+/);
  assert.equal(fx.paneIds().includes(worker.paneId), true, "the guard never kills the pane");

  // The same record with the markers changed is no longer provably ours.
  fx.mark(worker.paneId, { "@mind.generation": "2" });
  assert.equal(guard(fx, { record }).status, 0);
});

test("--check-stopped refuses missing/invalid roots, unreadable records and strict schema/backend mismatches", async (t) => {
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
  const badJsonResult = runGuard(fx, ["--check-stopped", fx.dir], { PI_CODING_AGENT_DIR: badJson.agentDir });
  assert.equal(badJsonResult.status, 3);
  assert.equal(badJsonResult.stdout, "");
  assert.match(badJsonResult.stderr, /unreadable/);

  // A v3 record without a usable tuple is refused once its pids are gone.
  const deadRoot = { ...fx.base.rootPane, panePid: DEAD };
  const noServer = { ...fx.base, server: null, rootPane: deadRoot };
  assert.equal(guard(fx, { noServer }).status, 3);
  assert.match(guard(fx, { noServer }).stderr, /invalid v3 record/);
  const noPane = { ...fx.base, rootPane: { paneId: "9", panePid: DEAD, startCommand: "x" } };
  assert.equal(guard(fx, { noPane }).status, 3);
  assert.match(guard(fx, { noPane }).stderr, /invalid root pane/);

  const dead = goneHostRecord(fx);
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

  // The scan is bounded: an oversized state dir is a refusal, never a partial allow.
  const many = stateCase(fx, {}, "many");
  for (let i = 0; i < 201; i++) writeRecord(join(many.dir, "r" + i + "-manifest.json"), { cwd: fx.dir });
  const manyResult = runGuard(fx, ["--check-stopped", fx.dir], { PI_CODING_AGENT_DIR: many.agentDir });
  assert.equal(manyResult.status, 3);
  assert.match(manyResult.stderr, /too many records/);
});

test("--check-stopped requires pid proof even when the server or session is gone", async (t) => {
  const fx = await fixture(t);
  const gone = goneHostRecord(fx);
  assert.equal(guard(fx, { gone }).status, 0);
  assert.equal(guard(fx, { gone: { ...gone, rootPane: { ...gone.rootPane, panePid: process.pid } } }).status, 3);
  assert.equal(guard(fx, { gone: { ...gone, rootPane: { ...gone.rootPane, panePid: 1 } } }).status, 3, "EPERM is not gone");
  assert.equal(guard(fx, { gone: { ...gone, mindPid: process.pid } }).status, 3);
  assert.equal(guard(fx, { gone: { ...gone, launcherPid: process.pid } }).status, 3);
  assert.equal(guard(fx, {
    gone: { ...gone, workerPanes: { w0: { paneId: "%97", panePid: process.pid, startCommand: "x" } } },
  }).status, 3);

  // A live server whose recorded session is gone: dead pids permit removal.
  const sessionGone = { ...gone, server: fx.base.server, session: { id: "$99", created: 1 }, state: "stopped" };
  assert.equal(guard(fx, { sessionGone }).status, 0);
  assert.equal(guard(fx, {
    sessionGone: { ...sessionGone, workerPanes: { w0: { paneId: "%97", panePid: process.pid, startCommand: "x" } } },
  }).status, 3, "a live recorded worker pid blocks even with the session gone");
});

test("a v3 record without its identity refuses before any proof of absence", async (t) => {
  const fx = await fixture(t);
  const dead = goneHostRecord(fx);
  assert.equal(guard(fx, { valid: dead }).status, 0, "the same record with its identity is safe");

  const strip = (key) => {
    const record = { ...dead };
    delete record[key];
    return record;
  };
  const variants = {
    ownerless: strip("owner"),
    runless: strip("run"),
    generationless: strip("generation"),
    "no-workerPanes": strip("workerPanes"),
    "zero-generation": { ...dead, generation: 0 },
    "fractional-generation": { ...dead, generation: 1.5 },
    "array-workerPanes": { ...dead, workerPanes: [] },
    "string-workerPanes": { ...dead, workerPanes: "none" },
    "junk-workerWindow": { ...dead, workerWindow: "workers" },
    "underscore-workerWindow": { ...dead, workerWindow: "@x" },
    "undefined-workerWindow": strip("workerWindow"),
    "empty-owner": { ...dead, owner: "" },
  };
  for (const [name, record] of Object.entries(variants)) {
    const result = guard(fx, { [name]: record });
    assert.equal(result.status, 3, name + ": " + result.stderr);
    assert.match(result.stderr, /invalid (owner|run|generation|workerPanes|workerWindow)/, name);
  }

  // The review repro: a live marked pane plus a record whose identity was
  // stripped. Before the fix this record read as "stopped" because no pane could
  // match an undefined owner; it must now refuse on the record alone.
  const worker = fx.newPane();
  fx.mark(worker.paneId, { "@mind.owner": "owner-a", "@mind.run": "run-a", "@mind.generation": "1" });
  const repro = { ...goneHostRecord(fx), server: fx.base.server, session: fx.base.session, state: "stopped" };
  delete repro.owner;
  const reproResult = guard(fx, { repro });
  assert.equal(reproResult.status, 3, reproResult.stderr);
  assert.match(reproResult.stderr, /invalid owner/);
  assert.equal(fx.paneIds().includes(worker.paneId), true, "the guard never touches the pane");
});

test("a live owned pane still blocks when its @mind.worker label was cleared", async (t) => {
  const fx = await fixture(t);
  const worker = fx.newPane();
  // The retired backend always wrote all four markers; identity is owner/run/
  // generation, so a cleared worker label must not hide the pane.
  fx.mark(worker.paneId, { "@mind.owner": "owner-a", "@mind.run": "run-a", "@mind.generation": "1" });

  const record = {
    ...goneHostRecord(fx),
    server: fx.base.server,
    session: fx.base.session,
    rootPane: { paneId: "%98", panePid: DEAD, startCommand: "gone" },
    workerWindow: null,
    workerPanes: {},
    state: "stopped",
  };
  const result = guard(fx, { record });
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /owned worker panes live: %[0-9]+/);
  assert.equal(fx.paneIds().includes(worker.paneId), true, "the guard never kills the pane");
});

test("an inherited TMUX never redirects the recorded server", async (t) => {
  const recorded = await fixture(t);
  const hostile = await fixture(t);

  // A pool-looking pane on another private server: only a wrong selector can see it.
  const foreign = hostile.newPane();
  hostile.mark(foreign.paneId, { "@mind.owner": "owner-a", "@mind.run": "run-a", "@mind.generation": "1" });

  const record = {
    ...goneHostRecord(recorded),
    server: recorded.base.server,
    session: recorded.base.session,
    rootPane: { paneId: "%98", panePid: DEAD, startCommand: "gone" },
    workerWindow: null,
    workerPanes: {},
    state: "stopped",
  };
  const plain = guard(recorded, { record });
  assert.equal(plain.status, 0, plain.stderr);

  const redirected = runGuard(recorded, ["--check-stopped", recorded.dir], {
    PI_CODING_AGENT_DIR: plain.agentDir,
    TMUX: hostile.socket + ",1,0",
    TMUX_PANE: foreign.paneId,
  });
  assert.equal(redirected.status, 0, "the recorded -S socket is the only selector: " + redirected.stderr);
});

test("only a proven absence is gone: permission and unknown tmux errors refuse", async (t) => {
  const fx = await fixture(t);
  const dead = {
    ...goneHostRecord(fx),
    server: fx.base.server,
    session: fx.base.session,
    rootPane: { paneId: "%98", panePid: DEAD, startCommand: "gone" },
    workerWindow: null,
    workerPanes: {},
    state: "stopped",
  };
  const state = stateCase(fx, { record: dead }, "faketmux");
  const fakeDir = mkdtempSync(join(fx.dir, "fake-"));
  const fake = (name, message) => {
    const path = join(fakeDir, name);
    const quoted = "'" + message.replace(/'/g, "'\\''") + "'";
    writeFileSync(path, "#!/bin/sh\nprintf '%s\\n' " + quoted + " >&2\nexit 1\n");
    chmodSync(path, 0o755);
    return path;
  };
  const runFake = (bin) =>
    runGuard(fx, ["--check-stopped", fx.dir], { PI_CODING_AGENT_DIR: state.agentDir, PI_TMUX_BIN: bin });

  // Permission denied, a non-socket path, a client-context complaint and any
  // unknown failure are unreadable evidence: a live pool may be behind them.
  for (const [name, message] of [
    ["eacces", "error connecting to /tmp/x (Permission denied)"],
    ["enotsock", "error connecting to /tmp/x (Socket operation on non-socket)"],
    ["clientless", "no current client"],
    ["weird", "tmux: something unexpected"],
  ]) {
    const result = runFake(fake(name, message));
    assert.equal(result.status, 3, name + ": " + result.stderr);
    assert.equal(result.stdout, "", name + ": stdout is quiet");
    assert.match(result.stderr, /unreadable live state/, name);
  }

  // Only a genuine absence counts as gone.
  for (const [name, message] of [
    ["enoent", "error connecting to /tmp/x (No such file or directory)"],
    ["refused", "error connecting to /tmp/x (Connection refused)"],
    ["noserver", "no server running on /tmp/x"],
    ["missingtarget", "can't find session: $9"],
  ]) {
    const result = runFake(fake(name, message));
    assert.equal(result.status, 0, name + ": " + result.stderr);
    assert.match(result.stderr, /stopped/, name);
  }

  // An absent or non-executable tmux proves nothing and must refuse.
  const missing = runFake(join(fx.dir, "no-such-tmux"));
  assert.equal(missing.status, 3, missing.stderr);
  assert.match(missing.stderr, /unreadable live state/);
  const noExec = join(fakeDir, "noexec");
  writeFileSync(noExec, "#!/bin/sh\nexit 0\n");
  chmodSync(noExec, 0o644);
  const notExecutable = runFake(noExec);
  assert.equal(notExecutable.status, 3, notExecutable.stderr);
  assert.match(notExecutable.stderr, /unreadable live state/);
});

test("the agent dir is normalized like the launcher and the retired modes are refused", async (t) => {
  const fx = await fixture(t);

  // A literal "~/" expands; the relocated dir is the only state source.
  const relocated = join(fx.dir, "relocated-agent");
  mkdirSync(join(relocated, "mindworker"), { recursive: true });
  writeRecord(join(relocated, "mindworker", "live-manifest.json"), fx.base);
  const tilde = runGuard(fx, ["--check-stopped", fx.dir], { PI_CODING_AGENT_DIR: "~/relocated-agent" });
  assert.equal(tilde.status, 3, tilde.stderr);
  assert.match(tilde.stderr, /alive|root live|owned worker panes/);

  const empty = join(fx.dir, "empty-agent");
  mkdirSync(empty, { recursive: true });
  const none = runGuard(fx, ["--check-stopped", fx.dir], { PI_CODING_AGENT_DIR: empty });
  assert.equal(none.status, 0, none.stderr);

  // A relative or file:// agent dir refuses before any scan.
  for (const value of ["relative/agent", "file:///tmp/agent"]) {
    const refused = runGuard(fx, ["--check-stopped", fx.dir], { PI_CODING_AGENT_DIR: value });
    assert.equal(refused.status, 1, refused.stderr);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /PI_CODING_AGENT_DIR must be an absolute path/);
  }

  // Usage: only --check-stopped remains; the retired modes are named.
  const noArgs = runGuard(fx, []);
  assert.equal(noArgs.status, 2);
  assert.equal(noArgs.stdout, "");
  assert.match(noArgs.stderr, /--check-stopped/);

  for (const args of [
    ["--cleanup", "--record", "/x", "--owner", "o", "--run", "r", "--generation", "1"],
    ["--locate-root", fx.dir, "--session", "$0", "--socket", fx.socket, "--server-pid", "1"],
    ["--backend", "tmux"],
    ["--reset"],
  ]) {
    const retired = runGuard(fx, args);
    assert.equal(retired.status, 2, retired.stderr);
    assert.equal(retired.stdout, "");
    assert.match(retired.stderr, /only the read-only --check-stopped guard remains/);
  }
  assert.match(runGuard(fx, ["--cleanup"]).stderr, /--cleanup/);
  assert.match(runGuard(fx, ["--locate-root", fx.dir]).stderr, /--locate-root/);
  const extra = runGuard(fx, ["--check-stopped", fx.dir, "extra"]);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /takes exactly one path/);

  const badPath = runGuard(fx, ["--check-stopped", "relative"]);
  assert.equal(badPath.status, 3);
  assert.equal(badPath.stdout, "");
  assert.match(badPath.stderr, /invalid root/);

  // A malformed state dir (a file where the dir belongs) is a refusal, not an allow.
  const notADir = join(fx.dir, "agent-file");
  writeFileSync(notADir, "not a directory");
  const unreadable = runGuard(fx, ["--check-stopped", fx.dir], { PI_CODING_AGENT_DIR: notADir });
  assert.equal(unreadable.status, 3, unreadable.stderr);
  assert.equal(unreadable.stdout, "");
  assert.match(unreadable.stderr, /refused/);
});
