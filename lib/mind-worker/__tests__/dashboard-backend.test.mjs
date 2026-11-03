// dashboard-backend.test.mjs — node:test tests for backend pure logic.
// Tests: normalizeState, running detection, sort, formatStateTag, resolveAgentDir,
// readJsonl, parseInstance label priority, scanInstances integration.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
	normalizeState,
	sortInstances,
	formatStateTag,
	resolveAgentDir,
	readJsonl,
	parseInstance,
	scanInstances,
} from "../dashboard-backend.mjs";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeInst(opts = {}) {
	const hash = opts.hash || "a1b2c3d4e5f6a7b8";
	return {
		hash,
		cwd: opts.cwd || "/home/user/project",
		label: opts.label || "project",
		shortHash: hash.slice(0, 8),
		manifest: opts.manifest ?? { state: "running" },
		control: opts.control ?? null,
		results: opts.results ?? [],
		responses: opts.responses ?? [],
		mindPid: opts.mindPid ?? 12345,
		mindPidAlive: opts.mindPidAlive ?? true,
		heartbeat: opts.heartbeat ?? Date.now(),
		heartbeatFresh: opts.heartbeatFresh ?? true,
		socketExists: opts.socketExists ?? true,
		socketConnectable: opts.socketConnectable ?? false,
		workersConnected: opts.workersConnected ?? 1,
		workersExpected: opts.workersExpected ?? 1,
		state: "unknown",
		running: false,
		activeTasks: opts.activeTasks ?? [],
		queuedTasks: opts.queuedTasks ?? [],
		workers: opts.workers ?? [],
		lastResultSummary: opts.lastResultSummary ?? null,
		lastResponseSnippet: opts.lastResponseSnippet ?? null,
		// Apply overrides last so test can override state/running etc.
		...opts,
	};
}

// --------------------------------------------------------------------------
// normalizeState
// --------------------------------------------------------------------------

describe("normalizeState", () => {
	it("idle when control.status === 'worker-connected' with full workers", () => {
		const inst = makeInst({
			control: { status: "worker-connected", connectedWorkers: 3, expectedWorkers: 3 },
			workersConnected: 3,
			workersExpected: 3,
		});
		normalizeState(inst, 30000);
		assert.equal(inst.running, true);
		assert.equal(inst.state, "idle");
	});

	it("busy when control.status === 'busy'", () => {
		const inst = makeInst({ control: { status: "busy", connectedWorkers: 3, expectedWorkers: 3 } });
		normalizeState(inst, 30000);
		assert.equal(inst.state, "busy");
	});

	it("busy when activeTasks is non-empty", () => {
		const inst = makeInst({
			control: { status: "worker-connected", connectedWorkers: 3, expectedWorkers: 3 },
			activeTasks: [{ taskId: "abc", tier: "flash", description: "do thing" }],
		});
		normalizeState(inst, 30000);
		assert.equal(inst.state, "busy");
	});

	it("degraded when connectedWorkers < expectedWorkers", () => {
		const inst = makeInst({
			control: { status: "worker-connected", connectedWorkers: 1, expectedWorkers: 3 },
			workersConnected: 1,
			workersExpected: 3,
		});
		normalizeState(inst, 30000);
		assert.equal(inst.state, "degraded");
	});

	it("error when control.status === 'error'", () => {
		const inst = makeInst({
			control: { status: "error", message: "something broke" },
		});
		normalizeState(inst, 30000);
		assert.equal(inst.state, "error");
	});

	it("error when control.message is set (even if status is worker-connected)", () => {
		const inst = makeInst({
			control: { status: "worker-connected", message: "something wrong", connectedWorkers: 3, expectedWorkers: 3 },
		});
		normalizeState(inst, 30000);
		assert.equal(inst.state, "error");
	});

	it("unknown when manifest state is not 'running'", () => {
		const inst = makeInst({ manifest: { state: "stopped" } });
		normalizeState(inst, 30000);
		assert.equal(inst.running, false);
		assert.equal(inst.state, "unknown");
	});

	it("unknown when mindPidAlive is false", () => {
		const inst = makeInst({ mindPidAlive: false });
		normalizeState(inst, 30000);
		assert.equal(inst.running, false);
		assert.equal(inst.state, "unknown");
	});

	it("unknown when heartbeatFresh is false", () => {
		const inst = makeInst({ heartbeatFresh: false });
		normalizeState(inst, 30000);
		assert.equal(inst.running, false);
		assert.equal(inst.state, "unknown");
	});

	it("unknown when no socket AND no workers (running detection fails)", () => {
		const inst = makeInst({
			socketExists: false,
			workersConnected: 0,
			control: { connectedWorkers: 0, expectedWorkers: 3 },
		});
		normalizeState(inst, 30000);
		assert.equal(inst.running, false);
		assert.equal(inst.state, "unknown");
	});

	it("running when socket exists but no workers — normalizeState sets degraded (workers < expected) but keeps running=true", () => {
		// No workers but socket exists → running detection passes (socket OR workers).
		// Workers 0 < expected 3 → degraded state per D8.
		const inst = makeInst({
			socketExists: true,
			workersConnected: 0,
			workersExpected: 3,
			control: { status: "ready", connectedWorkers: 0, expectedWorkers: 3 },
		});
		normalizeState(inst, 30000);
		assert.equal(inst.running, true);
		assert.equal(inst.state, "degraded");
	});

	it("running when workers connected but no socket (socket OR workers)", () => {
		const inst = makeInst({
			socketExists: false,
			workersConnected: 2,
			control: { status: "worker-connected", connectedWorkers: 2, expectedWorkers: 2 },
			workersExpected: 2,
		});
		normalizeState(inst, 30000);
		assert.equal(inst.running, true);
		assert.equal(inst.state, "idle");
	});

	it("fallback idle when control is null but manifest running", () => {
		const inst = makeInst({ control: null });
		normalizeState(inst, 30000);
		assert.equal(inst.running, true);
		assert.equal(inst.state, "idle");
	});
});

// --------------------------------------------------------------------------
// sortInstances
// --------------------------------------------------------------------------

describe("sortInstances", () => {
	it("busy before idle before unknown (non-running)", () => {
		const busy = makeInst({ state: "busy", running: true, heartbeat: Date.now() });
		const idle = makeInst({ state: "idle", running: true, heartbeat: Date.now() });
		const stopped = makeInst({ state: "unknown", running: false, heartbeat: Date.now() });

		const sorted = sortInstances([idle, busy, stopped]);
		assert.equal(sorted[0].state, "busy");
		assert.equal(sorted[1].state, "idle");
		assert.equal(sorted[2].state, "unknown");
	});

	it("running before non-running", () => {
		const running = makeInst({ state: "idle", running: true });
		const stopped = makeInst({ state: "unknown", running: false });

		const sorted = sortInstances([stopped, running]);
		assert.equal(sorted[0].running, true);
		assert.equal(sorted[1].running, false);
	});
});

