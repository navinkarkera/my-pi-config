// hc-real-core.test.mjs — opt-in release gate against a real, isolated herdr-core.
//
// Nothing here runs unless PI_MIND_WORKER_HC_INTEGRATION=1. Each test starts its
// own core: a unique HC_SESSION, scratch XDG dirs and HOME, no inherited HC_*
// selector or PI_MIND_WORKER_* identity, and a fake Pi on PI_BIN, so no model is
// ever called.
//
// The fake Pi plays both roles: as Mind it writes the control file, listens on the
// pair socket, reports OSC 7501 (so the root is an OSC parent) and records every
// stdin line; as a worker it handshakes and reports OSC 7501. The gate therefore
// runs the real launcher, the real hc-terminal helper and the real hc core; only
// the paid agent is faked.
//
// hc facts this gate relies on (probed on hc 0.1.16): exec keeps the root pid; a
// --rm --no-notify child reports status and leaves no record; the core reaps a
// root's children on normal exit, hc kill, SIGKILL, and a spawn racing the root's
// death; notes are typed only into an OSC-reporting parent, in the exact form
// "<hc>t2 name exited (exit 0). Read: hc read t2</hc>".
//
// Run: PI_MIND_WORKER_HC_INTEGRATION=1 mise x node@26 -- node --test lib/mind-worker/__tests__/hc-real-core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
	realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENABLED = process.env.PI_MIND_WORKER_HC_INTEGRATION === "1";
const SKIP = ENABLED ? false : "opt-in release gate: set PI_MIND_WORKER_HC_INTEGRATION=1";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(TESTS_DIR, "..");
const AGENT_DIR = resolve(MODULE_DIR, "../..");
const SPAWN_HELPER = join(MODULE_DIR, "hc-terminal.mjs");
const LAUNCHER_MODULE = join(MODULE_DIR, "hc-launcher.mjs");
const WRAPPER = join(AGENT_DIR, "bin/mind-worker-launcher");
const MISE = "/usr/bin/mise";
const HC = process.env.PI_MIND_WORKER_HC_BIN || "hc";
const HC_MIN_VERSION = [0, 1, 16];
const SENTINEL = "sentinel-do-not-pass";
const SENTINEL_SESSION = "sentinel-session-id";
const NL = String.fromCharCode(10);

// ── Fake Pi ─────────────────────────────────────────────────────────────────
// Generated per fixture. It never imports the extension: Mind needs the control
// file, socket and OSC parent hc notes require; a worker needs a handshake and an
// OSC report. Both record their own process facts for the assertions.

function fakeBaseLines() {
	const lines = [
		"#!/usr/bin/env node",
		"const fs = require('node:fs');",
		"const net = require('node:net');",
		"const path = require('node:path');",
		"const crypto = require('node:crypto');",
		"const readline = require('node:readline');",
		"const RECORDS = '__RECORDS__';",
		"const SPAWN_HELPER = '__SPAWN_HELPER__';",
		"const SHIM = '__SHIM__';",
		"const ESC = String.fromCharCode(27);",
		"const ST = ESC + String.fromCharCode(92);",
		"const NL = String.fromCharCode(10);",
		"const role = process.env.PI_MIND_WORKER_ROLE || '';",
		"const workerId = process.env.PI_MIND_WORKER_ID || '';",
		"const generation = Number(process.env.PI_MIND_WORKER_GENERATION || 0);",
		"const instance = process.env.PI_MIND_WORKER_INSTANCE || null;",
		"const cwd = process.cwd();",
		"const cwdHash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);",
		"const pairId = instance ? instance + '-' + cwdHash : cwdHash;",
		"const homeAgentDir = path.join(process.env.HOME || '', '.pi', 'agent');",
		"const pairDir = path.join(homeAgentDir, 'mindworker');",
		"const controlPath = path.join(pairDir, pairId + '-mind-control.json');",
		"const socketPath = path.join(pairDir, pairId + '.sock');",
		"function statOf(pid) {",
		"	try {",
		"		const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');",
		"		const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(' ');",
		"		return { state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]), session: Number(fields[3]), ttyNr: Number(fields[4]), tpgid: Number(fields[5]) };",
		"	} catch { return null; }",
		"}",
		"function writeRecord(name, value) { fs.writeFileSync(path.join(RECORDS, name), JSON.stringify(value, null, 2)); }",
		"function appendRecord(name, value) { fs.appendFileSync(path.join(RECORDS, name), JSON.stringify(value) + NL); }",
		"function osc(state) { return ESC + ']7501;app=pi:state=' + state + ST; }",
		"const identityKeys = Object.keys(process.env)",
		"	.filter(function (key) { return key.indexOf('PI_MIND_WORKER_') === 0; })",
		"	.sort();",
		"const base = {",
		"	pid: process.pid, ppid: process.ppid, role: role, workerId: workerId,",
		"	tier: process.env.PI_MIND_WORKER_TIER || null, generation: generation, instance: instance,",
		"	cwd: cwd, stat: statOf(process.pid),",
		"	executable: process.argv[1] || null, argv: process.argv.slice(2), identityKeys: identityKeys,",
		"	identity: {",
		"		role: process.env.PI_MIND_WORKER_ROLE || null, tier: process.env.PI_MIND_WORKER_TIER || null,",
		"		id: process.env.PI_MIND_WORKER_ID || null, generation: process.env.PI_MIND_WORKER_GENERATION || null,",
		"		sessionDir: process.env.PI_MIND_WORKER_SESSION_DIR || null, instance: process.env.PI_MIND_WORKER_INSTANCE || null,",
		"		launcherPid: process.env.PI_MIND_WORKER_LAUNCHER_PID || null,",
		"	},",
		"	hc: {",
		"		terminalId: process.env.HC_TERMINAL_ID || null, session: process.env.HC_SESSION || null,",
		"		terminalSocket: process.env.HC_TERMINAL_SOCKET || null, scope: process.env.HC_SCOPE || null,",
		"		socket: process.env.HC_SOCKET || null,",
		"	},",
		"	secret: process.env.MIND_TEST_SECRET || null,",
		"	sessionId: process.env.PI_SESSION_ID || null,",
		"};",
		"if (role === 'mind') mind();",
		"else if (role === 'worker') worker();",
		"else { writeRecord('unknown-role.json', base); process.exit(0); }",
	];
	return lines;
}

