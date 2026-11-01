// dashboard-backend.test.mjs — node:test tests for backend pure logic.
// Tests: normalizeState, running detection, sort, formatStateTag, resolveAgentDir,
// readJsonl, parseInstance label priority, scanInstances integration.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
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
		const result = await scanInstances(tmpDir, { staleMs: 60000 });
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
		const result = await scanInstances("/nonexistent");
		assert.equal(result.length, 0);
	});
});

// --------------------------------------------------------------------------
// Cleanup temp fixture dir
// --------------------------------------------------------------------------

after(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});
