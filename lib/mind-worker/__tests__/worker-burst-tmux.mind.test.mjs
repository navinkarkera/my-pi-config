// worker-burst-tmux.mind.test.mjs
//
// Native burst lifecycle on a v3/tmux pool: the real extension module, the real
// tmux-terminal helper, a fake Pi API, and a fake tmux (PI_TMUX_BIN) that speaks
// the exact argv/format contract of tmux 3.8 and nothing more. No real tmux
// server, no hc core, no model, no network, no notifier.
//
// Pinned here: the manifest record selects the host (v3/tmux vs v2/hc) and a
// cross/unknown record is refused; the root is proved with the launcher's own pid
// (a child process pid is never the pane program); a stale tuple or a record that
// changes while pinning is refused before a pane exists; retirement kills only a
// pane the record owns; a static and a burst spawn share one reserved window;
// every record write keeps the pool identity; adoption after /reload is cleanup
// only and never resets an agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFixture, waitUntil } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";
import { spawnWorkerTerminal, updatePoolManifest } from "../tmux-terminal.mjs";

installPiResolver();

const BURST = {
	enabled: true,
	model: "vendor/burst",
	maxBurst: 1,
	idleTtlMs: 60000,
	maxTasksPerWorker: 3,
	queuePressureThreshold: 1,
	spawnWaitMs: 10,
	logDetail: "compact",
};

const LAUNCHER_PID = 4100;
const ROOT_COMMAND = "/usr/bin/mise x node@26 -- node /pi/dist/cli.js --mind-worker-role=mind";
const SERVER = { pid: 900, startTime: 1_700_000_000, version: "tmux 3.8" };
const SESSION = { id: "$0", created: 1_700_000_001 };

// ── Fake tmux ────────────────────────────────────────────────────────────────