function fakeMindLines() {
	return [
		"function mind() {",
		"	let connected = 0;",
		"	writeRecord('mind.json', base);",
		"	function writeControl(status) {",
		"		try {",
		"			fs.writeFileSync(controlPath, JSON.stringify({ status: status, generation: generation, lastUpdated: Date.now(), connectedWorkers: connected }));",
		"		} catch { /* the launcher retries a half-written file */ }",
		"	}",
		"	if (process.env.GATE_MIND_EXIT0 === '1') {",
		"		writeRecord('mind-exit0.json', { pid: process.pid, code: 0 });",
		"		process.exit(0);",
		"	}",
		"	if (process.env.GATE_MIND_FAIL === '1') {",
		"		writeRecord('mind-failed.json', { pid: process.pid, code: 31 });",
		"		process.exit(31);",
		"	}",
		"	try { fs.unlinkSync(socketPath); } catch { /* absent */ }",
		"	// The root terminal must look like an agent to hc, or hc types no notes.",
		"	process.stdout.write(osc('working'));",
		"	const server = net.createServer(function (socket) {",
		"		const input = readline.createInterface({ input: socket });",
		"		input.on('line', function (line) {",
		"			let message = null;",
		"			try { message = JSON.parse(line); } catch { return; }",
		"			if (message.type !== 'handshake') return;",
		"			connected += 1;",
		"			appendRecord('handshakes.jsonl', { workerId: message.workerId, tier: message.tier, generation: message.generation });",
		"			writeControl('worker-connected');",
		"			try { socket.write(JSON.stringify({ type: 'handshake-ack' }) + NL); } catch { /* worker left */ }",
		"		});",
		"		socket.on('error', function () {});",
		"	});",
		"	server.on('error', function (error) {",
		"		writeRecord('mind-listen-error.json', { message: String((error && error.message) || error) });",
		"		process.exit(1);",
		"	});",
		"	server.listen(socketPath, function () {",
		"		writeControl('ready');",
		"		process.stdout.write(osc('idle'));",
		"	});",
		"	process.on('SIGTERM', function () { writeControl('stopped'); process.exit(0); });",
		"	// Keep the fake client alive across the root's hangup so a late completion",
		"	// can actually arrive; a real Pi would exit here.",
		"	process.on('SIGHUP', function () {});",
		"	const stdin = readline.createInterface({ input: process.stdin });",
		"	stdin.on('line', async function (line) {",
		"		appendRecord('mind-input.jsonl', line);",
		"		if (line.indexOf('exit:') === 0) {",
		"			const code = Number(line.slice(5));",
		"			try { server.close(); fs.unlinkSync(socketPath); } catch { /* ignore */ }",
		"			process.exit(Number.isFinite(code) ? code : 0);",
		"		}",
		"		if (line === 'spawn-burst') {",
		"			writeRecord('burst-started.json', { at: Date.now() });",
		"			let coreId = null;",
		"			try { coreId = JSON.parse(fs.readFileSync(path.join(pairDir, pairId + '-manifest.json'), 'utf8')).coreIdentity.id || null; } catch { /* unproven */ }",
		"			try {",
		"				const helper = await import('file://' + SPAWN_HELPER);",
		"				const sessionDir = path.join(homeAgentDir, 'sessions', 'burst-gate-0');",
		"				const result = await helper.spawnWorkerTerminal({",
		"					rootAddress: process.env.HC_TERMINAL_ID,",
		"					name: helper.workerTerminalName('gate', 'burst', 0),",
		"					cwd: cwd,",
		"					argv: ['__MISE__', 'x', 'node@26', '--', process.env.PI_BIN, '--session-dir', sessionDir],",
		"					env: {",
		"						PI_MIND_WORKER_ROLE: 'worker', PI_MIND_WORKER_TIER: 'flash',",
		"						PI_MIND_WORKER_ID: 'burst-flash-1', PI_MIND_WORKER_GENERATION: String(generation),",
		"						PI_MIND_WORKER_SESSION_DIR: sessionDir,",
		"					},",
		"					hcBin: SHIM,",
		"					clientEnv: process.env,",
		"					expectedCoreId: coreId,",
		"				});",
		"				writeRecord('burst-address.json', { address: result.address, coreId: result.coreId || null, at: Date.now() });",
		"			} catch (error) {",
		"				writeRecord('burst-error.json', { message: String((error && error.message) || error), kind: (error && error.kind) || null, at: Date.now() });",
		"			}",
		"		}",
		"	});",
		"}",
	];
}

function fakeWorkerLines() {
	return [
		"function worker() {",
		"	const sessionDir = process.env.PI_MIND_WORKER_SESSION_DIR || '';",
		"	const agentDir = path.dirname(path.dirname(sessionDir));",
		"	const workerSocket = path.join(agentDir, 'mindworker', pairId + '.sock');",
		"	writeRecord('worker-' + (workerId || 'unknown') + '.json', Object.assign({}, base, { socket: workerSocket }));",
		"	process.stdout.write(osc('working'));",
		"	process.on('SIGTERM', function () { process.exit(0); });",
		"	setTimeout(connect, 0);",
		"	function connect() {",
		"		const socket = net.createConnection(workerSocket, function () {",
		"			socket.write(JSON.stringify({",
		"				type: 'handshake', role: 'worker', workerId: workerId,",
		"				tier: process.env.PI_MIND_WORKER_TIER, generation: generation,",
		"			}) + NL);",
		"			process.stdout.write(osc('idle'));",
		"			appendRecord('worker-events.jsonl', { workerId: workerId, event: 'handshake-sent' });",
		"		});",
		"		const input = readline.createInterface({ input: socket });",
		"		input.on('line', function (line) {",
		"			let message = null;",
		"			try { message = JSON.parse(line); } catch { return; }",
		"			if (message.type === 'shutdown') process.exit(0);",
		"		});",
		"		socket.on('error', function () { /* mind may be gone; the gate checks the terminal */ });",
		"	}",
		"}",
		"",
	];
}

function fakePiSource(recordsDir, spawnHelper, shimPath) {
	return fakeBaseLines().concat(fakeMindLines(), fakeWorkerLines()).join(NL)
		.replace("__RECORDS__", recordsDir)
		.replace("__SPAWN_HELPER__", spawnHelper)
		.replace("__SHIM__", shimPath)
		.replace("__MISE__", MISE);
}

// ── hc client shim ──────────────────────────────────────────────────────────
// Runs the real hc immediately, so the terminal exists while the root is alive,
// then withholds only the JSON reply. The helper's pending promise therefore
// resolves with an address that the dead root already took away.

function shimLines() {
	return [
		"#!/usr/bin/env node",
		"const { spawnSync } = require('node:child_process');",
		"const fs = require('node:fs');",
		"const REAL = '__REAL_HC__';",
		"const RECORDS = '__RECORDS__';",
		"const args = process.argv.slice(2);",
		"process.on('SIGHUP', function () { /* survive the root's hangup to deliver the late reply */ });",
		"const write = (name, value) => fs.writeFileSync(RECORDS + '/' + name, JSON.stringify(value, null, 2));",
		"const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };",
		"const emit = (result) => {",
		"	process.stdout.write(result.stdout || '');",
		"	process.stderr.write(result.stderr || '');",
		"	process.exit(result.status === null ? 1 : result.status);",
		"};",
		"if (args[0] !== 'run') {",
		"	emit(spawnSync(REAL, args, { encoding: 'utf8', env: process.env, timeout: 30000 }));",
		"}",
		"const real = spawnSync(REAL, args, { encoding: 'utf8', env: process.env, timeout: 30000 });",
		"let record = null;",
		"try { record = JSON.parse(real.stdout); } catch { /* recorded as null below */ }",
		"write('shim-run.json', {",
		"	args: args,",
		"	code: real.status,",
		"	stderr: real.stderr || '',",
		"	address: record && record.address ? record.address : null,",
		"	name: record && record.name ? record.name : null,",
		"	selectors: {",
		"		session: process.env.HC_SESSION || null,",
		"		terminalId: process.env.HC_TERMINAL_ID || null,",
		"		terminalSocket: process.env.HC_TERMINAL_SOCKET || null,",
		"		scope: process.env.HC_SCOPE || null,",
		"	},",
		"});",
		"write('shim-created.json', { address: record && record.address ? record.address : null, at: Date.now() });",
		"const deadline = Date.now() + 15000;",
		"while (!fs.existsSync(RECORDS + '/shim-release') && Date.now() < deadline) sleep(50);",
		"write('shim-released.json', { at: Date.now(), released: fs.existsSync(RECORDS + '/shim-release') });",
		"emit(real);",
		"",
	];
}