// --------------------------------------------------------------------------
// formatStateTag
// --------------------------------------------------------------------------

describe("formatStateTag", () => {
	it("returns ANSI codes for known states", () => {
		assert.match(formatStateTag("busy"), /\x1b\[33m/);
		assert.match(formatStateTag("idle"), /\x1b\[32m/);
		assert.match(formatStateTag("error"), /\x1b\[31m/);
		assert.match(formatStateTag("degraded"), /\x1b\[35m/);
	});

	it("returns gray ? for unknown state", () => {
		assert.match(formatStateTag("unknown"), /\x1b\[90m/);
		assert.match(formatStateTag("nonsense"), /\x1b\[90m/);
	});
});

// --------------------------------------------------------------------------
// resolveAgentDir
// --------------------------------------------------------------------------

describe("resolveAgentDir", () => {
	it("uses overrides.agentDir when provided", () => {
		const result = resolveAgentDir({ agentDir: "/custom/path" });
		assert.equal(result, "/custom/path");
	});

	it("uses PI_AGENT_HOME env when set", () => {
		process.env.PI_AGENT_HOME = "/env/pi-home";
		try {
			const result = resolveAgentDir();
			assert.equal(result, "/env/pi-home");
		} finally {
			delete process.env.PI_AGENT_HOME;
		}
	});

	it("falls back to ~/.pi/agent when no env or override", () => {
		delete process.env.PI_AGENT_HOME;
		const result = resolveAgentDir();
		assert.match(result, /\.pi\/agent$/);
	});
});

// --------------------------------------------------------------------------
// Temp dir for filesystem integration tests
// --------------------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "mw-test-"));
const mindworker = join(tmpDir, "mindworker");
mkdirSync(mindworker, { recursive: true });

const hash = "abcd1234abcd1234";

// Write manifest with label (use real PID so mindPidAlive is true)
writeFileSync(
	join(mindworker, `${hash}-manifest.json`),
	JSON.stringify({ cwd: "/some/project", cwdHash: hash, state: "running", label: "my-label", generation: 1, mindPid: process.pid, lastUpdated: Date.now(), startedAt: Date.now() }),
);
// Write control file
writeFileSync(
	join(mindworker, `${hash}-mind-control.json`),
	JSON.stringify({ status: "worker-connected", generation: 1, lastUpdated: Date.now(), connectedWorkers: 2, expectedWorkers: 2 }),
);
// Write socket file (empty, just exists)
writeFileSync(join(mindworker, `${hash}.sock`), "");
// Write results JSONL
writeFileSync(
	join(mindworker, `${hash}-results.jsonl`),
	'{"id":1,"summary":"Fixed auth"}\n{"id":2,"summary":"Added tests"}\n',
);
// Write responses JSONL
writeFileSync(
	join(mindworker, `${hash}-responses.jsonl`),
	'{"text":"Refactored auth module"}\n{"text":"Added test coverage"}\n',
);

// Also write a second manifest without label (for basename fallback test, use real PID)
const hash2 = "bbbbccccbbbbcccc";
writeFileSync(
	join(mindworker, `${hash2}-manifest.json`),
	JSON.stringify({ cwd: "/home/user/my-awesome-project", cwdHash: hash2, state: "running", generation: 1, mindPid: process.pid, lastUpdated: Date.now(), startedAt: Date.now() }),
);

// Manifest v2 (hc) instance with native burst records. Top-level burstWorkers carries
// every tracked burst, pending ones included; control.workers carries the connected
// subset. The stale pid/launchMode/paneTitle/kittyWindowId fields must be dropped.
const hash3 = "ccccddddeeeeffff";
writeFileSync(
	join(mindworker, `${hash3}-manifest.json`),
	JSON.stringify({
		schemaVersion: 2,
		terminalBackend: "hc",
		rootTerminalAddress: "m7f3a2-root",
		cwd: "/some/hc-project",
		cwdHash: hash3,
		state: "running",
		generation: 3,
		mindPid: process.pid,
		lastUpdated: Date.now(),
		startedAt: Date.now(),
	}),
);
writeFileSync(
	join(mindworker, `${hash3}-mind-control.json`),
	JSON.stringify({
		status: "worker-connected",
		generation: 3,
		lastHeartbeat: Date.now(),
		lastUpdated: Date.now(),
		connectedWorkers: 2,
		expectedWorkers: 2,
		workers: [
			{ workerId: "w-0", tier: "flash", busy: false },
			{
				workerId: "burst-flash-1", tier: "flash", busy: true, burst: true,
				address: "w3:p2#k9f2", terminalState: "busy",
				sessionDir: "/sessions/burst-flash-1", logFile: "/logs/burst-flash-1.log",
				taskCount: 2, lastEvent: "task-started",
				pid: 4242, launchMode: "kitty", paneTitle: "pane-a", kittyWindowId: 7,
			},
		],
		burstWorkers: [
			{
				workerId: "burst-flash-1", address: "w3:p2#k9f2", terminalState: "busy",
				sessionDir: "/sessions/burst-flash-1", logFile: "/logs/burst-flash-1.log",
				taskCount: 2, lastEvent: "task-started",
			},
			{
				workerId: "burst-flash-2", address: null, terminalState: "pending",
				sessionDir: "/sessions/burst-flash-2", logFile: "/logs/burst-flash-2.log",
				taskCount: 0, lastEvent: "spawn-pending",
			},
		],
	}),
);

// Manifest v2 written by an --instance pool: static worker addresses and
// per-worker session dirs exist only in the manifest. control.workers carries
// id/tier/busy only, plus stale kitty fields left by an older record.
const hash5 = "dev-1111222233334444";
writeFileSync(
	join(mindworker, `${hash5}-manifest.json`),
	JSON.stringify({
		schemaVersion: 2,
		terminalBackend: "hc",
		rootTerminalAddress: "w1:p0#root",
		cwd: "/some/instance-project",
		cwdHash: "1111222233334444",
		instance: "dev",
		state: "running",
		generation: 4,
		mindPid: process.pid,
		lastUpdated: Date.now(),
		startedAt: Date.now(),
		workerAddresses: {
			"worker-0": "w1:p1#i0",
			"worker-1": "w1:p2#i1",
			"worker-2": "w1:p3#i2",
			"worker-007": "w1:p9#fake",
		},
	}),
);
writeFileSync(
	join(mindworker, `${hash5}-mind-control.json`),
	JSON.stringify({
		status: "worker-connected",
		generation: 4,
		lastHeartbeat: Date.now(),
		lastUpdated: Date.now(),
		connectedWorkers: 3,
		expectedWorkers: 3,
		workers: [
			{ workerId: "worker-1", tier: "strong", busy: true, taskId: "task-9" },
			{ workerId: "worker-0", tier: "flash", busy: false },
			{ workerId: "worker-2", tier: "flash", busy: false, pid: 4242, launchMode: "kitty", paneTitle: "pane-a", kittyWindowId: 7 },
			{ workerId: "worker-007", tier: "flash", busy: false },
			{ workerId: "burst-flash-1", tier: "flash", busy: true, burst: true, address: "w9:p9#b1", terminalState: "busy" },
		],
		burstWorkers: [
			{ workerId: "burst-flash-1", address: "w9:p9#b1", terminalState: "busy", sessionDir: "/sessions/burst-flash-1", logFile: null, taskCount: 1, lastEvent: "task-start" },
		],
	}),
);

// Legacy manifest: neither schemaVersion 2 nor an hc backend marker, so there is
// no recorded static-worker location and none may be invented.
const hash6 = "ffff000011112222";
writeFileSync(
	join(mindworker, `${hash6}-manifest.json`),
	JSON.stringify({ cwd: "/some/legacy-project", cwdHash: hash6, state: "running", generation: 1, mindPid: process.pid, lastUpdated: Date.now() }),
);
writeFileSync(
	join(mindworker, `${hash6}-mind-control.json`),
	JSON.stringify({ status: "worker-connected", generation: 1, lastUpdated: Date.now(), connectedWorkers: 1, expectedWorkers: 1, workers: [{ workerId: "worker-0", tier: "flash", busy: false }] }),
);

// Manifest v2 without cwdHash: the address is recorded, the transcript dir is not
// derivable (the launcher's session dir is keyed by it), so it stays null.
const hash7 = "abcdefabcdef0001";
writeFileSync(
	join(mindworker, `${hash7}-manifest.json`),
	JSON.stringify({
		schemaVersion: 2,
		terminalBackend: "hc",
		cwd: "/some/no-hash-project",
		state: "running",
		generation: 2,
		mindPid: process.pid,
		lastUpdated: Date.now(),
		workerAddresses: { "worker-0": "w1:p5#x0" },
	}),
);
writeFileSync(
	join(mindworker, `${hash7}-mind-control.json`),
	JSON.stringify({ status: "worker-connected", generation: 2, lastUpdated: Date.now(), connectedWorkers: 1, expectedWorkers: 1, workers: [{ workerId: "worker-0", tier: "flash", busy: false }] }),
);

// Manifest v3 written by a tmux pool: static worker panes are exact %panes, and
// the transcript dir is the one the module's wrapper put in the start command.
// There is no hc field in this record and none may be borrowed.
const hash8 = "1111222233334444";
const tmuxSocket = "/tmp/fixture-tmux/default";
const tmuxSessionDir0 = "/sessions/worker-1111222233334444-0";
writeFileSync(
	join(mindworker, `${hash8}-manifest.json`),
	JSON.stringify({
		schemaVersion: 3,
		terminalBackend: "tmux",
		owner: "mind",
		run: "run-a",
		generation: 3,
		cwd: "/some/tmux-project",
		state: "running",
		mindPid: process.pid,
		lastUpdated: Date.now(),
		coreIdentity: { id: "tmux:" + tmuxSocket + "#900.1700000000/$0" },
		server: { socketPath: tmuxSocket, pid: 900, startTime: 1700000000, version: "tmux 3.8" },
		session: { id: "$0", created: 1700000001 },
		rootPane: { paneId: "%0", panePid: 4100, startCommand: "/usr/bin/mise x node@26 -- node /pi/dist/cli.js" },
		workerWindow: "@1",
		workerPanes: {
			"worker-0": {
				paneId: "%1",
				panePid: 5001,
				startCommand: "/usr/bin/node /tmux-terminal.mjs --worker-exec --worker-id worker-0 --identity PI_MIND_WORKER_SESSION_DIR="
					+ tmuxSessionDir0 + " -- /usr/bin/mise x node@26 -- node /pi/dist/cli.js --session-dir " + tmuxSessionDir0,
			},
			"worker-1": { paneId: "%2", panePid: 5002, startCommand: "/usr/bin/node /tmux-terminal.mjs --worker-exec" },
		},
	}),
);
writeFileSync(
	join(mindworker, `${hash8}-mind-control.json`),
	JSON.stringify({
		status: "worker-connected",
		generation: 3,
		lastHeartbeat: Date.now(),
		lastUpdated: Date.now(),
		connectedWorkers: 1,
		expectedWorkers: 2,
		workers: [
			{ workerId: "worker-0", tier: "flash", busy: false },
			{ workerId: "worker-1", tier: "flash", busy: false },
		],
	}),
);

// Cross records: v3 with an hc backend, and v2 with tmux. Neither is a pool, so
// neither address shape may be read out of one.
const hash9 = "2222333344445555";
const crossFields = {
	rootTerminalAddress: "w1:p1#root",
	workerAddresses: { "worker-0": "w1:p2#x" },
	workerPanes: { "worker-0": { paneId: "%7", panePid: 5, startCommand: "PI_MIND_WORKER_SESSION_DIR=/sessions/cross" } },
	cwd: "/cross-project",
	state: "running",
	generation: 1,
	mindPid: process.pid,
	lastUpdated: Date.now(),
};
writeFileSync(
	join(mindworker, `${hash9}-manifest.json`),
	JSON.stringify({ ...crossFields, schemaVersion: 3, terminalBackend: "hc" }),
);
writeFileSync(
	join(mindworker, `${hash9}-mind-control.json`),
	JSON.stringify({ status: "worker-connected", generation: 1, lastUpdated: Date.now(), connectedWorkers: 1, expectedWorkers: 1, workers: [{ workerId: "worker-0", tier: "flash", busy: false }] }),
);
const hash10 = "3333444455556666";
writeFileSync(
	join(mindworker, `${hash10}-manifest.json`),
	JSON.stringify({ ...crossFields, schemaVersion: 2, terminalBackend: "tmux" }),
);
writeFileSync(
	join(mindworker, `${hash10}-mind-control.json`),
	JSON.stringify({ status: "worker-connected", generation: 1, lastUpdated: Date.now(), connectedWorkers: 1, expectedWorkers: 1, workers: [{ workerId: "worker-0", tier: "flash", busy: false }] }),
);

// --------------------------------------------------------------------------
// readJsonl — JSONL reading
// --------------------------------------------------------------------------

describe("readJsonl", () => {
	it("returns empty array for missing file", () => {
		const result = readJsonl("/nonexistent/path.jsonl");
		assert.ok(Array.isArray(result));
		assert.equal(result.length, 0);
	});

	it("returns last N entries within limit", () => {
		// Write temp multi-line JSONL
		const p = join(mindworker, "test-multi.jsonl");
		writeFileSync(p, [1,2,3,4].map(i => JSON.stringify({id:i})).join("\n") + "\n");
		const result = readJsonl(p, 2);
		assert.equal(result.length, 2);
		assert.equal(result[0].id, 3);
		assert.equal(result[1].id, 4);
	});

	it("skips invalid JSON lines silently", () => {
		const p = join(mindworker, "test-bad.jsonl");
		const lines = [
			'{"valid":1}',
			"not json at all",
			'{"valid":2}',
			"",
			"{corrupt}",
		];
		writeFileSync(p, lines.join("\n") + "\n");
		const result = readJsonl(p, 10);
		assert.equal(result.length, 2);
		assert.equal(result[0].valid, 1);
		assert.equal(result[1].valid, 2);
	});

	it("returns all entries when count < max", () => {
		const p = join(mindworker, "test-all.jsonl");
		writeFileSync(p, [1,2,3].map(i => JSON.stringify({id:i})).join("\n") + "\n");
		const result = readJsonl(p, 100);
		assert.equal(result.length, 3);
		assert.equal(result[0].id, 1);
		assert.equal(result[2].id, 3);
	});
});

// --------------------------------------------------------------------------
// parseInstance — integration with filesystem
// --------------------------------------------------------------------------

describe("parseInstance", () => {
	it("prefers manifest.label over basename(cwd)", () => {
		const inst = parseInstance(tmpDir, hash, 30000);
		assert.ok(inst, "instance should be parsed");
		assert.equal(inst.label, "my-label");
	});

	it("parses correct instance metadata", () => {
		const inst = parseInstance(tmpDir, hash, 30000);
		assert.equal(inst.hash, hash);
		assert.equal(inst.cwd, "/some/project");
		assert.equal(inst.shortHash, "abcd1234");
		assert.equal(inst.workersConnected, 2);
		assert.equal(inst.workersExpected, 2);
		assert.equal(inst.mindPidAlive, true);
	});

	it("reads last result summary from results.jsonl", () => {
		const inst = parseInstance(tmpDir, hash, 30000);
		assert.equal(inst.lastResultSummary, "Added tests");
	});

	it("reads last response snippet from responses.jsonl", () => {
		const inst = parseInstance(tmpDir, hash, 30000);
		assert.equal(inst.lastResponseSnippet, "Added test coverage");
	});

	it("sets socketConnectable equal to socketExists (no active probe)", () => {
		const inst = parseInstance(tmpDir, hash, 30000);
		assert.equal(inst.socketConnectable, inst.socketExists);
		assert.equal(inst.socketConnectable, true);
	});

	it("reads only the pi-written control file next to the manifest", () => {
		const external = join(tmpDir, "external-control.json");
		writeFileSync(external, JSON.stringify({ status: "busy", lastUpdated: Date.now() }));
		process.env.MINDMUX_CONTROL_FILE = external;
		process.env.MINDMUX_MANIFEST = join(tmpDir, "mindworker", `${hash}-manifest.json`);
		try {
			const inst = parseInstance(tmpDir, hash, 30000);
			assert.equal(inst.control.status, "worker-connected", "a Go control path never reaches a legacy record");
		} finally {
			delete process.env.MINDMUX_CONTROL_FILE;
			delete process.env.MINDMUX_MANIFEST;
		}
	});

	it("returns null for missing manifest", () => {
		const result = parseInstance(tmpDir, "badbadbadbadbad1", 30000);
		assert.equal(result, null);
	});

	it("uses basename(cwd) as label when no manifest.label", () => {
		const inst = parseInstance(tmpDir, hash2, 30000);
		assert.equal(inst.label, "my-awesome-project");
	});
});

// --------------------------------------------------------------------------
// Native burst records (address + lifecycle state)
// --------------------------------------------------------------------------

describe("burst workers", () => {
	it("merges tracked bursts from control.burstWorkers and connected control.workers, top-level first", () => {
		const inst = parseInstance(tmpDir, hash3, 30000);
		assert.deepEqual(inst.burstWorkers.map((b) => b.workerId), ["burst-flash-1", "burst-flash-2"]);
	});

	it("keeps only the native shape: address, terminalState, sessionDir, logFile, taskCount, lastEvent", () => {
		const inst = parseInstance(tmpDir, hash3, 30000);
		assert.deepEqual(inst.burstWorkers[0], {
			workerId: "burst-flash-1",
			address: "w3:p2#k9f2",
			terminalState: "busy",
			sessionDir: "/sessions/burst-flash-1",
			logFile: "/logs/burst-flash-1.log",
			taskCount: 2,
			lastEvent: "task-started",
		});
	});

	it("keeps a pending burst that has no address yet", () => {
		const inst = parseInstance(tmpDir, hash3, 30000);
		const pending = inst.burstWorkers.find((b) => b.workerId === "burst-flash-2");
		assert.equal(pending.address, null);
		assert.equal(pending.terminalState, "pending");
	});
});

// --------------------------------------------------------------------------
// Static worker address and transcript dir
// --------------------------------------------------------------------------

describe("static workers", () => {
	it("derives both addresses from manifest.workerAddresses", () => {
		const inst = parseInstance(tmpDir, hash5, 30000);
		const byId = new Map(inst.workers.map((w) => [w.workerId, w]));
		assert.equal(byId.get("worker-0").address, "w1:p1#i0");
		assert.equal(byId.get("worker-1").address, "w1:p2#i1");
	});

	it("derives instance-aware per-worker session dirs, indexed by worker id not array order", () => {
		const inst = parseInstance(tmpDir, hash5, 30000);
		const byId = new Map(inst.workers.map((w) => [w.workerId, w]));
		const sessions = join(tmpDir, "sessions");
		assert.equal(byId.get("worker-0").sessionDir, join(sessions, "worker-dev-1111222233334444-0"));
		assert.equal(byId.get("worker-1").sessionDir, join(sessions, "worker-dev-1111222233334444-1"));
		assert.equal(byId.get("worker-2").sessionDir, join(sessions, "worker-dev-1111222233334444-2"));
	});

	it("keeps static fields to the whitelist and drops stale kitty fields", () => {
		const inst = parseInstance(tmpDir, hash5, 30000);
		const worker = inst.workers.find((w) => w.workerId === "worker-2");
		assert.deepEqual(worker, {
			workerId: "worker-2",
			tier: "flash",
			busy: false,
			taskId: undefined,
			connectedAt: undefined,
			address: "w1:p3#i2",
			sessionDir: join(tmpDir, "sessions", "worker-dev-1111222233334444-2"),
		});
		assert.equal("pid" in worker, false);
		assert.equal("launchMode" in worker, false);
		assert.equal("paneTitle" in worker, false);
		assert.equal("kittyWindowId" in worker, false);
	});

	it("invents nothing for a non-canonical worker id", () => {
		const inst = parseInstance(tmpDir, hash5, 30000);
		const worker = inst.workers.find((w) => w.workerId === "worker-007");
		assert.equal(worker.address, null);
		assert.equal(worker.sessionDir, null);
	});

	it("invents nothing for a legacy manifest", () => {
		const inst = parseInstance(tmpDir, hash6, 30000);
		assert.equal(inst.workers[0].address, null);
		assert.equal(inst.workers[0].sessionDir, null);
	});

	it("keeps a recorded address but no path when the manifest has no cwdHash", () => {
		const inst = parseInstance(tmpDir, hash7, 30000);
		assert.equal(inst.workers[0].address, "w1:p5#x0");
		assert.equal(inst.workers[0].sessionDir, null);
	});

	it("keeps a burst flagged in control.workers so the view lists it once", () => {
		const inst = parseInstance(tmpDir, hash5, 30000);
		const burst = inst.workers.find((w) => w.workerId === "burst-flash-1");
		assert.equal(burst.burst, true);
		assert.deepEqual(inst.burstWorkers.map((b) => b.workerId), ["burst-flash-1"]);
	});
});

// --------------------------------------------------------------------------
// Manifest v3 tmux records
// --------------------------------------------------------------------------

describe("manifest v3 tmux", () => {
	it("derives the exact %pane and the session dir the wrapper recorded", () => {
		const inst = parseInstance(tmpDir, hash8, 30000);
		const worker = inst.workers.find((w) => w.workerId === "worker-0");
		assert.equal(worker.address, "%1");
		assert.equal(worker.sessionDir, tmuxSessionDir0);
		assert.equal(inst.terminalBackend, "tmux");
		assert.equal(inst.rootTerminalAddress, null);
	});

	it("invents nothing for a pane without a recorded session dir", () => {
		const inst = parseInstance(tmpDir, hash8, 30000);
		const worker = inst.workers.find((w) => w.workerId === "worker-1");
		assert.equal(worker.address, "%2");
		assert.equal(worker.sessionDir, null);
	});

	it("reads no hc field out of a v3 record and no %pane out of a v2 one", () => {
		for (const hash of [hash9, hash10]) {
			const inst = parseInstance(tmpDir, hash, 30000);
			assert.equal(inst.workers[0].address, null, hash + " is a cross record");
			assert.equal(inst.workers[0].sessionDir, null, hash + " is a cross record");
		}
	});
});

// --------------------------------------------------------------------------
// Manifest v2 markers
// --------------------------------------------------------------------------

describe("manifest v2", () => {
	it("exposes hc backend and root terminal address", () => {
		const inst = parseInstance(tmpDir, hash3, 30000);
		assert.equal(inst.terminalBackend, "hc");
		assert.equal(inst.rootTerminalAddress, "m7f3a2-root");
	});

	it("is null on a legacy manifest without markers", () => {
		const inst = parseInstance(tmpDir, hash2, 30000);
		assert.equal(inst.terminalBackend, null);
		assert.equal(inst.rootTerminalAddress, null);
	});
});

// --------------------------------------------------------------------------
// scanInstances — integration with filesystem
// --------------------------------------------------------------------------

describe("scanInstances", () => {
	it("finds instance from temp dir with manifest + control", async () => {
		// An explicit empty mindmux root: never scan the operator's live state.
		const result = await scanInstances(tmpDir, { staleMs: 60000, mindmuxStateRoot: join(tmpDir, "no-mindmux") });
		assert.ok(result.length >= 2);
		const inst = result.find((i) => i.hash === hash);
		assert.ok(inst, "expected instance found");
		assert.equal(inst.state, "idle");
		assert.equal(inst.running, true);
		assert.equal(inst.workersConnected, 2);
		assert.equal(inst.workersExpected, 2);
		assert.equal(inst.label, "my-label");
		assert.equal(inst.lastResultSummary, "Added tests");
		assert.equal(inst.lastResponseSnippet, "Added test coverage");
	});

	it("returns empty array for nonexistent dir", async () => {
		const result = await scanInstances("/nonexistent", { mindmuxStateRoot: "/nonexistent/mindmux" });
		assert.equal(result.length, 0);
	});
});

// --------------------------------------------------------------------------
// Native mindmux (Go) discovery
//
// Fixtures write a real Go record (state.go, version 1) into a temp state root and
// a real control file into a temp runtime path named by the record. Nothing reads
// or writes ~/.local/state/mindmux, an adapter socket or a live pool.
// --------------------------------------------------------------------------

const cleanups = [];
function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "mw-mindmux-agent-"));
	const stateRoot = mkdtempSync(join(tmpdir(), "mw-mindmux-root-"));
	cleanups.push(agentDir, stateRoot);
	mkdirSync(join(agentDir, "mindworker"), { recursive: true });
	mkdirSync(join(stateRoot, "sessions"), { recursive: true });
	return { agentDir, stateRoot };
}

const sha16 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const taskIdFor = (cwd, generation) => `mx-g${generation}-${sha16(cwd)}`;

// The same keys Go writes (state.go Record), including the ones discovery must not
// confuse with pi's: key is the tmux pool key, not a cwd hash.
function writeGoRecord(stateRoot, opts) {
	const key = opts.key;
	const record = {
		version: opts.version ?? 1,
		key,
		generation: opts.generation,
		state: opts.state,
		server: { socketPath: "/tmp/tmux-1000/default", pid: 4242, startTime: 1 },
		session: { id: "$3", name: "work" },
		root: opts.root ?? { paneId: "%1", panePid: process.pid, paneStartTime: 1, windowId: "@1", cwd: opts.cwd },
		mind: opts.mind ?? { pid: process.pid, startTime: 1, windowId: "@2", paneId: "%2" },
		workers: opts.workers ?? [],
		controlFile: opts.controlFile ?? "",
		adapterSocket: join(stateRoot, "adapter.sock"),
		manifestPath: join(stateRoot, "sessions", `${key}.json`),
		createdAt: Date.now(),
		updatedAt: opts.updatedAt ?? Date.now(),
	};
	writeFileSync(join(stateRoot, "sessions", `${key}.json`), JSON.stringify(record));
	return record;
}

function writeControlFile(path, control) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(control));
}

function controlFileFor(stateRoot, key, generation) {
	return join(stateRoot, "runtime", `${key}-${generation.toString(16)}`, "control.json");
}

function touchSocket(agentDir, hash) {
	writeFileSync(join(agentDir, "mindworker", `${hash}.sock`), "");
}

/** Run with no mindmux env at all: discovery must stand on the record alone. */
async function withoutMindmuxEnv(fn) {
	const names = [
		"MINDMUX_ADAPTER_SOCKET", "MINDMUX_MANIFEST", "MINDMUX_CONTROL_FILE", "MINDMUX_GENERATION",
		"MINDMUX_SESSION_KEY", "MINDMUX_DRAFT_SOCKET", "MINDMUX_SESSION_ID",
		"PI_MIND_WORKER_INSTANCE", "PI_MIND_WORKER_GENERATION",
	];
	const saved = names.map((n) => [n, process.env[n]]);
	for (const n of names) delete process.env[n];
	try {
		return await fn();
	} finally {
		for (const [n, v] of saved) {
			if (v === undefined) delete process.env[n];
			else process.env[n] = v;
		}
	}
}

describe("mindmux native discovery", () => {
	it("discovers a running pool from the Go record alone, with pi's own paths", async () => {
		const { agentDir, stateRoot } = fixture();
		const gen = 7;
		const cwd = "/home/user/project";
		const hash = taskIdFor(cwd, gen);
		const controlPath = controlFileFor(stateRoot, "k1", gen);
		writeControlFile(controlPath, {
			status: "worker-connected", generation: gen, connectedWorkers: 2, expectedWorkers: 2,
			lastUpdated: Date.now(),
			workers: [{ workerId: "worker-0", tier: "flash", busy: false, taskId: "t-1", connectedAt: 1 }],
		});
		writeGoRecord(stateRoot, {
			key: "k1", generation: gen, state: "running", cwd, controlFile: controlPath,
			workers: [{ id: "worker-0", tier: "flash", paneId: "%5", sessionDir: "/tmp/tx/worker-0", state: "running" }],
		});
		touchSocket(agentDir, hash);
		writeFileSync(join(agentDir, "mindworker", `${hash}-results.jsonl`), '{"summary":"did the thing"}\n');

		await withoutMindmuxEnv(async () => {
			const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
			assert.equal(result.length, 1);
			const inst = result[0];
			// The Go pool key is never the dashboard hash: pi's scoped id is.
			assert.equal(inst.hash, hash);
			assert.equal(inst.terminalBackend, "mindmux");
			assert.equal(inst.cwd, cwd);
			assert.equal(inst.label, "project");
			// The table fragment is the cwd hash, not the id's generation prefix.
			assert.equal(inst.shortHash, sha16(cwd).slice(0, 8));
			assert.equal(inst.manifest.cwdHash, sha16(cwd));
			assert.equal(inst.manifest.generation, gen);
			assert.equal(inst.running, true);
			assert.equal(inst.state, "idle");
			assert.equal(inst.workersConnected, 2);
			assert.equal(inst.workersExpected, 2);
			assert.equal(inst.rootTerminalAddress, "%1");
			assert.equal(inst.lastResultSummary, "did the thing");
			const worker = inst.workers.find((w) => w.workerId === "worker-0");
			assert.equal(worker.tier, "flash");
			assert.equal(worker.sessionDir, "/tmp/tx/worker-0");
			assert.equal(worker.paneId, "%5");
			assert.equal(worker.address, null, "no hc peek hint for a mindmux pane");
			assert.equal(inst.recordWorkers[0].workerId, "worker-0");
			assert.equal(inst.mindmux.key, "k1");
		});
	});

	it("honours XDG_STATE_HOME when no root is passed", async () => {
		const { stateRoot } = fixture();
		const xdg = mkdtempSync(join(tmpdir(), "mw-xdg-"));
		const agentDir = mkdtempSync(join(tmpdir(), "mw-xdg-agent-"));
		cleanups.push(xdg, agentDir);
		mkdirSync(join(agentDir, "mindworker"), { recursive: true });
		const cwd = "/home/user/xdg";
		const hash = taskIdFor(cwd, 3);
		writeGoRecord(stateRoot, { key: "k9", generation: 3, state: "running", cwd });
		// Move the record under the XDG root the scanner must default to.
		const xdgRoot = join(xdg, "mindmux");
		mkdirSync(join(xdgRoot, "sessions"), { recursive: true });
		writeFileSync(
			join(xdgRoot, "sessions", "k9.json"),
			JSON.stringify({
				version: 1, key: "k9", generation: 3, state: "running",
				root: { cwd }, mind: { pid: process.pid }, controlFile: "",
				manifestPath: join(xdgRoot, "sessions", "k9.json"),
			}),
		);
		const saved = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = xdg;
		try {
			await withoutMindmuxEnv(async () => {
				const result = await scanInstances(agentDir, { staleMs: 60000 });
				assert.equal(result.length, 1);
				assert.equal(result[0].hash, hash);
				assert.equal(result[0].running, false, "no control file: never ready");
			});
		} finally {
			if (saved === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = saved;
		}
	});

	it("uses XDG_STATE_HOME verbatim, the way Go reads it", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mw-xdg-raw-agent-"));
		const xdg = mkdtempSync(join(tmpdir(), "mw-xdg-raw-"));
		cleanups.push(agentDir, xdg);
		mkdirSync(join(agentDir, "mindworker"), { recursive: true });
		const cwd = "/home/user/xdg-raw";
		const xdgRoot = join(xdg, "mindmux");
		mkdirSync(join(xdgRoot, "sessions"), { recursive: true });
		writeFileSync(join(xdgRoot, "sessions", "kx.json"), JSON.stringify({
			version: 1, key: "kx", generation: 121, state: "running",
			root: { cwd }, mind: { pid: process.pid }, controlFile: "",
			manifestPath: join(xdgRoot, "sessions", "kx.json"),
		}));
		const saved = process.env.XDG_STATE_HOME;
		try {
			process.env.XDG_STATE_HOME = xdg;
			const exact = await withoutMindmuxEnv(() => scanInstances(agentDir, { staleMs: 60000 }));
			assert.equal(exact.length, 1);
			assert.equal(exact[0].hash, taskIdFor(cwd, 121));

			// Go neither trims nor cleans the variable: a padded value names another root.
			process.env.XDG_STATE_HOME = ` ${xdg} `;
			const padded = await withoutMindmuxEnv(() => scanInstances(agentDir, { staleMs: 60000 }));
			assert.equal(padded.length, 0, "a space-padded XDG_STATE_HOME is not trimmed into the real root");
		} finally {
			if (saved === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = saved;
		}
	});

	it("keeps two sessions in one cwd apart by generation", async () => {
		const { agentDir, stateRoot } = fixture();
		const cwd = "/home/user/same";
		const control1 = controlFileFor(stateRoot, "ka", 11);
		const control2 = controlFileFor(stateRoot, "kb", 12);
		writeControlFile(control1, { status: "ready", generation: 11, connectedWorkers: 1, expectedWorkers: 1, lastUpdated: Date.now() });
		writeControlFile(control2, { status: "worker-connected", generation: 12, connectedWorkers: 1, expectedWorkers: 1, lastUpdated: Date.now() });
		writeGoRecord(stateRoot, { key: "ka", generation: 11, state: "running", cwd, controlFile: control1 });
		writeGoRecord(stateRoot, { key: "kb", generation: 12, state: "running", cwd, controlFile: control2 });
		touchSocket(agentDir, taskIdFor(cwd, 11));
		touchSocket(agentDir, taskIdFor(cwd, 12));

		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		assert.equal(result.length, 2);
		assert.deepEqual(result.map((i) => i.hash).sort(), [taskIdFor(cwd, 11), taskIdFor(cwd, 12)].sort());
		assert.ok(result.every((i) => i.running));
	});

	it("is never ready without a control file", async () => {
		const { agentDir, stateRoot } = fixture();
		const cwd = "/home/user/nocontrol";
		const hash = taskIdFor(cwd, 21);
		writeGoRecord(stateRoot, { key: "k21", generation: 21, state: "running", cwd });
		touchSocket(agentDir, hash);
		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		assert.equal(result.length, 1);
		assert.equal(result[0].running, false);
		assert.equal(result[0].state, "unknown");
	});

	it("treats a stale or malformed control file as not running", async () => {
		const { agentDir, stateRoot } = fixture();
		const cwd = "/home/user/stale";
		const control = controlFileFor(stateRoot, "k31", 31);
		writeControlFile(control, { status: "worker-connected", generation: 31, connectedWorkers: 1, expectedWorkers: 1, lastUpdated: Date.now() - 120_000 });
		writeGoRecord(stateRoot, { key: "k31", generation: 31, state: "running", cwd, controlFile: control });
		touchSocket(agentDir, taskIdFor(cwd, 31));

		const other = fixture();
		const broken = controlFileFor(other.stateRoot, "k32", 32);
		mkdirSync(dirname(broken), { recursive: true });
		writeFileSync(broken, "{not json");
		writeGoRecord(other.stateRoot, { key: "k32", generation: 32, state: "running", cwd, controlFile: broken });
		touchSocket(other.agentDir, taskIdFor(cwd, 32));

		const stale = await scanInstances(agentDir, { staleMs: 30000, mindmuxStateRoot: stateRoot });
		assert.equal(stale[0].running, false);
		assert.equal(stale[0].state, "unknown");
		const malformed = await scanInstances(other.agentDir, { staleMs: 30000, mindmuxStateRoot: other.stateRoot });
		assert.equal(malformed[0].running, false);
		assert.equal(malformed[0].state, "unknown");
	});

	it("survives a valid-JSON control with non-array fields and still scans every pool", async () => {
		const { agentDir, stateRoot } = fixture();
		const badCwd = "/home/user/bad-shape";
		const badControl = controlFileFor(stateRoot, "km1", 91);
		writeControlFile(badControl, {
			status: "worker-connected", generation: 91, connectedWorkers: 1, expectedWorkers: 1,
			lastUpdated: Date.now(), workers: {}, activeTasks: "not-an-array", queuedTasks: { nope: true },
		});
		writeGoRecord(stateRoot, { key: "km1", generation: 91, state: "running", cwd: badCwd, controlFile: badControl });
		touchSocket(agentDir, taskIdFor(badCwd, 91));

		const goodCwd = "/home/user/good-shape";
		const goodControl = controlFileFor(stateRoot, "km2", 92);
		writeControlFile(goodControl, {
			status: "worker-connected", generation: 92, connectedWorkers: 1, expectedWorkers: 1,
			lastUpdated: Date.now(), workers: [{ workerId: "worker-0" }],
		});
		writeGoRecord(stateRoot, { key: "km2", generation: 92, state: "running", cwd: goodCwd, controlFile: goodControl });
		touchSocket(agentDir, taskIdFor(goodCwd, 92));

		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		assert.equal(result.length, 2, "one mis-shaped control file must not abort the whole scan");
		const bad = result.find((i) => i.hash === taskIdFor(badCwd, 91));
		assert.deepEqual(bad.workers, []);
		assert.deepEqual(bad.activeTasks, []);
		assert.deepEqual(bad.queuedTasks, []);
		const good = result.find((i) => i.hash === taskIdFor(goodCwd, 92));
		assert.equal(good.running, true);
		assert.equal(good.workers.length, 1);
	});

	it("does not abort the scan on a legacy control with non-array fields", async () => {
		const { agentDir, stateRoot } = fixture();
		const legacyHash = "aaaabbbbccccdddd";
		writeFileSync(
			join(agentDir, "mindworker", `${legacyHash}-manifest.json`),
			JSON.stringify({ cwd: "/home/user/legacy-bad-shape", cwdHash: legacyHash, state: "running", lastUpdated: Date.now(), mindPid: process.pid }),
		);
		writeFileSync(
			join(agentDir, "mindworker", `${legacyHash}-mind-control.json`),
			JSON.stringify({ status: "worker-connected", lastUpdated: Date.now(), workers: {}, activeTasks: 3, queuedTasks: "x" }),
		);
		writeFileSync(join(agentDir, "mindworker", `${legacyHash}.sock`), "");

		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		const inst = result.find((i) => i.hash === legacyHash);
		assert.ok(inst, "the legacy instance still parses");
		assert.deepEqual(inst.workers, []);
		assert.deepEqual(inst.activeTasks, []);
		assert.deepEqual(inst.queuedTasks, []);
	});

	it("ignores a control file that names another generation", async () => {
		const { agentDir, stateRoot } = fixture();
		const cwd = "/home/user/mismatch";
		const control = controlFileFor(stateRoot, "k41", 41);
		writeControlFile(control, { status: "worker-connected", generation: 40, connectedWorkers: 1, expectedWorkers: 1, lastUpdated: Date.now() });
		writeGoRecord(stateRoot, { key: "k41", generation: 41, state: "running", cwd, controlFile: control });
		touchSocket(agentDir, taskIdFor(cwd, 41));
		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		assert.equal(result[0].running, false);
		assert.equal(result[0].state, "unknown");
	});

	it("needs the control to carry this record's own numeric generation", async () => {
		const { agentDir, stateRoot } = fixture();
		const cases = [
			["kg1", 61, { status: "worker-connected" }],
			["kg2", 62, { status: "worker-connected", generation: String(62) }],
			["kg3", 63, { status: "worker-connected", generation: null }],
			["kg4", 64, { status: "worker-connected", generation: 64 }],
		];
		for (const [key, generation, extra] of cases) {
			const cwd = `/home/user/${key}`;
			const control = controlFileFor(stateRoot, key, generation);
			writeControlFile(control, { connectedWorkers: 1, expectedWorkers: 1, lastUpdated: Date.now(), ...extra });
			writeGoRecord(stateRoot, { key, generation, state: "running", cwd, controlFile: control });
			touchSocket(agentDir, taskIdFor(cwd, generation));
		}

		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		const byKey = new Map(result.map((i) => [i.mindmux.key, i]));
		for (const key of ["kg1", "kg2", "kg3"]) {
			assert.equal(byKey.get(key).running, false, `${key} must not read as ready`);
			assert.equal(byKey.get(key).state, "unknown", key);
		}
		assert.equal(byKey.get("kg4").running, true, "the record's own generation is accepted");
		assert.equal(byKey.get("kg4").state, "idle");
	});

	it("never shows stopped or cleanup_unconfirmed as running", async () => {
		const { agentDir, stateRoot } = fixture();
		for (const [key, gen, state] of [["k51", 51, "stopped"], ["k52", 52, "cleanup_unconfirmed"]]) {
			const cwd = `/home/user/${state}`;
			const control = controlFileFor(stateRoot, key, gen);
			writeControlFile(control, { status: "worker-connected", generation: gen, connectedWorkers: 1, expectedWorkers: 1, lastUpdated: Date.now() });
			writeGoRecord(stateRoot, { key, generation: gen, state, cwd, controlFile: control });
			touchSocket(agentDir, taskIdFor(cwd, gen));
		}
		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		assert.equal(result.length, 2);
		for (const inst of result) {
			assert.equal(inst.running, false, inst.manifest.state);
			assert.equal(inst.state, "unknown");
		}
	});

	it("reports a control error with the live generation as error", async () => {
		const { agentDir, stateRoot } = fixture();
		const cwd = "/home/user/errors";
		const control = controlFileFor(stateRoot, "k61", 61);
		writeControlFile(control, { status: "error", generation: 61, connectedWorkers: 1, expectedWorkers: 1, lastUpdated: Date.now(), message: "worker handshake failed" });
		writeGoRecord(stateRoot, { key: "k61", generation: 61, state: "running", cwd, controlFile: control });
		touchSocket(agentDir, taskIdFor(cwd, 61));
		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		assert.equal(result[0].running, true);
		assert.equal(result[0].state, "error");
	});

	it("skips malformed, foreign-version and unnamed records", async () => {
		const { agentDir, stateRoot } = fixture();
		writeFileSync(join(stateRoot, "sessions", "bad.json"), "{not json");
		writeFileSync(join(stateRoot, "sessions", "empty.json"), JSON.stringify({}));
		writeGoRecord(stateRoot, { key: "k71", generation: 71, state: "running", cwd: "/home/user/v1", version: 2 });
		writeGoRecord(stateRoot, { key: "k72", generation: 0, state: "running", cwd: "/home/user/gen0" });
		writeGoRecord(stateRoot, { key: "k73", generation: 73, state: "running", cwd: "", root: { cwd: "" } });
		writeGoRecord(stateRoot, { key: "k74", generation: 74, state: "running", cwd: "/home/user/ok" });
		writeFileSync(join(stateRoot, "sessions", "notes.txt"), "ignore me");

		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		assert.equal(result.length, 1);
		assert.equal(result[0].cwd, "/home/user/ok");
	});

	it("rejects a record whose root cwd is not absolute", async () => {
		const { agentDir, stateRoot } = fixture();
		// Go records the pane's absolute cwd; a relative one hashes to a path pi never wrote.
		writeGoRecord(stateRoot, { key: "kr1", generation: 111, state: "running", cwd: "relative/dir" });
		writeGoRecord(stateRoot, { key: "kr2", generation: 112, state: "running", cwd: "/home/user/absolute" });
		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		assert.deepEqual(result.map((i) => i.mindmux.key), ["kr2"]);
	});

	it("lists legacy records and native records side by side", async () => {
		const { agentDir, stateRoot } = fixture();
		const legacyHash = "1111222233334444";
		writeFileSync(
			join(agentDir, "mindworker", `${legacyHash}-manifest.json`),
			JSON.stringify({ cwd: "/home/user/legacy", cwdHash: legacyHash, state: "running", lastUpdated: Date.now(), mindPid: process.pid }),
		);
		writeFileSync(
			join(agentDir, "mindworker", `${legacyHash}-mind-control.json`),
			JSON.stringify({ status: "worker-connected", generation: 1, lastUpdated: Date.now(), connectedWorkers: 1, expectedWorkers: 1 }),
		);
		writeFileSync(join(agentDir, "mindworker", `${legacyHash}.sock`), "");
		const cwd = "/home/user/native";
		const control = controlFileFor(stateRoot, "k81", 81);
		writeControlFile(control, { status: "ready", generation: 81, connectedWorkers: 1, expectedWorkers: 1, lastUpdated: Date.now() });
		writeGoRecord(stateRoot, { key: "k81", generation: 81, state: "running", cwd, controlFile: control });
		touchSocket(agentDir, taskIdFor(cwd, 81));

		const result = await scanInstances(agentDir, { staleMs: 60000, mindmuxStateRoot: stateRoot });
		assert.equal(result.length, 2);
		const legacy = result.find((i) => i.hash === legacyHash);
		const native = result.find((i) => i.terminalBackend === "mindmux");
		assert.ok(legacy && legacy.running, "legacy read-only discovery is preserved");
		assert.ok(native && native.running);
	});
});

// --------------------------------------------------------------------------
// Cleanup temp fixture dir
// --------------------------------------------------------------------------

after(() => {
	for (const path of cleanups) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});