// tmux -S <socket> -N <command> ...: the fake reads/writes one JSON state file
// next to the socket, answers the formats the helper asks for, and lets a test
// mutate the pool record at a chosen call. A created pane is registered in the
// record by a separate flock writer, exactly as the real wrapper does after the
// creating call returns.
const FAKE_TMUX = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
const socketAt = argv.indexOf("-S");
if (socketAt === -1) {
	process.stderr.write("fake tmux: -S <socket> is required\n");
	process.exit(1);
}
const socketPath = argv[socketAt + 1];
const rest = argv.filter((arg, index) => index !== socketAt && index !== socketAt + 1 && arg !== "-N");
const statePath = socketPath + ".fake-tmux.json";
const callsPath = socketPath + ".fake-tmux-calls.jsonl";
fs.appendFileSync(callsPath, JSON.stringify({ argv: rest }) + "\n");

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const fail = (message) => {
	save();
	process.stderr.write(message + "\n");
	process.exit(1);
};
const expand = (format, context) =>
	String(format).replace(/#\{([^}]*)\}/g, (match, key) => (context[key] === undefined ? "" : String(context[key])));
const opt = (name) => {
	const at = rest.indexOf(name);
	return at === -1 ? null : rest[at + 1];
};

// One-shot record mutation, so a test can prove what happens when the launcher
// rewrites the pool record while Mind is pinning it.
state.calls = (state.calls || 0) + 1;
if (state.mutate && !state.mutate.applied && state.calls >= state.mutate.after) {
	state.mutate.applied = true;
	const record = JSON.parse(fs.readFileSync(state.mutate.manifestPath, "utf8"));
	for (const [key, value] of Object.entries(state.mutate.set)) record[key] = value;
	const tmp = state.mutate.manifestPath + ".fake-" + process.pid;
	fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
	fs.renameSync(tmp, state.mutate.manifestPath);
}

const serverContext = () => ({
	socket_path: state.server.socketPath,
	pid: state.server.pid,
	start_time: state.server.startTime,
	version: state.server.version,
	session_id: state.session.id,
	session_created: state.session.created,
});
const paneContext = (pane) => ({
	...serverContext(),
	pane_id: pane.paneId,
	pane_pid: pane.panePid,
	pane_start_command: pane.startCommand,
	window_id: pane.windowId,
	session_id: pane.sessionId,
	"remain-on-exit": "off",
	"@mind.owner": pane.owner,
	"@mind.run": pane.run,
	"@mind.generation": pane.generation,
	"@mind.worker": pane.worker,
});
const windowContext = (window) => ({
	...serverContext(),
	window_id: window.id,
	session_id: window.sessionId,
	"remain-on-exit": "off",
});

const command = rest[0];
const target = opt("-t");
const format = opt("-F");

const sessionOf = (targetText) => (targetText === null || targetText.startsWith("$") ? state.session : null);

let reply = "";

if (command === "display-message") {
	if (target === null) fail("fake tmux: display-message needs -t");
	if (target.startsWith("%")) {
		const pane = state.panes[target];
		if (!pane) fail("can't find pane: " + target);
		reply = expand(format, paneContext(pane));
	} else if (target.startsWith("@")) {
		const window = state.windows[target];
		if (!window) fail("can't find window: " + target);
		reply = expand(format, windowContext(window));
	} else if (sessionOf(target)) {
		reply = expand(format, serverContext());
	} else {
		fail("can't find session: " + target);
	}
} else if (command === "list-sessions") {
	reply = expand(format, serverContext());
} else if (command === "list-windows") {
	const session = sessionOf(target);
	if (!session) fail("can't find session: " + target);
	const wanted = target.startsWith("$") ? target.replace(/:$/, "") : session.id;
	const ids = Object.keys(state.windows).filter((id) => state.windows[id].sessionId === wanted);
	reply = ids.map((id) => expand(format, windowContext(state.windows[id]))).join("\n");
} else if (command === "list-panes") {
	const window = state.windows[target];
	if (!window) fail("can't find window: " + target);
	const ids = Object.keys(state.panes).filter((id) => state.panes[id].windowId === target);
	reply = ids.map((id) => expand(format, paneContext(state.panes[id]))).join("\n");
} else if (command === "new-window" || command === "split-window") {
	const separator = rest.indexOf("--");
	const wrapper = separator === -1 ? [] : rest.slice(separator + 1);
	if (wrapper.length === 0) fail("fake tmux: " + command + " needs a command");
	const value = (name) => {
		const at = wrapper.indexOf(name);
		return at === -1 ? null : wrapper[at + 1];
	};
	const workerId = value("--worker-id");
	const manifestPath = value("--manifest");
	if (!workerId || !manifestPath) fail("fake tmux: the wrapper must carry --worker-id and --manifest");

	let windowId;
	if (command === "new-window") {
		const session = sessionOf(target);
		if (!session) fail("can't find session: " + target);
		windowId = "@" + state.nextWindow++;
		state.windows[windowId] = { id: windowId, sessionId: session.id };
	} else {
		if (!state.windows[target]) fail("can't find window: " + target);
		windowId = target;
	}
	const paneId = "%" + state.nextPane++;
	const pane = {
		paneId,
		panePid: 5000 + Number(paneId.slice(1)),
		startCommand: wrapper.join(" "),
		windowId,
		sessionId: state.session.id,
		owner: value("--owner") || "",
		run: value("--run") || "",
		generation: value("--generation") || "",
		worker: workerId,
		title: workerId,
		screen: "",
	};
	state.panes[paneId] = pane;
	save();
	// Registration after the creating call returns, under the same flock the module
	// holds: this is what the trusted wrapper does, and the only ordering the
	// helper's post-spawn proof accepts.
	const lockPath = manifestPath.replace(/-manifest\.json$/, ".worker-window.lock");
	const writer = spawn(
		"flock",
		["-w", "10", lockPath, state.registration.node, state.registration.writer, manifestPath, statePath, workerId, paneId],
		{ detached: true, stdio: "ignore" },
	);
	writer.unref();
	reply = expand(format, paneContext(pane));
} else if (command === "kill-pane") {
	const pane = state.panes[target];
	if (!pane) fail("can't find pane: " + target);
	delete state.panes[target];
} else if (command === "select-pane") {
	const pane = state.panes[target];
	if (!pane) fail("can't find pane: " + target);
	const titleAt = rest.indexOf("-T");
	if (titleAt !== -1) pane.title = rest[titleAt + 1];
} else if (command === "capture-pane") {
	const pane = state.panes[target];
	if (!pane) fail("can't find pane: " + target);
	reply = pane.screen;
} else if (command === "show-options") {
	// Only remain-on-exit is ever read, and the pool keeps it off.
	reply = "off";
} else if (command === "set-option" || command === "select-layout") {
	// Layout and window options are never identity.
} else {
	fail("fake tmux: unsupported " + rest.join(" "));
}

save();
if (reply) process.stdout.write(reply.endsWith("\n") ? reply : reply + "\n");
process.exit(0);
`;

// Writes one worker pane entry into the record, under the module's own lock.
const FAKE_TMUX_WRITER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const [manifestPath, statePath, workerId, paneId] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const pane = state.panes[paneId];
if (!pane) process.exit(0);
const record = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
record.workerPanes = Object.assign({}, record.workerPanes || {}, {
	[workerId]: { paneId, panePid: pane.panePid, startCommand: pane.startCommand },
});
const tmp = manifestPath + ".fake-" + process.pid;
fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
fs.renameSync(tmp, manifestPath);
`;

// ── Pool fixtures ────────────────────────────────────────────────────────────

const managedEnv = ["TMUX", "TMUX_PANE", "PI_TMUX_BIN", "PI_MIND_WORKER_LAUNCHER_PID"];

/** A fixture whose env is fully restored, fake tmux included. */
async function withTmuxPool(options, fn) {
	const fixture = await createFixture(options);
	const saved = new Map();
	for (const key of managedEnv) saved.set(key, process.env[key]);
	try {
		return await fn(fixture);
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fixture.cleanup();
	}
}

function manifestPathOf(fixture) {
	return join(fixture.stateDir, fixture.hash + "-manifest.json");
}

function readRecord(fixture) {
	return JSON.parse(readFileSync(manifestPathOf(fixture), "utf8"));
}

function patchRecord(fixture, patch) {
	const record = readRecord(fixture);
	patch(record);
	writeFileSync(manifestPathOf(fixture), JSON.stringify(record, null, 2));
	return record;
}

/** The pool identity every write must keep. */
function poolIdentity(record) {
	return {
		schemaVersion: record.schemaVersion,
		terminalBackend: record.terminalBackend,
		owner: record.owner,
		run: record.run,
		generation: record.generation,
		server: record.server,
		session: record.session,
		rootPane: record.rootPane,
		coreIdentity: record.coreIdentity,
	};
}

function tmuxCalls(tmux) {
	const path = tmux.socketPath + ".fake-tmux-calls.jsonl";
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).argv);
}