function shimSource(realHc, recordsDir) {
	return shimLines().join(NL).replace("__REAL_HC__", realHc).replace("__RECORDS__", recordsDir);
}

// ── hc helpers ──────────────────────────────────────────────────────────────

function hc(fx, args, { allowFail = false, timeout = 40000 } = {}) {
	const result = spawnSync(HC, args, { env: fx.env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
	if (result.error) throw result.error;
	const out = { code: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
	if (out.code !== 0 && !allowFail) {
		throw new Error("hc " + args.join(" ") + " exited " + out.code + ": " + (out.stderr || out.stdout).trim());
	}
	return out;
}

function hcJson(fx, args, options) {
	const out = hc(fx, args, options);
	try { return JSON.parse(out.stdout); } catch { return null; }
}

function hcGet(fx, address) {
	const out = hc(fx, ["get", address, "--json"], { allowFail: true });
	if (out.code !== 0) return null;
	try { return JSON.parse(out.stdout); } catch { return null; }
}

function hcList(fx) {
	const listed = hcJson(fx, ["ls", "--all", "--json"]);
	assert.ok(listed && Array.isArray(listed.terminals), "hc ls --all --json must list terminals");
	return listed.terminals;
}

function hcSend(fx, address, line) {
	const out = hc(fx, ["send", address, line, "--json"], { allowFail: true });
	assert.equal(out.code, 0, "hc send to the root failed: " + out.stderr);
}

function assertHcVersion() {
	const result = spawnSync(HC, ["--version"], { encoding: "utf8", env: process.env, timeout: 15000 });
	assert.equal(result.status, 0, "hc --version must work: " + (result.stderr || "").trim());
	const text = (result.stdout || "").trim();
	const parts = (text.split(" ").pop() || "").split(".").map(Number);
	assert.equal(parts.length, 3, "hc --version must report x.y.z, got: " + text);
	assert.ok(parts.every(Number.isFinite), "hc --version must report numbers, got: " + text);
	const newer = parts[0] - HC_MIN_VERSION[0] || parts[1] - HC_MIN_VERSION[1] || parts[2] - HC_MIN_VERSION[2];
	assert.ok(newer >= 0, "gate verified against hc " + HC_MIN_VERSION.join(".") + ", found " + text);
}

function resolveRealHc() {
	if (HC.indexOf("/") !== -1) return resolve(HC);
	const found = spawnSync("sh", ["-c", "command -v " + HC], { encoding: "utf8", env: process.env, timeout: 15000 });
	const path = (found.stdout || "").trim();
	assert.ok(path.startsWith("/"), "the hc shim needs the real hc's absolute path, got " + JSON.stringify(path));
	return path;
}

function readJson(path) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function processState(pid) {
	try {
		const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
		const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(" ");
		return {
			state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]),
			session: Number(fields[3]), ttyNr: Number(fields[4]), tpgid: Number(fields[5]),
		};
	} catch { return null; }
}

function pidAlive(pid) {
	const state = processState(pid);
	return Boolean(state && state.state !== "Z");
}

async function waitFor(check, { timeout = 60000, interval = 25, label = "condition" } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await new Promise((done) => setTimeout(done, interval));
	}
	throw new Error("timed out after " + timeout + "ms waiting for " + label);
}

function sleep(ms) {
	return new Promise((done) => setTimeout(done, ms));
}

// ── Fixture: one isolated core per test ─────────────────────────────────────

function createFixture(t, { workers = 1, config = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), "mind-worker-hc-gate-"));
	const home = join(root, "home");
	const project = join(root, "project");
	const records = join(root, "records");
	// A space in the executable's own path: PI_BIN must stay one argv element.
	const fakeBin = join(root, "fake bin");
	const fakePi = join(fakeBin, "fake pi");
	const shim = join(root, "hc-shim");
	const agentDir = join(home, ".pi", "agent");
	const stateDir = join(agentDir, "mindworker");
	const runtime = join(root, "runtime");
	const configHome = join(root, "config");
	const stateHome = join(root, "state");
	const cacheHome = join(root, "cache");
	for (const dir of [home, project, records, fakeBin, agentDir, stateDir,
		join(agentDir, "sessions"), runtime, configHome, stateHome, cacheHome]) {
		mkdirSync(dir, { recursive: true });
	}
	// hc refuses a runtime dir other users could read.
	chmodSync(runtime, 0o700);

	const realHc = resolveRealHc();
	writeFileSync(fakePi, fakePiSource(records, SPAWN_HELPER, shim));
	writeFileSync(shim, shimSource(realHc, records));
	chmodSync(fakePi, 0o755);
	chmodSync(shim, 0o755);

	writeFileSync(join(agentDir, "mind-worker.json"), JSON.stringify({
		terminalBackend: "hc",
		mindModel: "vendor/mind model",
		mindThinkingLevel: "low",
		workerThinkingLevel: "max",
		workerModels: [{ model: "vendor/worker model", count: workers, tier: "flash" }],
		timeout: 30,
		dashboardEnabled: false,
		...config,
	}, null, 2));

	const session = "mw-gate-" + process.pid + "-" + randomBytes(4).toString("hex");
	const env = { ...process.env };
	// The gate may itself run inside a mind-worker session: no selectors and no
	// identity may leak into the scratch core, or the pair would join that pool.
	for (const key of Object.keys(env)) {
		if (key.indexOf("HC_") === 0 || key.indexOf("PI_MIND_WORKER_") === 0 || key.indexOf("MIND_WORKER_") === 0) delete env[key];
	}
	Object.assign(env, {
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: configHome,
		XDG_STATE_HOME: stateHome,
		XDG_CACHE_HOME: cacheHome,
		XDG_RUNTIME_DIR: runtime,
		HC_SESSION: session,
		PI_BIN: fakePi,
		PATH: fakeBin + ":" + dirname(process.execPath) + ":" + (process.env.PATH || ""),
	});
	for (const key of ["MIND_TEST_SECRET", "PI_SESSION_ID", "GATE_MIND_FAIL", "GATE_MIND_EXIT0", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SOCKET", "HC_SCOPE"]) {
		delete env[key];
	}

	const cwd = realpathSync(project);
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const fx = {
		root, home, project: cwd, fakeBin, fakePi, shim, agentDir, stateDir, records, runtime, session, env,
		manifestPath: join(stateDir, hash + "-manifest.json"),
		controlPath: join(stateDir, hash + "-mind-control.json"),
		socketPath: join(stateDir, hash + ".sock"),
		rootPidPath: join(records, "root.pid"),
		releasePath: join(records, "shim-release"),
		readManifest: () => readJson(fx.manifestPath),
		readControl: () => readJson(fx.controlPath),
		readRecord: (name) => readJson(join(records, name)),
		readdirRecords: () => readdirSync(records),
		readLines: (name) => {
			try {
				return readFileSync(join(records, name), "utf8").split(NL)
					.filter((line) => line.length > 0)
					.map((line) => {
						try { return JSON.parse(line); } catch { return line; }
					});
			} catch { return []; }
		},
		readWorkerRecords: () => readdirSync(records)
			.filter((name) => name.indexOf("worker-") === 0 && name.endsWith(".json"))
			.map((name) => readJson(join(records, name)))
			.filter(Boolean),
	};

	t.after(async () => {
		// Kill what the scratch core still lists, then the pair's own processes, then that core only.
		try {
			for (const terminal of hcList(fx)) {
				hc(fx, ["kill", terminal.address, "--json"], { allowFail: true, timeout: 15000 });
			}
		} catch { /* core already gone */ }
		const manifest = fx.readManifest();
		const rootPid = readJson(fx.rootPidPath);
		for (const pid of [manifest?.mindPid, manifest?.launcherPid, rootPid]) {
			if (Number.isSafeInteger(pid) && pidAlive(pid)) {
				try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
			}
		}
		hc(fx, ["server", "stop", "--json"], { allowFail: true, timeout: 15000 });
		try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
	});
	return fx;
}

