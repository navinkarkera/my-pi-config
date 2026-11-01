// hc-terminal.test.mjs — contract tests for the hc worker helper.
// All hc calls go to a fake binary in a temporary directory; no user core.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HcError, coreIdentity, getTerminal, isOwnedTerminal, probeCoreIdentity,
  retireWorkerTerminal, spawnWorkerTerminal, workerTerminalName,
} from "../hc-terminal.mjs";

const WORKER_ENV = {
  PI_MIND_WORKER_ROLE: "worker",
  PI_MIND_WORKER_TIER: "flash",
  PI_MIND_WORKER_ID: "worker-0",
  PI_MIND_WORKER_GENERATION: "3",
  PI_MIND_WORKER_SESSION_DIR: "/tmp/sessions/worker-0",
};

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readState(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

/**
 * Fake hc. Modes are selected with FAKE_HC_MODE; every invocation logs argv
 * and the three env values that matter for selector pinning.
 */
function fakeHc(t, { mode = "", address = "t42", rootState = "live" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hc-terminal-test-"));
  const log = join(root, "hc.jsonl");
  const state = join(root, "state.json");
  const bin = join(root, "hc");
  writeState(state, { terminals: [], statusCalls: 0 });
  const script = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const log = process.env.FAKE_HC_LOG;",
    "fs.appendFileSync(log, JSON.stringify({ args, env: { HC_SESSION: process.env.HC_SESSION ?? null, HC_SOCKET: process.env.HC_SOCKET ?? null, FAKE_CORE_ID: process.env.FAKE_CORE_ID ?? null } }) + '\\n');",
    "const statePath = process.env.FAKE_HC_STATE;",
    "const read = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { terminals: [], statusCalls: 0 }; } };",
    "const write = (value) => fs.writeFileSync(statePath, JSON.stringify(value));",
    "const out = (value) => process.stdout.write(JSON.stringify(value));",
    "const fail = (kind, message, code = 1) => { process.stderr.write(JSON.stringify({ error: { kind, message } })); process.exit(code); };",
    "const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };",
    "const mode = process.env.FAKE_HC_MODE || '';",
    "const state = read();",
    "const address = process.env.FAKE_HC_ADDRESS || 't42';",
    "const find = (addr) => state.terminals.find((t) => t.address === addr);",
    "if (args[0] === 'server' && args[1] === 'status') {",
    "  state.statusCalls = (state.statusCalls || 0) + 1; write(state);",
    "  if (mode === 'status-fail') fail('unavailable', 'core unavailable', 5);",
    "  if (mode === 'status-malformed') { out({ core: {} }); process.exit(0); }",
    "  const id = mode === 'status-switch' ? (state.statusCalls <= 2 ? 'core-old' : 'core-new') : (process.env.FAKE_CORE_ID || 'core-1');",
    "  out({ core: { id, name: 'probe-host' }, version: '0.1.16' });",
    "} else if (args[0] === 'run') {",
    "  const name = value('--name'); const parent = value('--parent');",
    "  if (mode === 'name-taken') fail('name_taken', 'name taken', 1);",
    "  if (mode === 'blocked') fail('blocked', 'auth blocked', 9);",
    "  const record = { address, name, parent: mode === 'missing-parent-wrong' ? 't99' : parent, state: 'live' };",
    "  state.terminals.push(record); write(state);",
    "  if (mode === 'sleep') { setTimeout(() => out(record), 30000); }",
    "  else if (mode === 'no-address') out({ ok: true });",
    "  else if (mode === 'bad-json') process.stdout.write('not json');",
    "  else if (mode === 'wrong-parent') out({ ...record, parent: 't99' });",
    "  else if (mode === 'missing-parent' || mode === 'missing-parent-wrong') out({ address, name, state: 'live' });",
    "  else out(record);",
    "} else if (args[0] === 'get') {",
    "  if (mode === 'get-error') fail('unavailable', 'core unavailable', 5);",
    "  if (mode === 'get-code3-no-kind') { process.stderr.write(JSON.stringify({ error: { message: 'no terminal' } })); process.exit(3); }",
    "  if (mode === 'get-machine-unknown') fail('machine_unknown', 'no machine', 3);",
    "  if (mode === 'get-null') { process.stdout.write('null'); process.exit(0); }",
    "  if (mode === 'get-array') out([]);",
    "  else if (mode === 'get-missing-state') out({ address: args[1] });",
    "  else if (mode === 'get-bad-state') out({ address: args[1], state: 'unknown' });",
    "  else if (mode === 'get-missing-address') out({ state: 'live' });",
    "  else if (mode === 'get-remote-address') out({ address: 'vps/t7', state: 'live' });",
    "  else if (args[1] === 't1') {",
    "    if (process.env.FAKE_HC_ROOT_STATE === 'missing') fail('not_found', 'no root terminal', 3);",
    "    if (process.env.FAKE_HC_ROOT_STATE === 'unknown-state') out({ address: 't1', state: 'bogus', parent: null });",
    "    else if (process.env.FAKE_HC_ROOT_STATE === 'missing-parent') out({ address: 't1', state: 'live' });",
    "    else if (process.env.FAKE_HC_ROOT_STATE === 'parent') out({ address: 't1', state: 'live', parent: 't99' });",
    "    else out({ address: 't1', state: process.env.FAKE_HC_ROOT_STATE || 'live', parent: null });",
    "  } else {",
    "    const record = find(args[1]);",
    "    if (!record) fail('not_found', 'no terminal ' + args[1], 3);",
    "    if (mode === 'kill-live') { out(record); }",
    "    else if (mode === 'kill-later') {",
    "      state.getCount = (state.getCount ?? 1) - 1;",
    "      if (state.getCount <= 0) { state.terminals = state.terminals.filter((t) => t.address !== args[1]); write(state); fail('not_found', 'no terminal ' + args[1], 3); }",
    "      write(state); out(record);",
    "    } else out(record);",
    "  }",
    "} else if (args[0] === 'kill') {",
    "  if (mode === 'kill-fail') fail('status_mismatch', 'terminal moved on', 10);",
    "  if (mode === 'kill-machine-unknown') fail('machine_unknown', 'no machine', 3);",
    "  const record = find(args[1]);",
    "  if (mode === 'kill-notfound') { state.terminals = state.terminals.filter((t) => t.address !== args[1]); write(state); fail('not_found', args[1] + ' was removed', 3); }",
    "  if (!record) fail('not_found', 'no terminal ' + args[1], 3);",
    "  if (mode === 'kill-live') { write(state); out({ ...record, state: 'finished' }); }",
    "  else if (mode === 'kill-later') { state.getCount = 2; write(state); out({ ...record, state: 'finished' }); }",
    "  else { record.state = 'finished'; write(state); out(record); }",
    "} else if (args[0] === 'ls') {",
    "  if (process.env.FAKE_HC_LS_FAIL === '1') fail('unavailable', 'core unavailable', 5);",
    "  if (process.env.FAKE_HC_LS_EMPTY === '1') out({ terminals: [] });",
    "  else out({ terminals: state.terminals });",
    "} else fail('unknown', 'unexpected op ' + args[0], 1);",
  ].join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const env = {
    PATH: process.env.PATH,
    FAKE_HC_LOG: log,
    FAKE_HC_STATE: state,
    FAKE_HC_MODE: mode,
    FAKE_HC_ADDRESS: address,
    FAKE_HC_ROOT_STATE: rootState,
    FAKE_HC_LS_FAIL: "0",
    FAKE_HC_LS_EMPTY: "0",
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { bin, log, state, root, env };
}

function spawnOptions(fake, overrides = {}) {
  return {
    hcBin: fake.bin,
    clientEnv: { ...fake.env, HC_SESSION: "test-session", FAKE_CORE_ID: "core-1" },
    rootAddress: "t1",
    name: "run1-w0",
    cwd: "/tmp/project",
    argv: ["/usr/bin/mise", "x", "node@26", "--", "/opt/pi", "--model", "vendor/m"],
    env: WORKER_ENV,
    ...overrides,
  };
}

test("probeCoreIdentity requires a selector and reads the authoritative core", async (t) => {
  const fake = fakeHc(t);
  const env = { ...fake.env, HC_SESSION: "probe-session", FAKE_CORE_ID: "core-abc" };
  assert.deepEqual(await probeCoreIdentity({ hcBin: fake.bin, env }), {
    id: "core-abc", name: "probe-host", version: "0.1.16",
    session: "probe-session", socket: null,
  });

  const socketEnv = { ...fake.env, HC_SOCKET: "/run/hc.sock", FAKE_CORE_ID: "core-socket" };
  assert.deepEqual(await probeCoreIdentity({ hcBin: fake.bin, env: socketEnv }), {
    id: "core-socket", name: "probe-host", version: "0.1.16",
    session: null, socket: "/run/hc.sock",
  });

  const before = readJsonl(fake.log).length;
  await assert.rejects(
    probeCoreIdentity({ hcBin: fake.bin, env: { ...fake.env, HC_SCOPE: "t1-123" } }),
    /HC_SESSION or HC_SOCKET/,
  );
  assert.equal(readJsonl(fake.log).length, before, "no query without a core selector");

  const malformed = fakeHc(t, { mode: "status-malformed" });
  await assert.rejects(
    probeCoreIdentity({ hcBin: malformed.bin, env: { ...malformed.env, HC_SESSION: "s" } }),
    /no usable core identity/,
  );
});

test("coreIdentity remains a selector snapshot only", () => {
  assert.deepEqual(coreIdentity({}), {
    socket: null, terminalSocket: null, session: null, scope: null,
  });
  assert.deepEqual(
    coreIdentity({
      HC_SOCKET: "/run/hc.sock",
      HC_TERMINAL_SOCKET: "/run/terminal.sock",
      HC_SESSION: "projects",
      HC_SCOPE: "t1-123",
    }),
    {
      socket: "/run/hc.sock",
      terminalSocket: "/run/terminal.sock",
      session: "projects",
      scope: "t1-123",
    },
  );
  assert.deepEqual(coreIdentity({ HC_SOCKET: 42 }), {
    socket: null, terminalSocket: null, session: null, scope: null,
  });
});

test("workerTerminalName keeps the role and index, supports indexes above 99", () => {
  assert.equal(workerTerminalName("m7f3a2c9", "worker", 0), "m7f3a2c9-w0");
  assert.equal(workerTerminalName("m7f3a2c9", "static", 11), "m7f3a2c9-w11");
  assert.equal(workerTerminalName("m7f3a2c9", "burst", 100), "m7f3a2c9-b100");
  assert.equal(workerTerminalName("m7f3a2c9", "flash", 1000), "m7f3a2c9-b1000");
  assert.equal(workerTerminalName("run-1", "reviewer", 2), "run1-reviewer2");
  for (const name of [
    workerTerminalName("abc", "worker", 0),
    workerTerminalName("r".repeat(30), "worker", 123456789),
    workerTerminalName("run", "reviewer", 1000),
  ]) {
    assert.match(name, /^[a-z0-9][a-z0-9._-]{0,31}$/);
    assert.ok(name.length <= 32);
  }
  assert.throws(() => workerTerminalName("", "worker", 0), HcError);
  assert.throws(() => workerTerminalName("abc", "worker", -1), HcError);
  assert.throws(() => workerTerminalName("abc", "worker", 1.5), HcError);
  assert.throws(() => workerTerminalName("abc", "!!!", 0), HcError);
  assert.throws(() => workerTerminalName("run", "r".repeat(30), 100), /does not fit/);
});

test("isOwnedTerminal is a parent predicate only", () => {
  assert.equal(isOwnedTerminal({ parent: "t1" }, "t1"), true);
  assert.equal(isOwnedTerminal({ parent: "t2" }, "t1"), false);
  assert.equal(isOwnedTerminal({ parent: null }, "t1"), false);
  assert.equal(isOwnedTerminal(null, "t1"), false);
  assert.equal(isOwnedTerminal({ parent: "t1" }, ""), false);
});

test("spawnWorkerTerminal builds argv-only hc run with identity env only", async (t) => {
  const fake = fakeHc(t);
  const argv = ["/usr/bin/mise", "x", "node@26", "--", "/opt/pi with space", "--model", "vendor/m"];
  const result = await spawnWorkerTerminal(spawnOptions(fake, {
    argv,
    cwd: "/home/navin/project with space",
  }));
  assert.deepEqual(result, { address: "t42", coreId: null });
  const calls = readJsonl(fake.log);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["get", "t1", "--json"]);
  assert.deepEqual(calls[1].args, [
    "run", "--bg", "--json", "--no-notify", "--rm",
    "--parent", "t1",
    "--name", "run1-w0",
    "--cwd", "/home/navin/project with space",
    "--", "/usr/bin/env",
    "PI_MIND_WORKER_ROLE=worker",
    "PI_MIND_WORKER_TIER=flash",
    "PI_MIND_WORKER_ID=worker-0",
    "PI_MIND_WORKER_GENERATION=3",
    "PI_MIND_WORKER_SESSION_DIR=/tmp/sessions/worker-0",
    ...argv,
  ]);
});

test("spawnWorkerTerminal refuses non-identity env and never leaks a sentinel", async (t) => {
  const fake = fakeHc(t);
  const options = spawnOptions(fake);
  await assert.rejects(
    spawnWorkerTerminal({ ...options, env: { ...WORKER_ENV, SECRET: "s3cr3t" } }),
    /refusing to pass SECRET/,
  );
  await assert.rejects(
    spawnWorkerTerminal({ ...options, env: { ...WORKER_ENV, HC_TERMINAL_ID: "t2" } }),
    /refusing to pass HC_TERMINAL_ID/,
  );
  await assert.rejects(
    spawnWorkerTerminal({ ...options, env: { ...WORKER_ENV, PI_MIND_WORKER_ROLE: "two\nlines" } }),
    /one line/,
  );
  assert.deepEqual(readJsonl(fake.log), [], "a refused spawn never reaches hc");

  process.env.HC_TEST_SECRET = "s3cr3t-sentinel";
  t.after(() => { delete process.env.HC_TEST_SECRET; });
  await spawnWorkerTerminal(options);
  assert.ok(!readFileSync(fake.log, "utf8").includes("s3cr3t-sentinel"));
});

test("spawnWorkerTerminal validates names, absolute argv and core-local addresses", async (t) => {
  const fake = fakeHc(t);
  const base = spawnOptions(fake);
  await assert.rejects(spawnWorkerTerminal({ ...base, rootAddress: "vps/t1" }), /core-local/);
  await assert.rejects(spawnWorkerTerminal({ ...base, name: "-worker" }), /worker name/);
  await assert.rejects(spawnWorkerTerminal({ ...base, name: ".worker" }), /worker name/);
  await assert.rejects(spawnWorkerTerminal({ ...base, name: "_worker" }), /worker name/);
  await assert.rejects(spawnWorkerTerminal({ ...base, name: "Bad Name" }), /worker name/);
  await assert.rejects(spawnWorkerTerminal({ ...base, name: "x".repeat(33) }), /worker name/);
  await assert.rejects(spawnWorkerTerminal({ ...base, cwd: "relative" }), /absolute path/);
  await assert.rejects(spawnWorkerTerminal({ ...base, argv: [] }), /non-empty array/);
  await assert.rejects(spawnWorkerTerminal({ ...base, argv: ["/bin/pi", 7] }), /non-empty array/);
  await assert.rejects(spawnWorkerTerminal({ ...base, argv: ["pi"] }), /absolute program path/);
  await assert.rejects(getTerminal("vps/t7", { env: fake.env, hcBin: fake.bin }), /core-local/);
  await assert.rejects(retireWorkerTerminal("vps/t7", { env: fake.env, hcBin: fake.bin }), /core-local/);
  assert.deepEqual(readJsonl(fake.log), []);

  const remote = fakeHc(t, { address: "vps/t9" });
  await assert.rejects(
    spawnWorkerTerminal(spawnOptions(remote)),
    (err) => err instanceof HcError && err.spawnPending === true,
  );
  assert.equal(readJsonl(remote.log).filter((call) => call.args[0] === "kill").length, 0);
});

test("spawnWorkerTerminal refuses to spawn under a non-live or non-parentless root", async (t) => {
  const cases = [
    { rootState: "finished", match: /non-live/ },
    { rootState: "missing", match: /gone/ },
    { rootState: "parent", match: /non-parentless/ },
    { rootState: "missing-parent", match: /non-parentless/ },
    { rootState: "unknown-state", match: /malformed terminal record/ },
  ];
  for (const entry of cases) {
    const fake = fakeHc(t, { rootState: entry.rootState });
    await assert.rejects(
      spawnWorkerTerminal(spawnOptions(fake)),
      entry.match,
    );
    assert.deepEqual(
      readJsonl(fake.log).map((call) => call.args[0]),
      ["get"],
      `root ${entry.rootState} must fail before hc run`,
    );
  }
});

test("spawnWorkerTerminal fetches a missing parent and fails closed on a wrong one", async (t) => {
  const missing = fakeHc(t, { mode: "missing-parent" });
  const ok = await spawnWorkerTerminal(spawnOptions(missing));
  assert.deepEqual(ok, { address: "t42", coreId: null });
  assert.equal(readState(missing.state).terminals[0].parent, "t1");

  const wrong = fakeHc(t, { mode: "missing-parent-wrong" });
  await assert.rejects(
    spawnWorkerTerminal(spawnOptions(wrong)),
    /not t1/,
  );
  assert.equal(readJsonl(wrong.log).filter((call) => call.args[0] === "kill").length, 0);

  const explicit = fakeHc(t, { mode: "wrong-parent" });
  await assert.rejects(
    spawnWorkerTerminal(spawnOptions(explicit)),
    /not t1/,
  );
  assert.equal(readJsonl(explicit.log).filter((call) => call.args[0] === "kill").length, 0);
});

test("spawn timeout reconciles by name and retires only the owned terminal", async (t) => {
  const fake = fakeHc(t, { mode: "sleep" });
  await assert.rejects(
    spawnWorkerTerminal(spawnOptions(fake, { timeoutMs: 300 })),
    (err) => {
      assert.ok(err instanceof HcError);
      assert.equal(err.spawnPending, false, "a known created-and-retired terminal is not pending");
      assert.match(err.message, /timed out/);
      return true;
    },
  );
  const calls = readJsonl(fake.log).map((call) => call.args);
  assert.ok(calls.some((args) => args[0] === "run"));
  assert.ok(calls.some((args) => args[0] === "ls"));
  assert.ok(calls.some((args) => args[0] === "kill"));
  assert.ok(readState(fake.state).terminals.every((record) => record.state === "finished"));
});

test("spawn timeout with an unprovable list reports spawnPending metadata", async (t) => {
  process.env.HC_TEST_SECRET = "s3cr3t-sentinel";
  t.after(() => { delete process.env.HC_TEST_SECRET; });
  const fake = fakeHc(t, { mode: "sleep" });
  fake.env.FAKE_HC_LS_FAIL = "1";
  await assert.rejects(
    spawnWorkerTerminal(spawnOptions(fake, { timeoutMs: 300 })),
    (err) => {
      assert.ok(err instanceof HcError);
      assert.equal(err.spawnPending, true);
      assert.equal(err.terminalName, "run1-w0");
      assert.equal(err.rootAddress, "t1");
      assert.ok(!JSON.stringify(err).includes("s3cr3t"));
      return true;
    },
  );
  assert.equal(readJsonl(fake.log).filter((call) => call.args[0] === "kill").length, 0);
});

test("name_taken is deterministic and never reconciles or kills the existing terminal", async (t) => {
  const fake = fakeHc(t, { mode: "name-taken" });
  await assert.rejects(
    spawnWorkerTerminal(spawnOptions(fake)),
    (err) => err instanceof HcError && err.kind === "name_taken" && err.spawnPending === false,
  );
  assert.deepEqual(readJsonl(fake.log).map((call) => call.args[0]), ["get", "run"]);
  assert.deepEqual(readState(fake.state).terminals, []);
});

test("malformed run replies reconcile when creation may have happened", async (t) => {
  const noAddress = fakeHc(t, { mode: "no-address" });
  await assert.rejects(spawnWorkerTerminal(spawnOptions(noAddress)), /no usable address/);
  assert.ok(readJsonl(noAddress.log).some((call) => call.args[0] === "kill"));
  assert.ok(readState(noAddress.state).terminals.every((record) => record.state === "finished"));

  const badJson = fakeHc(t, { mode: "bad-json" });
  await assert.rejects(spawnWorkerTerminal(spawnOptions(badJson)), /unreadable JSON/);
  assert.ok(readJsonl(badJson.log).some((call) => call.args[0] === "kill"));

  const blocked = fakeHc(t, { mode: "blocked" });
  await assert.rejects(
    spawnWorkerTerminal(spawnOptions(blocked)),
    (err) => err instanceof HcError && err.kind === "blocked" && err.spawnPending === false,
  );
  assert.deepEqual(readJsonl(blocked.log).map((call) => call.args[0]), ["get", "run"]);
});

test("an empty first lookup after a timeout still keeps the spawn pending", async (t) => {
  const fake = fakeHc(t, { mode: "sleep" });
  fake.env.FAKE_HC_LS_EMPTY = "1";
  await assert.rejects(
    spawnWorkerTerminal(spawnOptions(fake, { timeoutMs: 300 })),
    (err) => {
      assert.ok(err instanceof HcError);
      assert.equal(err.spawnPending, true);
      assert.equal(err.terminalName, "run1-w0");
      assert.equal(err.rootAddress, "t1");
      return true;
    },
  );
  assert.equal(readJsonl(fake.log).filter((call) => call.args[0] === "kill").length, 0);

  // The server may finish the in-flight request after our one list snapshot.
  const state = readState(fake.state);
  state.terminals.push({ address: "t42", name: "run1-w0", parent: "t1", state: "live" });
  writeState(fake.state, state);
  assert.equal(readState(fake.state).terminals[0].name, "run1-w0");
});

test("getTerminal fails closed on malformed terminal records", async (t) => {
  for (const mode of [
    "get-null", "get-array", "get-missing-state", "get-bad-state",
    "get-missing-address", "get-remote-address",
  ]) {
    const fake = fakeHc(t, { mode });
    await assert.rejects(
      getTerminal("t7", { env: fake.env, hcBin: fake.bin }),
      (err) => err instanceof HcError && err.kind === "malformed_reply",
      mode,
    );
  }
});

test("retireWorkerTerminal confirms gone after a successful kill", async (t) => {
  const fake = fakeHc(t, { mode: "kill-later" });
  writeState(fake.state, { terminals: [{ address: "t42", name: "run1-w0", parent: "t1", state: "live" }], statusCalls: 0 });
  await retireWorkerTerminal("t42", { env: fake.env, hcBin: fake.bin, goneTimeoutMs: 500, pollMs: 20 });
  const calls = readJsonl(fake.log).map((call) => call.args[0]);
  assert.deepEqual(calls, ["kill", "get", "get"]);
  assert.deepEqual(readState(fake.state).terminals, []);
});

test("retireWorkerTerminal treats a first-kill not_found as success and still confirms", async (t) => {
  const fake = fakeHc(t, { mode: "kill-notfound" });
  writeState(fake.state, { terminals: [{ address: "t42", name: "run1-w0", parent: "t1", state: "live" }], statusCalls: 0 });
  assert.deepEqual(await retireWorkerTerminal("t42", { env: fake.env, hcBin: fake.bin }), { retired: true });
  assert.deepEqual(readJsonl(fake.log).map((call) => call.args[0]), ["kill", "get"]);
});

test("retireWorkerTerminal is bounded when the terminal never goes away", async (t) => {
  const fake = fakeHc(t, { mode: "kill-live" });
  writeState(fake.state, { terminals: [{ address: "t42", name: "run1-w0", parent: "t1", state: "live" }], statusCalls: 0 });
  await assert.rejects(
    retireWorkerTerminal("t42", { env: fake.env, hcBin: fake.bin, goneTimeoutMs: 120, pollMs: 20 }),
    /still live/,
  );
  const calls = readJsonl(fake.log).map((call) => call.args[0]);
  assert.ok(calls.filter((name) => name === "get").length >= 2);
});

test("retireWorkerTerminal keeps errors tracked and never kills a wrong-parent record", async (t) => {
  const fail = fakeHc(t, { mode: "kill-fail" });
  writeState(fail.state, { terminals: [{ address: "t42", name: "run1-w0", parent: "t1", state: "live" }], statusCalls: 0 });
  await assert.rejects(
    retireWorkerTerminal("t42", { env: fail.env, hcBin: fail.bin }),
    (err) => err instanceof HcError && err.kind === "status_mismatch" && err.code === 10,
  );

  const unknown = fakeHc(t, { mode: "kill-machine-unknown" });
  writeState(unknown.state, { terminals: [{ address: "t42", name: "run1-w0", parent: "t1", state: "live" }], statusCalls: 0 });
  await assert.rejects(
    retireWorkerTerminal("t42", { env: unknown.env, hcBin: unknown.bin }),
    (err) => err instanceof HcError && err.kind === "machine_unknown" && err.code === 3,
  );

  const wrong = fakeHc(t);
  writeState(wrong.state, { terminals: [{ address: "t42", name: "run1-w0", parent: "t99", state: "live" }], statusCalls: 0 });
  await assert.rejects(
    retireWorkerTerminal("t42", { env: wrong.env, hcBin: wrong.bin, rootAddress: "t1" }),
    /not owned/,
  );
  assert.equal(readJsonl(wrong.log).filter((call) => call.args[0] === "kill").length, 0);
});

test("getTerminal maps only kind not_found and fails closed on unknown failures", async (t) => {
  const fake = fakeHc(t);
  writeState(fake.state, { terminals: [{ address: "t7", name: "n", parent: null, state: "live" }], statusCalls: 0 });
  assert.equal((await getTerminal("t7", { env: fake.env, hcBin: fake.bin })).address, "t7");
  assert.equal(await getTerminal("missing", { env: fake.env, hcBin: fake.bin }), null);
  await assert.rejects(getTerminal("t7", { env: fake.env, hcBin: fake.bin, rootAddress: "t1" }), /not owned/);

  const noKind = fakeHc(t, { mode: "get-code3-no-kind" });
  assert.equal(await getTerminal("t7", { env: noKind.env, hcBin: noKind.bin }), null);

  const machine = fakeHc(t, { mode: "get-machine-unknown" });
  await assert.rejects(getTerminal("t7", { env: machine.env, hcBin: machine.bin }), /machine_unknown|no machine/);

  const broken = fakeHc(t, { mode: "get-error" });
  await assert.rejects(getTerminal("t7", { env: broken.env, hcBin: broken.bin }), /unavailable/);
});

test("clientEnv is pinned across process.env changes and expectedCoreId is enforced", async (t) => {
  const fake = fakeHc(t);
  const pinned = { ...fake.env, HC_SESSION: "old-session", FAKE_CORE_ID: "core-old" };
  const result = await spawnWorkerTerminal(spawnOptions(fake, {
    clientEnv: pinned,
    expectedCoreId: "core-old",
  }));
  assert.deepEqual(result, { address: "t42", coreId: "core-old" });

  process.env.HC_SESSION = "new-session";
  t.after(() => { delete process.env.HC_SESSION; });
  await getTerminal("t42", { env: pinned, hcBin: fake.bin, expectedCoreId: "core-old" });
  await retireWorkerTerminal("t42", {
    env: pinned,
    hcBin: fake.bin,
    expectedCoreId: "core-old",
    rootAddress: "t1",
  });
  const calls = readJsonl(fake.log);
  assert.ok(calls.every((call) => call.env.HC_SESSION === "old-session"));

  const wrongCore = { ...fake.env, HC_SESSION: "old-session", FAKE_CORE_ID: "core-new" };
  const before = readJsonl(fake.log).length;
  await assert.rejects(
    getTerminal("t42", { env: wrongCore, hcBin: fake.bin, expectedCoreId: "core-old" }),
    /core mismatch/,
  );
  assert.equal(readJsonl(fake.log).length, before + 1, "only server status runs on a core mismatch");
  assert.equal(readJsonl(fake.log).at(-1).args[0], "server");

  const beforeSpawn = readJsonl(fake.log).length;
  await assert.rejects(
    spawnWorkerTerminal(spawnOptions(fake, {
      clientEnv: wrongCore,
      expectedCoreId: "core-old",
    })),
    /core mismatch/,
  );
  assert.deepEqual(
    readJsonl(fake.log).slice(beforeSpawn).map((call) => call.args[0]),
    ["server"],
    "a spawn on the wrong core never reaches hc run",
  );
});

test("a core restart during confirmation cannot turn gone into success", async (t) => {
  const fake = fakeHc(t, { mode: "status-switch" });
  writeState(fake.state, { terminals: [{ address: "t42", name: "run1-w0", parent: "t1", state: "live" }], statusCalls: 0 });
  const env = { ...fake.env, HC_SESSION: "old-session", FAKE_CORE_ID: "core-old" };
  await assert.rejects(
    retireWorkerTerminal("t42", { env, hcBin: fake.bin, expectedCoreId: "core-old", rootAddress: "t1" }),
    /core mismatch/,
  );
  const calls = readJsonl(fake.log).map((call) => call.args[0]);
  assert.deepEqual(calls, ["server", "get", "server", "kill", "get", "server"]);
});