/** Install the fake tmux binary and its state file; returns the test-side handle. */
function installFakeTmux(fixture, options = {}) {
	const binDir = join(fixture.root, "tmux-bin");
	mkdirSync(binDir, { recursive: true });
	const socketPath = join(fixture.root, "tmux.sock");
	const statePath = socketPath + ".fake-tmux.json";
	const manifestPath = manifestPathOf(fixture);
	const launcherPid = options.launcherPid ?? LAUNCHER_PID;
	const state = {
		server: { socketPath, pid: SERVER.pid, startTime: SERVER.startTime, version: SERVER.version },
		session: { ...SESSION },
		windows: { "@0": { id: "@0", sessionId: SESSION.id } },
		panes: {
			"%0": {
				paneId: "%0",
				panePid: launcherPid,
				startCommand: ROOT_COMMAND,
				windowId: "@0",
				sessionId: SESSION.id,
				owner: "",
				run: "",
				generation: "",
				worker: "",
				title: "root",
				screen: "",
			},
		},
		nextWindow: 1,
		nextPane: 1,
		calls: 0,
		mutate: options.mutate ? { ...options.mutate, manifestPath, applied: false } : null,
		registration: null,
	};
	const tmux = { socketPath, statePath };
	tmux.calls = () => tmuxCalls(tmux);
	tmux.state = () => JSON.parse(readFileSync(statePath, "utf8"));
	tmux.patch = (patch) => {
		const next = tmux.state();
		patch(next);
		writeFileSync(statePath, JSON.stringify(next, null, 2));
		return next;
	};
	tmux.panes = () => tmux.state().panes;
	tmux.newWindows = () => tmux.calls().filter((args) => args[0] === "new-window");
	tmux.kills = () => tmux
		.calls()
		.filter((args) => args[0] === "kill-pane")
		.map((args) => args[args.indexOf("-t") + 1]);
	tmux.env = () => ({
		TMUX: socketPath + "," + SERVER.pid + ",0",
		TMUX_PANE: "%0",
		PI_MIND_WORKER_LAUNCHER_PID: String(launcherPid),
	});

	const writerPath = join(binDir, "tmux-wrapper-writer.cjs");
	writeFileSync(writerPath, FAKE_TMUX_WRITER);
	state.registration = { node: process.execPath, writer: writerPath };
	writeFileSync(statePath, JSON.stringify(state, null, 2));

	const shimPath = join(binDir, "tmux");
	writeFileSync(shimPath, FAKE_TMUX);
	chmodSync(shimPath, 0o755);
	tmux.shimPath = shimPath;
	process.env.PI_TMUX_BIN = shimPath;
	return tmux;
}