function startRoot(fx) {
	const started = hcJson(fx, ["run", "--bg", "--json", "--no-parent", "--name", "gate-root", "--cwd", fx.project, "--", "/bin/bash"]);
	assert.ok(started && typeof started.address === "string", "hc run must return the root address");
	return started.address;
}

function writeRootExec(fx, { failMind = false, exit0 = false, terminalOnly = false } = {}) {
	const execPath = join(fx.root, "root-exec.sh");
	writeFileSync(execPath, [
		"#!/bin/bash",
		"set -u",
		"export MIND_TEST_SECRET=" + SENTINEL,
		"export PI_SESSION_ID=" + SENTINEL_SESSION,
		failMind ? "export GATE_MIND_FAIL=1" : "",
		exit0 ? "export GATE_MIND_EXIT0=1" : "",
		// An app terminal carries HC_TERMINAL_ID/HC_SCOPE/HC_TERMINAL_SOCKET. This fixture's
		// named core carries the session selector (a user's default-core terminal has none),
		// so hc injects HC_SESSION here. Drop it, leaving the terminal-scoped vars only.
		terminalOnly ? "unset HC_SESSION HC_SOCKET" : "",
		"echo $$ > " + JSON.stringify(fx.rootPidPath),
		"exec " + JSON.stringify(WRAPPER) + " --cwd " + JSON.stringify(fx.project),
		"",
	].join(NL));
	chmodSync(execPath, 0o755);
	return execPath;
}

async function bootPool(fx, { workers = 1, failMind = false, exit0 = false, terminalOnly = false } = {}) {
	const execPath = writeRootExec(fx, { failMind, exit0, terminalOnly });
	const root = startRoot(fx);
	hcSend(fx, root, "exec " + JSON.stringify(execPath));

	if (failMind || exit0) {
		const finished = await waitFor(() => {
			const record = hcGet(fx, root);
			return record && record.state === "finished" ? record : null;
		}, { label: "the root terminal to finish after the bounded startup failure" });
		return { root, rootPid: null, finished };
	}

	let ready;
	try {
		ready = await waitFor(() => {
			const manifest = fx.readManifest();
			if (!manifest || !manifest.workerAddresses) return null;
			const addresses = Object.values(manifest.workerAddresses);
			if (addresses.length < workers) return null;
			const control = fx.readControl();
			if (!control || control.status !== "worker-connected") return null;
			const live = addresses.every((address) => {
				const record = hcGet(fx, address);
				return record && record.state === "live" && record.reported === true;
			});
			return live ? { manifest, control, addresses } : null;
		}, { label: "the pool to report ready with " + workers + " worker(s)" });
	} catch (error) {
		// A gate failure must say what the pool looked like, not only that it timed out.
		const manifest = fx.readManifest();
		throw new Error(error.message + NL + [
			"root: " + JSON.stringify(hcGet(fx, root)),
			"control: " + JSON.stringify(fx.readControl()),
			"manifest: " + JSON.stringify(manifest && { state: manifest.state, generation: manifest.generation, workerAddresses: manifest.workerAddresses, launcherPid: manifest.launcherPid, mindPid: manifest.mindPid }),
			"terminals: " + JSON.stringify(hcList(fx).map((terminal) => ({ address: terminal.address, name: terminal.name, state: terminal.state, parent: terminal.parent }))),
			"records: " + JSON.stringify(readdirSync(fx.records)),
			"mind: " + JSON.stringify(fx.readRecord("mind.json")),
			"mindLog: " + JSON.stringify(readMindLog(fx)),
			"screen: " + JSON.stringify(hc(fx, ["read", root, "--lines", "80"], { allowFail: true }).stdout),
		].join(NL));
	}

	const rootPid = readJson(fx.rootPidPath);
	const mind = fx.readRecord("mind.json");
	const rootRecord = hcGet(fx, root);
	const screen = hc(fx, ["read", root, "--lines", "400"], { allowFail: true }).stdout;
	return { root, rootPid, mind, rootRecord, screen, ...ready };
}

function diagnose(fx, root) {
	const manifest = fx.readManifest();
	const mind = fx.readRecord("mind.json");
	const shim = fx.readRecord("shim-run.json");
	return [
		"records: " + JSON.stringify(fx.readdirRecords()),
		"mind: " + JSON.stringify(mind && { pid: mind.pid, ppid: mind.ppid, role: mind.role }),
		"mindAlive: " + (mind ? pidAlive(mind.pid) : null),
		"launcherAlive: " + (manifest && manifest.launcherPid ? pidAlive(manifest.launcherPid) : null),
		"shim: " + JSON.stringify(shim && { name: shim.name, address: shim.address, code: shim.code, stderr: (shim.stderr || "").slice(0, 300) }),
		"shimReleased: " + JSON.stringify(fx.readRecord("shim-released.json")),
		"burstStarted: " + JSON.stringify(fx.readRecord("burst-started.json")),
		"burstError: " + JSON.stringify(fx.readRecord("burst-error.json")),
		"root: " + JSON.stringify(hcGet(fx, root) && { state: hcGet(fx, root).state, reason: hcGet(fx, root).reason }),
		"terminals: " + JSON.stringify(hcList(fx).map((terminal) => ({ address: terminal.address, name: terminal.name, state: terminal.state, parent: terminal.parent }))),
		"input: " + JSON.stringify(fx.readLines("mind-input.jsonl")),
		"screen: " + JSON.stringify(hc(fx, ["read", root, "--lines", "120"], { allowFail: true }).stdout),
	].join(NL);
}

function readMindLog(fx) {
	const manifest = fx.readManifest();
	if (!manifest) return null;
	try {
		return readFileSync(join(fx.stateDir, manifest.cwdHash + "-mind-gen" + manifest.generation + ".log"), "utf8");
	} catch { return null; }
}

function assertNoWorkerTerminals(fx, root, addresses, label) {
	const leftovers = hcList(fx).filter((terminal) => terminal.parent === root ||
		addresses.includes(terminal.address));
	assert.deepEqual(leftovers, [], label + ": every worker terminal must be gone (live or finished)");
	for (const address of addresses) {
		assert.equal(hcGet(fx, address), null, label + ": " + address + " must not resolve");
	}
}

// ── The gate ────────────────────────────────────────────────────────────────

test("gate: an isolated core is not the user's core, and --rm leaves no record", { skip: SKIP, timeout: 60000 }, async (t) => {
	assertHcVersion();
	const fx = createFixture(t);
	assert.equal(fx.env.HC_SESSION, fx.session, "every hc call must carry the scratch session");
	assert.equal(statSync(fx.runtime).mode & 0o777, 0o700, "the scratch runtime dir must be private");
	// A fresh session starts empty; a leaked selector would show the user's terminals here.
	assert.deepEqual(hcList(fx), [], "the scratch core must start with no terminals");

	// --rm is the worker contract: a finished record must not survive.
	const started = hcJson(fx, ["run", "--bg", "--json", "--no-parent", "--rm", "--name", "gate-self", "--cwd", fx.project, "--", "/bin/sleep", "30"]);
	assert.ok(started?.address, "hc run must start a terminal in the scratch core");
	assert.deepEqual(hcList(fx).map((terminal) => terminal.address), [started.address]);
	// --rm already removed the record, so not_found is success here.
	hc(fx, ["kill", started.address, "--json"], { allowFail: true });
	await waitFor(() => hcList(fx).length === 0, { label: "the killed --rm terminal to disappear" });
});

test("refusal: a non-exec launch fails the root-program check before any worker exists", { skip: SKIP, timeout: 60000 }, async (t) => {
	const fx = createFixture(t);
	const root = startRoot(fx);
	// No exec: the module is a child of the terminal's shell, so hc records the shell's pid.
	hcSend(fx, root, "node " + JSON.stringify(LAUNCHER_MODULE) + " --cwd " + JSON.stringify(fx.project));

	const screen = await waitFor(() => {
		const text = hc(fx, ["read", root, "--lines", "200"], { allowFail: true }).stdout;
		return text.includes("shell builtin exec") ? text : null;
	}, { label: "the refusal message naming exec" });
	assert.ok(screen.includes("not the root program"), "the refusal must name the root-program check");
	assert.equal(fx.readManifest(), null, "a refused launch must not write a manifest");
	assert.equal(existsSync(join(fx.records, "mind.json")), false, "a refused launch must not start Mind");
	assert.deepEqual(hcList(fx).map((terminal) => terminal.address), [root], "no worker terminal may exist");
	assert.equal(hcGet(fx, root).state, "live", "the refusal must leave the caller's terminal alone");
});

test("exec root: pid, tty, foreground group, probed core id and manifest v2 match", { skip: SKIP, timeout: 120000 }, async (t) => {
	assert.equal(readJson(join(AGENT_DIR, "mind-worker.json"))?.terminalBackend, "hc",
		"the repo mind-worker.json must name terminalBackend=hc for the wrapper");
	const fx = createFixture(t, { workers: 2 });
	const { root, rootPid, mind, rootRecord, manifest, addresses } = await bootPool(fx, { workers: 2 });

	assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0, "the root-exec script must record its pid");
	assert.equal(rootRecord.state, "live");
	assert.equal(rootRecord.parent, null, "the root must be parentless");
	assert.equal(rootRecord.pid, rootPid, "exec must keep the pid: hc's recorded pid is the launcher");
	assert.equal(rootRecord.foreground?.pid, rootPid, "the launcher must be the terminal's foreground program");
	const rootStat = processState(rootPid);
	assert.ok(rootStat, "the launcher pid must be readable");
	assert.equal(rootStat.pgrp, rootPid, "the launcher must own its process group");
	assert.equal(rootStat.session, rootPid, "the launcher must be the session leader");
	assert.equal(rootStat.tpgid, rootPid, "the launcher must hold the terminal foreground");
	assert.notEqual(rootStat.ttyNr, 0, "the launcher must have a TTY");
	assert.ok(mind, "fake Mind must record itself");
	assert.equal(mind.stat.ttyNr, rootStat.ttyNr, "Mind must run on the root's TTY");

	assert.equal(manifest.schemaVersion, 2);
	assert.equal(manifest.terminalBackend, "hc");
	assert.equal(manifest.rootTerminalAddress, root);
	assert.equal(manifest.cwd, fx.project);
	assert.equal(manifest.launcherPid, rootPid);
	assert.equal(manifest.mindPid, mind.pid);
	assert.equal(manifest.generation, 1);
	assert.equal(manifest.workerCount, 2);
	assert.equal(addresses.length, 2);

	// Core identity is the core that answered, not a selector that this terminal happens to carry.
	const status = hcJson(fx, ["server", "status", "--json"]);
	const identity = manifest.coreIdentity || {};
	assert.equal(identity.id, status.core.id, "manifest coreIdentity.id must be the probed core id");
	assert.equal(identity.name, status.core.name);
	assert.equal(identity.version, status.version);
	if (identity.session !== undefined) assert.equal(identity.session, fx.session, "coreIdentity must record the scratch session");
	assert.equal(identity.socket, null, "a session-selected core has no explicit HC_SOCKET");
	assert.notEqual(identity.id, mind.hc.scope, "HC_SCOPE is per-terminal, never core identity");

	const { probeCoreIdentity } = await import(pathToFileURL(SPAWN_HELPER).href);
	const probed = await probeCoreIdentity({ env: fx.env });
	assert.deepEqual(
		{ id: probed.id, name: probed.name, version: probed.version },
		{ id: status.core.id, name: status.core.name, version: status.version },
		"the helper's probe API must agree with hc server status",
	);

	const workers = fx.readWorkerRecords();
	assert.equal(workers.length, 2, "both workers must record themselves");
	assert.notEqual(mind.hc.scope, workers[0].hc.scope, "each terminal gets its own HC_SCOPE");
	assert.notEqual(identity.id, workers[0].hc.scope, "a worker's HC_SCOPE is not the core id");

	for (const address of addresses) {
		const record = hcGet(fx, address);
		assert.equal(record.parent, root, address + " must be a direct child of the root");
		assert.equal(record.state, "live");
		assert.equal(record.notify, false, address + " must carry --no-notify");
		assert.equal(record.rm, true, address + " must carry --rm");
		assert.ok(record.name.length <= 32 && record.name.endsWith("-w" + addresses.indexOf(address)),
			address + " must use a compact run-scoped name, got " + record.name);
	}
});