/** Write the pool record a v3 tmux launcher owns. */
function writeV3Manifest(fixture, tmux, overrides = {}) {
	const state = tmux.state();
	const record = {
		schemaVersion: 3,
		terminalBackend: "tmux",
		owner: "mind",
		run: "run-a",
		generation: fixture.generation,
		cwd: fixture.cwd,
		state: "running",
		lastUpdated: Date.now(),
		coreIdentity: {
			id: "tmux:" + state.server.socketPath + "#" + state.server.pid + "." + state.server.startTime + "/" + state.session.id,
		},
		server: state.server,
		session: state.session,
		rootPane: {
			paneId: "%0",
			panePid: state.panes["%0"].panePid,
			startCommand: state.panes["%0"].startCommand,
		},
		workerWindow: null,
		workerPanes: {},
	};
	const merged = { ...record, ...overrides };
	writeFileSync(manifestPathOf(fixture), JSON.stringify(merged, null, 2));
	return merged;
}

/** This Mind runs in the pool's own pane: captured tuple, root %pane, launcher pid. */
function pinTmuxEnv(tmux) {
	const env = tmux.env();
	process.env.TMUX = env.TMUX;
	process.env.TMUX_PANE = env.TMUX_PANE;
	process.env.PI_MIND_WORKER_LAUNCHER_PID = env.PI_MIND_WORKER_LAUNCHER_PID;
}

function pinHcEnv(fixture) {
	process.env.HC_TERMINAL_ID = fixture.rootAddress;
	process.env.HC_SESSION = "test-" + fixture.hash;
}

function queueFlashTask(mind) {
	return mind.runTool("delegate", { task: "burst please", tier: "flash" }).catch(() => {});
}

function burstEntry(fixture, workerId) {
	const tracked = fixture.readControl()?.burstWorkers;
	return Array.isArray(tracked) ? tracked.find((entry) => entry.workerId === workerId) : undefined;
}

function writeControlFile(fixture, control) {
	writeFileSync(fixture.controlPath, JSON.stringify(control, null, 2));
}