test("workers: allowlisted identity env only, argv intact through mise, OSC status reports", { skip: SKIP, timeout: 120000 }, async (t) => {
	const fx = createFixture(t, { workers: 2 });
	const { addresses } = await bootPool(fx, { workers: 2 });
	const records = fx.readWorkerRecords();
	assert.equal(records.length, 2, "both workers must record themselves");

	for (const record of records) {
		// The core assigns each worker its own address; that is the authoritative link.
		const address = record.hc.terminalId;
		assert.ok(addresses.includes(address), "each worker record must name a manifest address: " +
			JSON.stringify({ workerId: record.workerId, address: address, addresses: addresses.slice(), records: fx.readdirRecords() }));
		assert.ok(record.pid > 0);
		// PI_BIN has a space in its path and must arrive as exactly one argv element.
		assert.equal(record.executable, fx.fakePi, "the PI_BIN override must reach the worker unchanged");
		assert.equal(record.argv[record.argv.indexOf("--model") + 1], "vendor/worker model", "a model with a space stays one argument");
		assert.equal(record.argv[record.argv.indexOf("--thinking") + 1], "max");
		assert.ok(record.argv[record.argv.indexOf("--session-dir") + 1].startsWith(join(fx.agentDir, "sessions")));
		assert.equal(record.argv.includes("--mode"), false, "a native worker must not use the deleted --mode rpc path");

		assert.deepEqual(record.identityKeys, [
			"PI_MIND_WORKER_GENERATION",
			"PI_MIND_WORKER_ID",
			"PI_MIND_WORKER_ROLE",
			"PI_MIND_WORKER_SESSION_DIR",
			"PI_MIND_WORKER_TIER",
		], "a worker must receive the identity allowlist and nothing else");
		assert.equal(record.identity.launcherPid, null, "the launcher pid must not reach a worker");
		assert.equal(record.secret, null, "a Mind shell export must not reach a worker");
		assert.equal(record.sessionId, null, "a Mind shell export must not reach a worker");
		assert.equal(record.hc.session, fx.session);
		assert.equal(record.hc.terminalId, address, "the core must assign the worker its own terminal id");
		assert.ok(record.hc.terminalSocket, "the core must assign the worker its own terminal socket");

		const status = hcGet(fx, address);
		assert.equal(status.reported, true, "OSC 7501 must still report for the worker");
		assert.equal(status.status?.app, "pi", "the worker's own report must be on the terminal");
		assert.ok(["working", "idle"].includes(status.status?.state));
		assert.equal(typeof status.status_ms, "number");
	}
	// The sentinel is in the launcher's env, so it reaches Mind: proof the absence above is meaningful.
	const mind = fx.readRecord("mind.json");
	assert.equal(mind.secret, SENTINEL);
	assert.equal(mind.sessionId, SENTINEL_SESSION);
});

test("notes: an OSC root gets no worker note at start or exit, while a notify child does", { skip: SKIP, timeout: 120000 }, async (t) => {
	const fx = createFixture(t, { workers: 1 });
	const { root, addresses } = await bootPool(fx, { workers: 1 });
	const address = addresses[0];
	const worker = hcGet(fx, address);
	assert.ok(worker);

	// The root is an OSC parent: hc only types notes into a terminal that reports.
	const rootStatus = hcGet(fx, root);
	assert.equal(rootStatus.reported, true, "the live root must report OSC 7501");
	assert.equal(rootStatus.status?.app, "pi");
	assert.equal(worker.reported, true, "the worker reports before its exit");
	assert.equal(worker.status?.app, "pi");

	// START: the worker is marked --no-notify, and nothing was typed.
	assert.deepEqual(fx.readLines("mind-input.jsonl").filter((line) => line.includes("<hc")), [], "a worker start must type no note");
	assert.equal(fx.readLines("mind-input.jsonl").length, 0, "the root's input must be untouched by the worker start");
	const screenAtStart = hc(fx, ["read", root, "--lines", "400"]).stdout;
	assert.equal(screenAtStart.includes("<hc"), false, "no note in the actual <hc> form may appear on the root screen");

	// Positive control: a child without --no-notify must be noted, or the absence above
	// proves nothing. No --rm: hc still has the record when it writes the exit note.
	const control = hcJson(fx, ["run", "--bg", "--json", "--parent", root, "--name", "gate-note-control", "--cwd", fx.project, "--", "/bin/sleep", "1"]);
	let controlNote;
	try {
		controlNote = await waitFor(() => fx.readLines("mind-input.jsonl").find((line) => line.includes("<hc")), {
			label: "the notify control's note on the OSC root",
		});
	} catch (error) {
		throw new Error(error.message + NL + diagnose(fx, root));
	}
	assert.ok(controlNote.startsWith("<hc>"), "the note must use the observed <hc> form, got " + JSON.stringify(controlNote));
	assert.ok(controlNote.includes("gate-note-control"), "the note must name the notify child");
	await waitFor(() => {
		const record = hcGet(fx, control.address);
		return record && record.state === "finished";
	}, { label: "the notify control to finish" });
	await sleep(300);
	const notesBeforeExit = fx.readLines("mind-input.jsonl").filter((line) => line.includes("<hc"));

	// EXIT: kill the worker while the root stays live; nothing may be typed for it.
	hc(fx, ["kill", address, "--json"], { allowFail: true });
	await waitFor(() => hcGet(fx, address) === null, { label: "the worker terminal to disappear" });
	assert.equal(hcGet(fx, root).state, "live", "the root must stay live across the worker exit");
	await sleep(500);
	const notesAfterExit = fx.readLines("mind-input.jsonl").filter((line) => line.includes("<hc"));
	assert.equal(notesAfterExit.length, notesBeforeExit.length, "a worker exit must type no note");
	assert.equal(notesAfterExit.some((line) => line.includes(worker.name) || line.includes(address)), false,
		"no note may name the worker at exit");
	const screenAtExit = hc(fx, ["read", root, "--lines", "400"]).stdout;
	for (const line of screenAtExit.split(NL)) {
		if (!line.includes("<hc")) continue;
		assert.equal(line.includes(worker.name) || line.includes(address), false, "the root screen must carry no worker note: " + line);
	}
	assert.ok(screenAtExit.includes("gate-note-control"), "the control's note proves the screen check sees <hc> lines");
});