/** A leftover burst the previous module recorded, with its live pane still up. */
function leavePreviousBurst(fixture, tmux, record, workerId, address) {
	const startCommand = "/usr/bin/node /tmux-terminal.mjs --worker-exec --worker-id " + workerId;
	tmux.patch((state) => {
		state.windows["@1"] = { id: "@1", sessionId: SESSION.id };
		state.panes[address] = {
			paneId: address,
			panePid: 5100,
			startCommand,
			windowId: "@1",
			sessionId: SESSION.id,
			owner: record.owner,
			run: record.run,
			generation: String(record.generation),
			worker: workerId,
			title: "old",
			screen: "",
		};
	});
	patchRecord(fixture, (next) => {
		next.workerWindow = "@1";
		next.workerPanes = { [workerId]: { paneId: address, panePid: 5100, startCommand } };
	});
	writeControlFile(fixture, {
		status: "ready",
		generation: fixture.generation,
		lastUpdated: Date.now(),
		burstCounter: 7,
		burstWorkers: [{
			workerId,
			index: 7,
			name: "old-b7",
			address,
			terminalState: "spawned",
			generation: fixture.generation,
			coreId: record.coreIdentity.id,
			rootAddress: "%0",
			spawnedAt: Date.now(),
			spawnSettled: true,
			retireReason: null,
			sessionDir: "/sessions/old-b7",
			logFile: null,
			taskCount: 0,
			lastEvent: "spawned",
		}],
		burstEnvelope: { coreId: record.coreIdentity.id, rootAddress: "%0", generation: fixture.generation },
	});
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

test("a v3 pool spawns one burst pane, records its %pane, keeps identity and never calls hc", { timeout: 60000 }, async () => {
	// The heartbeat is what publishes the spawn into the control file; 1s keeps the
	// test fast without touching the module's own write path.
	await withTmuxPool({ burstFlash: BURST, configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 } }, async (fixture) => {
		const tmux = installFakeTmux(fixture);
		const record = writeV3Manifest(fixture, tmux);
		pinTmuxEnv(tmux);
		const mind = await fixture.load("mind");
		await mind.sessionStart();

		void queueFlashTask(mind);
		await waitUntil(() => tmux.newWindows().length === 1, { timeout: 15000, label: "one tmux new-window" });
		const address = await waitUntil(() => burstEntry(fixture, "burst-flash-1")?.address, {
			timeout: 15000,
			label: "a recorded burst address",
		});
		assert.match(address, /^%[0-9]+$/, "a tmux address is a %pane id");

		// The wrapper is argv only: --identity PI_MIND_WORKER_* pairs, never a selector.
		const args = tmux.newWindows()[0];
		const separator = args.indexOf("--");
		assert.ok(separator > 0, "the wrapper is an explicit argv program");
		const wrapperArgs = args.slice(separator + 1);
		const inner = wrapperArgs.indexOf("--");
		const wrapper = wrapperArgs.slice(0, inner);
		const program = wrapperArgs.slice(inner + 1);
		assert.equal(wrapper[wrapper.indexOf("--worker-id") + 1], "burst-flash-1");
		assert.equal(wrapper.includes("--root-pane"), false, "no invented flag");
		const identity = wrapper.filter((_, index) => wrapper[index - 1] === "--identity");
		assert.deepEqual(identity.map((pair) => pair.split("=")[0]), [
			"PI_MIND_WORKER_ROLE",
			"PI_MIND_WORKER_TIER",
			"PI_MIND_WORKER_ID",
			"PI_MIND_WORKER_GENERATION",
			"PI_MIND_WORKER_SESSION_DIR",
		]);
		for (const pair of identity) assert.ok(!pair.startsWith("HC_"), "no hc selector may travel to a tmux child");
		assert.equal(program[0], "/usr/bin/mise");
		assert.equal(program[program.indexOf("--model") + 1], "vendor/burst");
		assert.equal(program[program.indexOf("--thinking") + 1], "max");
		for (const hcOnly of ["--bg", "--rm", "--parent", "rpc"]) {
			assert.equal(program.includes(hcOnly), false, "no hc-only flag in a tmux spawn");
		}

		// The pane is registered, in the one reserved window, and the pool is unchanged.
		const after = readRecord(fixture);
		assert.deepEqual(poolIdentity(after), poolIdentity(record));
		assert.equal(after.workerWindow, "@1");
		assert.equal(after.workerPanes["burst-flash-1"].paneId, address);
		assert.equal(burstEntry(fixture, "burst-flash-1").address, address);
		assert.equal(fixture.fakeHc.calls().length, 0, "a v3 pool never calls hc");

		// Retirement kills exactly that pane.
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => !tmux.panes()[address], { timeout: 15000, label: "the owned pane retired" });
		assert.deepEqual(tmux.kills(), [address]);
		assert.deepEqual(poolIdentity(readRecord(fixture)), poolIdentity(record));
	});
});

test("a v2 pool never touches tmux, even with a live tmux pane in the environment", { timeout: 60000 }, async () => {
	await withTmuxPool({ burstFlash: BURST }, async (fixture) => {
		const tmux = installFakeTmux(fixture);
		pinTmuxEnv(tmux);
		pinHcEnv(fixture);
		const hc = fixture.fakeHc;
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitUntil(() => hc.runs().length === 1, { timeout: 15000, label: "the v2/hc burst run" });
		assert.deepEqual(tmux.calls(), [], "a v2/hc pool never calls tmux");
	});
});

test("the launcher pid, not Mind's own pid, proves the root pane", { timeout: 60000 }, async () => {
	await withTmuxPool({ burstFlash: BURST }, async (fixture) => {
		const tmux = installFakeTmux(fixture);
		writeV3Manifest(fixture, tmux);
		pinTmuxEnv(tmux);
		// Mind is the launcher's child: its pid is not the pane's direct program.
		process.env.PI_MIND_WORKER_LAUNCHER_PID = String(process.pid);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitUntil(() => /root probe failed/.test(fixture.readLog()), { timeout: 15000, label: "root pid refusal" });
		assert.equal(tmux.newWindows().length, 0, "no pane on an unproven root");
		assert.match(fixture.readLog(), new RegExp(String(process.pid)));
	});
});

test("a stale server tuple refuses the burst before any pane exists", { timeout: 60000 }, async () => {
	await withTmuxPool({ burstFlash: BURST }, async (fixture) => {
		const tmux = installFakeTmux(fixture);
		writeV3Manifest(fixture, tmux, { server: { ...SERVER, socketPath: tmux.socketPath, startTime: SERVER.startTime - 1000 } });
		pinTmuxEnv(tmux);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitUntil(() => /not the recorded tuple/.test(fixture.readLog()), { timeout: 15000, label: "stale tuple refusal" });
		assert.equal(tmux.newWindows().length, 0, "no pane on a stale tuple");
		assert.deepEqual(readRecord(fixture).workerPanes, {});
	});
});

test("a record that changes while pinning is refused before any pane exists", { timeout: 120000 }, async () => {
	for (const [field, value] of [["owner", "another-owner"], ["run", "another-run"], ["generation", 99]]) {
		await withTmuxPool({ burstFlash: BURST }, async (fixture) => {
			const tmux = installFakeTmux(fixture, { mutate: { after: 2, set: { [field]: value } } });
			writeV3Manifest(fixture, tmux);
			pinTmuxEnv(tmux);
			const mind = await fixture.load("mind");
			await mind.sessionStart();
			void queueFlashTask(mind);
			await waitUntil(() => /burst spawn refused/.test(fixture.readLog()), {
				timeout: 15000,
				label: "refusal for a changed " + field,
			});
			assert.equal(tmux.newWindows().length, 0, "a changed " + field + " must be refused before a pane exists");
			assert.deepEqual(readRecord(fixture).workerPanes, {}, "nothing was registered for a changed " + field);
		});
	}
});