test("normal root exit leaves no worker child and no finished worker record", { skip: SKIP, timeout: 120000 }, async (t) => {
	const fx = createFixture(t, { workers: 2 });
	const { root, addresses } = await bootPool(fx, { workers: 2 });
	hcSend(fx, root, "exit:0");

	const finished = await waitFor(() => {
		const record = hcGet(fx, root);
		return record && record.state === "finished" ? record : null;
	}, { label: "the root terminal to finish after Mind exits" });
	assert.equal(finished.exit_code, 0, "the launcher must exit with Mind's code");
	assert.equal(finished.reason, "exited");
	assertNoWorkerTerminals(fx, root, addresses, "normal exit");
	const manifest = fx.readManifest();
	assert.equal(manifest.state, "stopped");
	assert.equal(manifest.launcherPid, null);
});

test("hc kill of the root leaves no worker child and no finished worker record", { skip: SKIP, timeout: 120000 }, async (t) => {
	const fx = createFixture(t, { workers: 2 });
	const { root, addresses } = await bootPool(fx, { workers: 2 });
	hc(fx, ["kill", root, "--json"]);
	const finished = await waitFor(() => {
		const record = hcGet(fx, root);
		return record && record.state === "finished" ? record : null;
	}, { label: "the root terminal to finish after hc kill" });
	assert.equal(finished.reason, "killed");
	assertNoWorkerTerminals(fx, root, addresses, "hc kill");
});

test("forced root death (SIGKILL) leaves no worker child and no finished worker record", { skip: SKIP, timeout: 120000 }, async (t) => {
	const fx = createFixture(t, { workers: 2 });
	const { root, rootPid, addresses } = await bootPool(fx, { workers: 2 });
	process.kill(rootPid, "SIGKILL");
	const finished = await waitFor(() => {
		const record = hcGet(fx, root);
		return record && record.state === "finished" ? record : null;
	}, { label: "the root terminal to finish after SIGKILL" });
	assert.equal(finished.signal, 9);
	assertNoWorkerTerminals(fx, root, addresses, "SIGKILL");
});

test("forced root death while the hc run reply is withheld cannot leak a worker", { skip: SKIP, timeout: 120000 }, async (t) => {
	const fx = createFixture(t, { workers: 1 });
	const { root, rootPid, addresses } = await bootPool(fx, { workers: 1 });

	// The fake Mind calls the real spawnWorkerTerminal through a client shim: the
	// real hc run creates the terminal at once, then the shim withholds only the
	// JSON reply, so the helper's promise is genuinely pending at the root's death.
	hcSend(fx, root, "spawn-burst");
	const created = await waitFor(() => fx.readRecord("shim-created.json"), {
		label: "the hc client to create the terminal and withhold its reply",
	});
	assert.ok(created.address, "the real hc run must have created the burst terminal");
	const shimRun = fx.readRecord("shim-run.json");
	assert.ok(shimRun, "the shim must record the real hc invocation");
	assert.equal(shimRun.selectors.session, fx.session, "the shim must reach the scratch core, not the user's");
	assert.equal(shimRun.selectors.terminalId, root, "the shim inherits the root terminal selector");
	assert.equal(existsSync(fx.releasePath), false, "the reply must still be withheld");
	assert.equal(fx.readRecord("burst-address.json"), null, "the helper must still be pending");
	const pending = hcList(fx).find((terminal) => terminal.address === created.address);
	assert.ok(pending && pending.state === "live", "the pending child must exist while the root is alive");
	assert.equal(pending.parent, root);
	assert.equal(hcGet(fx, root).state, "live");

	// Forced root death, then release the reply: the helper resolves with an
	// address whose terminal the core already took away with the root.
	process.kill(rootPid, "SIGKILL");
	writeFileSync(fx.releasePath, "1");
	let late;
	try {
		late = await waitFor(() => fx.readRecord("burst-address.json") || fx.readRecord("burst-error.json"), {
			label: "the late spawn callback after the root died",
		});
	} catch (error) {
		throw new Error(error.message + NL + diagnose(fx, root));
	}
	assert.ok(late.address, "the withheld reply must reach the helper as a late address: " + JSON.stringify(late));
	assert.equal(late.address, created.address);
	assert.equal(fx.readRecord("shim-released.json")?.released, true);

	// No worker process, no terminal record: a late address cannot resurrect or leak one.
	await waitFor(() => hcGet(fx, created.address) === null, {
		label: "the core to reap the pending child with the root",
	});
	const leftovers = hcList(fx).filter((terminal) =>
		terminal.parent === root || terminal.address === created.address || terminal.name === "gate-b0");
	assert.deepEqual(leftovers, [], "no burst terminal may survive the root, live or finished");
	const burstWorker = fx.readRecord("worker-burst-flash-1.json");
	if (burstWorker) assert.equal(pidAlive(burstWorker.pid), false, "the burst worker process must be gone");
	assertNoWorkerTerminals(fx, root, addresses, "withheld hc reply");
});

test("bounded startup failure leaves nothing running and exits non-zero", { skip: SKIP, timeout: 120000 }, async (t) => {
	const fx = createFixture(t, { workers: 2 });
	const { root, finished } = await bootPool(fx, { workers: 2, failMind: true });
	assert.equal(finished.exit_code, 31, "the launcher must exit with Mind's startup-failure code");
	assert.equal(finished.reason, "exited");
	assert.ok(fx.readRecord("mind-failed.json"), "fake Mind must have failed before readiness");
	assert.deepEqual(hcList(fx).map((terminal) => terminal.address), [root], "no worker terminal may be left");
	const manifest = fx.readManifest();
	assert.equal(manifest.state, "stopped");
	assert.equal(manifest.launcherPid, null);
	assert.equal(manifest.workerAddresses && Object.keys(manifest.workerAddresses).length, 0);
});

test("a Mind exit 0 before readiness is a startup failure, not a normal stop", { skip: SKIP, timeout: 120000 }, async (t) => {
	const fx = createFixture(t, { workers: 1 });
	const { root, finished } = await bootPool(fx, { workers: 1, exit0: true });
	assert.ok(fx.readRecord("mind-exit0.json"), "fake Mind must have exited 0 before readiness");
	assert.equal(finished.exit_code, 1, "a pre-ready exit 0 must be normalized to a failure");
	assert.equal(finished.reason, "exited");
	assert.deepEqual(hcList(fx).map((terminal) => terminal.address), [root], "no worker terminal may be left");
	const manifest = fx.readManifest();
	assert.equal(manifest.state, "stopped");
	assert.equal(manifest.launcherPid, null);
});