test("retirement kills only the pane the record owns", { timeout: 60000 }, async () => {
	await withTmuxPool({ burstFlash: BURST, configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 } }, async (fixture) => {
		const tmux = installFakeTmux(fixture);
		writeV3Manifest(fixture, tmux);
		pinTmuxEnv(tmux);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		const address = await waitUntil(() => burstEntry(fixture, "burst-flash-1")?.address, {
			timeout: 15000,
			label: "a recorded burst address",
		});
		// A pane the user opened in the same window carries none of our markers.
		tmux.patch((state) => {
			state.panes["%9"] = {
				paneId: "%9",
				panePid: 9999,
				startCommand: "/usr/bin/nvim",
				windowId: "@1",
				sessionId: SESSION.id,
				owner: "",
				run: "",
				generation: "",
				worker: "",
				title: "nvim",
				screen: "",
			};
		});
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => !tmux.panes()[address], { timeout: 15000, label: "the owned pane retired" });
		assert.ok(tmux.panes()["%9"], "an unowned pane is never killed");
		assert.deepEqual(tmux.kills(), [address]);
	});
});

test("a static and a burst spawn share one reserved window and one record identity", { timeout: 60000 }, async () => {
	await withTmuxPool({}, async (fixture) => {
		const tmux = installFakeTmux(fixture);
		const record = writeV3Manifest(fixture, tmux);
		pinTmuxEnv(tmux);
		const manifestPath = manifestPathOf(fixture);
		const clientEnv = { TMUX: tmux.env().TMUX, TMUX_PANE: "%0" };
		const expectedCoreId = record.coreIdentity.id;
		const spawn = (workerId, name) => spawnWorkerTerminal({
			manifestPath,
			workerId,
			rootAddress: "%0",
			name,
			cwd: fixture.cwd,
			argv: ["/bin/true"],
			env: {
				PI_MIND_WORKER_ROLE: "worker",
				PI_MIND_WORKER_TIER: "flash",
				PI_MIND_WORKER_ID: workerId,
				PI_MIND_WORKER_GENERATION: String(fixture.generation),
			},
			clientEnv,
			expectedCoreId,
		});

		const [first, second] = await Promise.all([
			spawn("worker-0", "run-b0"),
			spawn("burst-flash-1", "run-b1"),
		]);
		assert.deepEqual([first.address, second.address].sort(), ["%1", "%2"]);
		assert.equal(tmux.newWindows().length, 1, "one reserved worker window for both spawns");

		const after = readRecord(fixture);
		assert.equal(after.workerWindow, "@1");
		assert.deepEqual(Object.keys(after.workerPanes).sort(), ["burst-flash-1", "worker-0"]);
		assert.deepEqual(poolIdentity(after), poolIdentity(record), "a spawn never rewrites the pool identity");

		// The update helper keeps the identity and every fresh pane as well.
		const updated = await updatePoolManifest(manifestPath, { state: "running", lastUpdated: 7 }, {
			owner: record.owner,
			run: record.run,
			generation: record.generation,
			expectedCoreId,
		});
		assert.equal(updated.state, "running");
		assert.equal(updated.lastUpdated, 7);
		assert.deepEqual(poolIdentity(updated), poolIdentity(record));
		assert.deepEqual(Object.keys(updated.workerPanes).sort(), ["burst-flash-1", "worker-0"]);
	});
});

test("the extension's v3 manifest write goes through the lock and keeps fresh identity and panes", { timeout: 60000 }, async () => {
	await withTmuxPool({ configOverrides: { dashboardEnabled: true } }, async (fixture) => {
		const tmux = installFakeTmux(fixture);
		const record = writeV3Manifest(fixture, tmux, { state: "starting" });
		pinTmuxEnv(tmux);
		const manifestPath = manifestPathOf(fixture);
		// A pane registered before Mind starts is exactly what a plain read-modify-write
		// of the record would drop.
		await spawnWorkerTerminal({
			manifestPath,
			workerId: "worker-0",
			rootAddress: "%0",
			name: "run-b0",
			cwd: fixture.cwd,
			argv: ["/bin/true"],
			env: {
				PI_MIND_WORKER_ROLE: "worker",
				PI_MIND_WORKER_TIER: "flash",
				PI_MIND_WORKER_ID: "worker-0",
				PI_MIND_WORKER_GENERATION: String(fixture.generation),
			},
			clientEnv: { TMUX: tmux.env().TMUX, TMUX_PANE: "%0" },
			expectedCoreId: record.coreIdentity.id,
		});

		const mind = await fixture.load("mind");
		await mind.sessionStart();
		await waitUntil(() => readRecord(fixture).state === "running", { timeout: 15000, label: "state: running" });
		const after = readRecord(fixture);
		assert.deepEqual(poolIdentity(after), poolIdentity(record));
		assert.equal(after.workerWindow, "@1");
		assert.equal(after.workerPanes["worker-0"].paneId, "%1");

		// A caller with a stale generation cannot write into the new run.
		await assert.rejects(
			() => updatePoolManifest(manifestPath, { state: "stopped" }, { generation: record.generation + 1 }),
			/stale generation/,
		);
		assert.deepEqual(poolIdentity(readRecord(fixture)), poolIdentity(record));
		assert.equal(readRecord(fixture).state, "running");
	});
});

test("/reload adoption is cleanup only: it retires the leftover pane and never resets an agent", { timeout: 60000 }, async () => {
	await withTmuxPool({ burstFlash: BURST, configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 60000 } }, async (fixture) => {
		const tmux = installFakeTmux(fixture);
		const record = writeV3Manifest(fixture, tmux);
		pinTmuxEnv(tmux);
		leavePreviousBurst(fixture, tmux, record, "burst-flash-7", "%1");

		const mind = await fixture.load("mind");
		await mind.sessionStart();
		await waitUntil(() => /adopted 1 tracked terminal\(s\) for reload cleanup/.test(fixture.readLog()), {
			timeout: 15000,
			label: "cleanup adoption",
		});
		await waitUntil(() => !tmux.panes()["%1"], { timeout: 15000, label: "the adopted pane retired" });
		assert.equal(tmux.newWindows().length, 0, "adoption never spawns");
		assert.equal(tmux.kills().length, 1, "one targeted kill, no sweep");
		assert.equal(mind.newSessionCount, 0, "adoption never resets the agent");
		assert.deepEqual(mind.userMessages, [], "adoption never sends a message");
	});
});

test("a persisted burst snapshot on another envelope is never adopted", { timeout: 60000 }, async () => {
	await withTmuxPool({ burstFlash: BURST, configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 60000 } }, async (fixture) => {
		const tmux = installFakeTmux(fixture);
		const record = writeV3Manifest(fixture, tmux);
		pinTmuxEnv(tmux);
		leavePreviousBurst(fixture, tmux, record, "burst-flash-7", "%1");
		// The durable snapshot belongs to a previous tmux server.
		writeControlFile(fixture, {
			...fixture.readControl(),
			burstEnvelope: { coreId: "tmux:/tmp/other#1.2/$9", rootAddress: "%0", generation: fixture.generation },
		});

		const mind = await fixture.load("mind");
		await mind.sessionStart();
		await waitUntil(() => /another pool envelope/.test(fixture.readLog()), { timeout: 15000, label: "envelope refusal" });
		assert.ok(tmux.panes()["%1"], "a foreign snapshot kills nothing");
		assert.equal(tmux.newWindows().length, 0, "a foreign snapshot spawns nothing");
	});
});