// A root terminal whose env carries only the terminal-scoped HC vars (no HC_SESSION,
// no HC_SOCKET). The launcher must pin HC_SOCKET to HC_TERMINAL_SOCKET, stay on that
// terminal's own core, and never reach a default core.
test("fallback: a terminal-only root pins HC_SOCKET to HC_TERMINAL_SOCKET on its own core", { skip: SKIP, timeout: 120000 }, async (t) => {
	const fx = createFixture(t, { workers: 2 });
	const { root, mind, manifest, addresses } = await bootPool(fx, { workers: 2, terminalOnly: true });

	// The simulation worked: Mind saw no selector it could have inherited from the shell.
	assert.equal(mind.hc.session, null, "the root must have had no HC_SESSION: the terminal-only env is the point");
	assert.ok(mind.hc.terminalSocket, "the root must keep HC_TERMINAL_SOCKET: it is the only transport left");
	assert.ok(mind.hc.terminalSocket.endsWith(fx.session + ".sock"), "HC_TERMINAL_SOCKET must be the isolated core's socket, got " + mind.hc.terminalSocket);

	// The fallback: HC_SOCKET is the terminal socket, so every later hc call is pinned.
	assert.equal(mind.hc.socket, mind.hc.terminalSocket, "the launcher must pin HC_SOCKET to HC_TERMINAL_SOCKET for Mind");

	// Same core, proven by the id: a default-core fallback would report another core.
	const status = hcJson(fx, ["server", "status", "--json"]);
	assert.equal(manifest.coreIdentity.id, status.core.id, "the pool must be on the terminal's own core");
	assert.equal(manifest.coreIdentity.session, null, "a socket-selected core records no session selector");
	assert.equal(manifest.coreIdentity.socket, mind.hc.terminalSocket, "the manifest must record the socket selector actually used");

	// Workers land in that same core, one level under the root.
	for (const address of addresses) {
		const record = hcGet(fx, address);
		assert.ok(record, address + " must resolve from the same core, not a default one");
		assert.equal(record.parent, root, address + " must be a direct child of the root");
		assert.equal(record.state, "live");
	}
	// The fallback is the launcher's, never copied into a child's env.
	const workers = fx.readWorkerRecords();
	assert.equal(workers.length, 2);
	for (const record of workers) {
		assert.equal(record.hc.socket, null, "the fallback must not leak HC_SOCKET into a worker");
		assert.equal(record.hc.session, fx.session, "a worker's session comes from the core, not from the root");
	}

	// Clean root exit: the core reaps the children, nothing is left behind.
	hcSend(fx, root, "exit:0");
	const finished = await waitFor(() => {
		const record = hcGet(fx, root);
		return record && record.state === "finished" ? record : null;
	}, { label: "the root terminal to finish after Mind exits" });
	assert.equal(finished.exit_code, 0, "the launcher must exit with Mind's code");
	assert.equal(finished.reason, "exited");
	assertNoWorkerTerminals(fx, root, addresses, "terminal-only root");
});



// A scratch environment with no core of its own. Nothing here calls hc, so a core
// can only appear if the launcher under test starts one.
function scratchOnlyEnv(t) {
	const root = mkdtempSync(join(tmpdir(), "mind-worker-hc-stale-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const runtime = join(root, "runtime");
	const configHome = join(root, "config");
	const stateHome = join(root, "state");
	const cacheHome = join(root, "cache");
	const stale = join(root, "stale");
	for (const dir of [home, agentDir, join(agentDir, "mindworker"), join(agentDir, "sessions"),
		runtime, configHome, stateHome, cacheHome, stale]) {
		mkdirSync(dir, { recursive: true });
	}
	chmodSync(runtime, 0o700); // hc refuses a runtime dir other users could read
	writeFileSync(join(agentDir, "mind-worker.json"), JSON.stringify({
		terminalBackend: "hc",
		mindModel: "vendor/mind model",
		workerModels: [{ model: "vendor/worker model", count: 1, tier: "flash" }],
		timeout: 30,
		dashboardEnabled: false,
	}, null, 2));
	const env = { ...process.env };
	// No inherited selector and no inherited identity can point this run at a real core.
	for (const key of Object.keys(env)) {
		if (key.indexOf("HC_") === 0 || key.indexOf("PI_MIND_WORKER_") === 0 || key.indexOf("MIND_WORKER_") === 0) delete env[key];
	}
	Object.assign(env, {
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: configHome,
		XDG_STATE_HOME: stateHome,
		XDG_CACHE_HOME: cacheHome,
		XDG_RUNTIME_DIR: runtime,
	});
	t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
	return { root, agentDir, runtime, configHome, stateHome, stale, env };
}

// hc autostarts a core at HC_SOCKET when nothing answers there and exits 0, so a derived
// socket must be proven live before use or an unwanted core is started behind it. The root
// record/PID check already keeps Mind and workers off a new core; this gate stops the core.
test("fallback: a dead HC_TERMINAL_SOCKET fails closed and starts no core", { skip: SKIP, timeout: 60000 }, async (t) => {
	const sc = scratchOnlyEnv(t);
	const deadSocket = join(sc.stale, "gone.sock");
	const env = { ...sc.env, HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: deadSocket };
	assert.equal("HC_SESSION" in env || "HC_SOCKET" in env, false, "only the terminal-scoped vars may be present");

	const started = Date.now();
	// No PTY: the socket gate must run before the TTY gate and before any hc query.
	const proc = spawnSync(process.execPath, [LAUNCHER_MODULE], { env, encoding: "utf8", timeout: 30000 });
	const elapsed = Date.now() - started;
	const stderr = (proc.stderr || "") + (proc.stdout || "");

	assert.notEqual(proc.status, 0, "a dead terminal socket must not be accepted:\n" + stderr.slice(0, 800));
	// Prove the socket gate fired: a config, TTY or manifest error would be a false green.
	assert.match(stderr, /HC_TERMINAL_SOCKET .*is not reachable/, "the bounded socket gate must name the dead socket:\n" + stderr.slice(0, 800));
	assert.ok(elapsed < 20000, "the socket gate must be bounded, took " + elapsed + "ms");

	// The bug: hc creates the socket at HC_SOCKET and a core behind it, then exits 0.
	assert.equal(existsSync(deadSocket), false, "the launcher must not autostart a core at the derived socket");
	assert.deepEqual(readdirSync(sc.stale), [], "nothing may be created beside the dead socket path");
	assert.deepEqual(readdirSync(sc.runtime), [], "no core, holder or runtime dir may be created");
	assert.deepEqual(readdirSync(sc.stateHome), [], "hc must leave no core state behind");
	assert.deepEqual(readdirSync(sc.configHome), [], "hc must not write config for a core it should not have started");
});

test("fallback: a non-socket HC_TERMINAL_SOCKET fails closed as unreachable", { skip: SKIP, timeout: 60000 }, async (t) => {
	const sc = scratchOnlyEnv(t);
	// A regular file is not a unix socket: connecting must fail closed, not start a core.
	const notASocket = join(sc.stale, "not-a-socket");
	writeFileSync(notASocket, "");
	const env = { ...sc.env, HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: notASocket };

	const proc = spawnSync(process.execPath, [LAUNCHER_MODULE], { env, encoding: "utf8", timeout: 30000 });
	assert.notEqual(proc.status, 0, "a non-socket HC_TERMINAL_SOCKET must be refused");
	assert.match((proc.stderr || "") + (proc.stdout || ""), /HC_TERMINAL_SOCKET .*is not reachable/,
		"a non-socket path must fail the same gate, not a later one");
	assert.equal(readFileSync(notASocket, "utf8"), "", "the launcher must not write into the dead socket path");
	assert.deepEqual(readdirSync(sc.runtime), [], "no core may be started for a non-socket path");
	assert.deepEqual(readdirSync(sc.stateHome), [], "hc must leave no core state behind");
});
