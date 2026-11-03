// mindmux-burst-lifecycle.mind.test.mjs
//
// The burst lifecycle the deleted worker-burst suites pinned, re-pinned on the
// mindmux host: the real extension as Mind against a fake Go adapter socket. No
// hc, no tmux, no Go binary, no model request.
//
// Pinned here: a pending spawn is the durable record and consumes maxBurst; an
// uncertain spawn stays tracked, is reconciled by its Go worker_id and is never
// retried as a second worker; a deterministic spawn failure leaves queued work to
// a static worker; a retirement that starts before the spawn reply kills once,
// after the address is known; a generation change mid-spawn never adopts the late
// worker; a worker Go proves absent settles as gone with no kill; the task cap
// retires the worker once and still returns its result.
//
// NOT covered here, because the harness cannot drive it inside a bounded test:
// idle-TTL and connect-timeout retirement. loadConfig floors burstFlash.idleTtlMs
// at 10s, connectTimeoutMs is min(60s, idleTtlMs) and the sweep runs every 5s, so
// each assertion needs a 10-15s wait. There is no supported way to shorten it
// without a production test hook.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { sleep, waitUntil, withFixture, withTimeout } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

const MINDMUX_KEYS = [
	"MINDMUX_ADAPTER_SOCKET",
	"MINDMUX_MANIFEST",
	"MINDMUX_CONTROL_FILE",
	"MINDMUX_DRAFT_SOCKET",
	"MINDMUX_GENERATION",
	"MINDMUX_SESSION_ID",
	"MINDMUX_SESSION_KEY",
	"MINDMUX_EXPECTED_WORKERS",
];

const GENERATION = 42;
const SPAWN_PANE = "%9";

const BURST = {
	enabled: true,
	model: "vendor/burst",
	maxBurst: 1,
	idleTtlMs: 10000,
	maxTasksPerWorker: 3,
	queuePressureThreshold: 1,
	spawnWaitMs: 500,
	logDetail: "compact",
};

/** A reply marker: drop the connection instead of answering, so the op is unconfirmed. */
const CLOSE = Object.freeze({ close: true });

/** A fake Go adapter. Behaviors are read per request, so a test can change them mid-run. */
async function startFakeGo(fixture, behaviors = {}, dirName = "mx") {
	const socketPath = join(fixture.root, dirName, "adapter.sock");
	mkdirSync(dirname(socketPath), { recursive: true });
	const state = {
		requests: [],
		behaviors: {
			ready: () => ({ ok: true }),
			spawn: () => ({ ok: true, pane: SPAWN_PANE }),
			retire: () => ({ ok: true }),
			list: () => ({ ok: true, workers: [] }),
			...behaviors,
		},
	};
	const server = createServer((conn) => {
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("error", () => { /* the test owns the failure */ });
		conn.on("data", async (chunk) => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let request;
				try {
					request = JSON.parse(line);
				} catch {
					continue;
				}
				state.requests.push(request);
				let reply;
				try {
					const behavior = state.behaviors[request.op];
					reply = await (behavior ? behavior(request, state) : { ok: false, error: "unknown op", code: "bad_op" });
				} catch (err) {
					reply = { ok: false, error: String(err), code: "unavailable" };
				}
				if (reply === CLOSE) {
					conn.destroy();
					return;
				}
				try {
					conn.write(JSON.stringify(reply) + "\n");
				} catch { /* the client went away */ }
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	fixture.servers.push(server);
	return { socketPath, state };
}

/** One Mind run on the fake adapter, with every MINDMUX_* key removed afterwards. */
async function withMindmux(fixtureOptions, fn) {
	await withFixture(fixtureOptions, async (fixture) => {
		const go = await startFakeGo(fixture);
		const runtimeDir = join(fixture.root, "rt");
		mkdirSync(runtimeDir, { recursive: true });
		const draftSocket = join(runtimeDir, "draft.sock");
		const controlFile = join(runtimeDir, "control.json");
		const manifestPath = join(runtimeDir, "record.json");
		// Go owns this record; the extension must not need it or parse it.
		writeFileSync(manifestPath, JSON.stringify({ version: 1, generation: GENERATION, state: "starting", workers: [] }, null, 2));

		Object.assign(process.env, {
			MINDMUX_ADAPTER_SOCKET: go.socketPath,
			MINDMUX_MANIFEST: manifestPath,
			MINDMUX_CONTROL_FILE: controlFile,
			MINDMUX_DRAFT_SOCKET: draftSocket,
			MINDMUX_GENERATION: String(GENERATION),
			MINDMUX_SESSION_ID: "$3",
			PI_MIND_WORKER_INSTANCE: "mx-g" + GENERATION,
		});
		try {
			return await fn({ fixture, go, controlFile, draftSocket, manifestPath });
		} finally {
			for (const key of MINDMUX_KEYS) delete process.env[key];
		}
	});
}

/** The label-namespaced Mind socket, derived the way the extension derives it. */
function mindSocketPath(fixture) {
	const hash = createHash("sha256").update(fixture.cwd).digest("hex").slice(0, 16);
	return join(fixture.stateDir, "mx-g" + GENERATION + "-" + hash + ".sock");
}

async function startMindmuxMind(fixture, go) {
	const mind = await fixture.load("mind");
	await mind.sessionStart();
	await waitUntil(() => go.state.requests.some((request) => request.op === "ready"), {
		timeout: 5000,
		label: "ready op",
	});
	const socketPath = mindSocketPath(fixture);
	await waitUntil(() => existsSync(socketPath), { timeout: 5000, label: "namespaced mind socket" });
	return { mind, socketPath };
}

/** A minimal worker client for the namespaced socket (the fixture connects the legacy path). */
function connectWorkerClient(socketPath, handshake) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const client = { frames: [], closed: false, waiters: new Set() };
		const claimed = new WeakSet();
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("error", () => { /* the test asserts frames, not socket errors */ });
		socket.on("close", () => {
			client.closed = true;
			for (const waiter of [...client.waiters]) waiter();
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let frame;
				try {
					frame = JSON.parse(line);
				} catch {
					continue;
				}
				client.frames.push(frame);
				for (const waiter of [...client.waiters]) waiter();
			}
		});
		socket.once("connect", () => {
			socket.write(JSON.stringify(handshake) + "\n");
			resolve(client);
		});
		socket.once("error", reject);
		client.send = (message) => {
			if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
		};
		client.close = () => {
			if (!socket.destroyed) socket.destroy();
		};
		client.waitFor = (predicate, options) => {
			const timeout = options?.timeout ?? 5000;
			const label = options?.label ?? "frame";
			return new Promise((resolveFrame, rejectFrame) => {
				const settle = () => {
					const match = client.frames.find((frame) => !claimed.has(frame) && predicate(frame));
					if (!match) return false;
					claimed.add(match);
					cleanup();
					resolveFrame(match);
					return true;
				};
				const timer = setTimeout(() => {
					cleanup();
					const seen = client.frames.map((frame) => JSON.stringify(frame)).join("\n  ") || "(none)";
					rejectFrame(new Error("Timed out after " + timeout + "ms waiting for " + label + ". Frames:\n  " + seen));
				}, timeout);
				const cleanup = () => {
					clearTimeout(timer);
					client.waiters.delete(settle);
				};
				client.waiters.add(settle);
				if (settle()) return;
			});
		};
	});
}

function readControl(controlFile) {
	try {
		return JSON.parse(readFileSync(controlFile, "utf8"));
	} catch {
		return null;
	}
}

function readEvents(logFile) {
	try {
		return readFileSync(logFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => line.replace(/^\[[^\]]+\]\s*/, ""));
	} catch {
		return [];
	}
}

function hasEvent(logFile, name) {
	return readEvents(logFile).some((line) => line === name || line.startsWith(name + ":") || line.startsWith(name + " "));
}

function ops(go, name) {
	return go.state.requests.filter((request) => request.op === name);
}

function queueFlash(mind, task) {
	const pending = mind.runTool("delegate", { task, tier: "flash" });
	pending.catch(() => { /* the test asserts the outcome when it matters */ });
	return pending;
}

async function pendingBurstEntry(controlFile) {
	return waitUntil(() => readControl(controlFile)?.burstWorkers?.[0] ?? null, {
		timeout: 5000,
		label: "pending burst control entry",
	});
}

test("a pending spawn counts maxBurst and is persisted with its full control-file shape", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		let release;
		go.state.behaviors.spawn = () => new Promise((resolve) => {
			release = () => resolve({ ok: true, pane: SPAWN_PANE });
		});
		const { mind, socketPath } = await startMindmuxMind(fixture, go);
		const first = queueFlash(mind, "queued for a burst worker");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 5000, label: "first spawn op" });

		const pending = await pendingBurstEntry(controlFile);
		assert.deepEqual(
			Object.keys(pending).sort(),
			["address", "generation", "index", "lastEvent", "logFile", "retireReason", "sessionDir", "spawnSettled", "spawnedAt", "taskCount", "terminalState", "workerId"],
			"the durable burst entry keeps its agreed shape",
		);
		assert.equal(pending.workerId, "burst-flash-1");
		assert.equal(pending.index, 1);
		assert.equal(pending.address, null, "a pending spawn has no address yet");
		assert.equal(pending.terminalState, "pending");
		assert.equal(pending.spawnSettled, false);
		assert.equal(pending.retireReason, null);
		assert.equal(pending.generation, GENERATION);
		assert.equal(pending.taskCount, 0);
		assert.equal(pending.lastEvent, "pending");
		assert.ok(Number.isSafeInteger(pending.spawnedAt) && pending.spawnedAt > 0);
		assert.equal(pending.sessionDir, join(fixture.agentDir, "sessions", "burst-flash-mx-g42-" + fixture.hash + "-1"));
		assert.equal(pending.logFile, join(fixture.stateDir, "mx-g42-" + fixture.hash + "-burst-flash-1.log"));
		const pendingControl = readControl(controlFile);
		assert.equal(pendingControl.burstCounter, 1, "the run counter is persisted before the spawn");
		assert.equal(pendingControl.generation, GENERATION);
		assert.equal(pendingControl.expectedWorkers, 1);

		// A second flash task must not spawn past maxBurst while the first is pending.
		const controller = new AbortController();
		const second = mind.runTool("delegate", { task: "second flash task", tier: "flash" }, { signal: controller.signal });
		second.catch(() => { /* aborted while queued below */ });
		await sleep(BURST.spawnWaitMs + 250);
		assert.equal(ops(go, "spawn").length, 1, "a pending spawn still consumes the only maxBurst slot");
		controller.abort();
		const aborted = await withTimeout(second, 3000, "aborted queued task");
		assert.equal(aborted.isError, true);

		// Adoption is proved by a real handshake and real work, not by a log line.
		release();
		const burst = await connectWorkerClient(socketPath, {
			type: "handshake",
			role: "worker",
			generation: GENERATION,
			workerId: "burst-flash-1",
			tier: "flash",
		});
		const task = await burst.waitFor((frame) => frame.type === "task", { label: "task on the adopted burst worker" });
		assert.match(task.task, /queued for a burst worker/);
		burst.send({ type: "result", id: task.id, explanation: "burst served it" });
		const result = await withTimeout(first, 5000, "delegate result");
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, "burst served it");
		const adopted = await waitUntil(() => {
			const entry = readControl(controlFile)?.burstWorkers?.[0];
			return entry?.address === SPAWN_PANE ? entry : null;
		}, { timeout: 5000, label: "adopted address in the control file" });
		assert.equal(adopted.spawnSettled, true);
		burst.close();

		// Settle this run before the fixture ends: a retirement driver that outlives
		// its env would issue its bounded list/retire attempts against the next test's
		// adapter, since the harness shares one process.env.
		await mind.sessionShutdown("quit");
		await waitUntil(() => hasEvent(adopted.logFile, "retired"), { timeout: 10000, label: "retired at shutdown" });
	});
});

test("an uncertain spawn stays tracked and its retirement reconciles the worker by id, with no duplicate spawn", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.spawn = () => CLOSE;
		go.state.behaviors.list = () => ({
			ok: true,
			workers: [
				{ pane: "%7", worker_id: "burst-flash-1" },
				{ pane: "%8", worker_id: "worker-0" },
			],
		});
		const { mind } = await startMindmuxMind(fixture, go);
		queueFlash(mind, "uncertain burst");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 5000, label: "spawn op" });
		const entry = await pendingBurstEntry(controlFile);
		await waitUntil(() => hasEvent(entry.logFile, "spawn-unconfirmed"), { timeout: 5000, label: "spawn-unconfirmed event" });

		// The tracked entry still holds the only maxBurst slot: no second worker is spawned.
		await sleep(BURST.spawnWaitMs + 250);
		assert.equal(ops(go, "spawn").length, 1, "an unconfirmed spawn is reconciled, never retried as a second worker");

		await mind.sessionShutdown("quit");
		await waitUntil(() => ops(go, "retire").length === 1, { timeout: 10000, label: "reconcile retire" });
		assert.equal(ops(go, "retire")[0].pane, "%7", "the worker is reconciled by its Go worker_id");
		assert.deepEqual(ops(go, "retire").map((op) => op.pane), ["%7"], "an unrelated worker is never retired");
		await waitUntil(() => hasEvent(entry.logFile, "retired"), { timeout: 5000, label: "retired event" });
	});
});

test("a deterministic spawn failure leaves queued flash work to a static worker", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: { ...BURST, spawnWaitMs: 5000 } }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.spawn = () => ({ ok: false, error: "Go refused the spawn", code: "spawn_failed" });
		const { mind, socketPath } = await startMindmuxMind(fixture, go);
		const pending = queueFlash(mind, "served after the spawn failure");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 5000, label: "spawn op" });
		const entry = await pendingBurstEntry(controlFile);
		await waitUntil(() => hasEvent(entry.logFile, "spawn-failed"), { timeout: 5000, label: "spawn-failed event" });
		assert.equal(ops(go, "spawn").length, 1, "a deterministic failure is not retried into a kill loop");

		const worker = await connectWorkerClient(socketPath, {
			type: "handshake",
			role: "worker",
			generation: GENERATION,
			workerId: "worker-0",
			tier: "flash",
		});
		const task = await worker.waitFor((frame) => frame.type === "task", { label: "queued task on the static worker" });
		assert.match(task.task, /served after the spawn failure/, "the burst spawn failure must not fail the queued work");
		worker.send({ type: "result", id: task.id, explanation: "static served it" });
		const result = await withTimeout(pending, 5000, "delegate result");
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, "static served it");

		const control = await waitUntil(() => {
			const value = readControl(controlFile);
			return value?.connectedWorkers === 1 ? value : null;
		}, { timeout: 5000, label: "control after the static worker connected" });
		assert.deepEqual(control.burstWorkers, [], "the failed entry must not keep a burst slot");
		assert.equal(ops(go, "retire").length, 0, "nothing was spawned, so nothing is retired");
		worker.close();
	});
});

test("a retirement that starts before the spawn reply kills once, after the address is known", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		let release;
		go.state.behaviors.spawn = () => new Promise((resolve) => {
			release = () => resolve({ ok: true, pane: SPAWN_PANE });
		});
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: "burst-flash-1" }] });
		const { mind } = await startMindmuxMind(fixture, go);
		queueFlash(mind, "retired before its address");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 5000, label: "spawn op" });
		const entry = await pendingBurstEntry(controlFile);
		assert.equal(entry.address, null);

		const shutdown = mind.sessionShutdown("quit");
		await sleep(300);
		assert.equal(ops(go, "retire").length, 0, "an unsettled spawn has no address to kill");
		assert.equal(ops(go, "spawn").length, 1);

		release();
		await withTimeout(shutdown, 5000, "mind shutdown");
		await waitUntil(() => ops(go, "retire").length === 1, { timeout: 10000, label: "retire after the late reply" });
		assert.equal(ops(go, "retire")[0].pane, SPAWN_PANE);
		await waitUntil(() => hasEvent(entry.logFile, "retired"), { timeout: 5000, label: "retired event" });
		assert.equal(ops(go, "spawn").length, 1, "the late reply is never a second spawn");
	});
});

test("a generation change mid-spawn never adopts the late worker and retires the old-owned pane", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		let release;
		go.state.behaviors.spawn = () => new Promise((resolve) => {
			release = () => resolve({ ok: true, pane: SPAWN_PANE });
		});
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: "burst-flash-1" }] });
		const { mind, socketPath } = await startMindmuxMind(fixture, go);
		queueFlash(mind, "stale-generation burst");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 5000, label: "spawn op" });
		await pendingBurstEntry(controlFile);

		// Go moved on to the next generation while the spawn reply was still in flight.
		process.env.MINDMUX_GENERATION = String(GENERATION + 1);
		release();
		await waitUntil(() => ops(go, "retire").length === 1, { timeout: 10000, label: "old-owned retire" });
		assert.equal(ops(go, "retire")[0].pane, SPAWN_PANE, "the late pane is retired through the pool that owns it");

		// Not adopted: a static worker at the new generation rewrites the control file,
		// and the burst entry still carries no address of the late reply.
		const worker = await connectWorkerClient(socketPath, {
			type: "handshake",
			role: "worker",
			generation: GENERATION + 1,
			workerId: "worker-0",
			tier: "flash",
		});
		const task = await worker.waitFor((frame) => frame.type === "task", { label: "queued task on the static worker" });
		const control = await waitUntil(() => {
			const value = readControl(controlFile);
			return value?.generation === GENERATION + 1 ? value : null;
		}, { timeout: 5000, label: "control rewritten at the new generation" });
		const burstEntry = control.burstWorkers.find((burst) => burst.workerId === "burst-flash-1");
		assert.ok(burstEntry, "the stale attempt must stay tracked for cleanup, not disappear");
		assert.equal(burstEntry.address, null, "the late worker must never be adopted into the new generation");
		assert.equal(burstEntry.terminalState, "pending");
		worker.send({ type: "result", id: task.id, explanation: "static served it" });
		worker.close();

		// The cleanup-only entry is redeemed on this run's shutdown, inside its own env.
		await mind.sessionShutdown("quit");
		await waitUntil(() => hasEvent(burstEntry.logFile, "retired"), { timeout: 10000, label: "stale attempt retired at shutdown" });
	});
});

test("an unconfirmed spawn that Go proves absent settles as gone without a kill", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.spawn = () => CLOSE;
		go.state.behaviors.list = () => ({ ok: true, workers: [] });
		const { mind } = await startMindmuxMind(fixture, go);
		queueFlash(mind, "never existed");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 5000, label: "spawn op" });
		const entry = await pendingBurstEntry(controlFile);
		await waitUntil(() => hasEvent(entry.logFile, "spawn-unconfirmed"), { timeout: 5000, label: "spawn-unconfirmed event" });

		await mind.sessionShutdown("quit");
		await waitUntil(() => hasEvent(entry.logFile, "gone"), { timeout: 10000, label: "gone after an empty worker list" });
		assert.deepEqual(ops(go, "retire").map((op) => op.pane), [], "a worker Go proves absent is never killed");
		assert.equal(ops(go, "spawn").length, 1);
	});
});

test("the task cap retires the burst worker once and still returns its result", { timeout: 25000 }, async () => {
	await withMindmux({ burstFlash: { ...BURST, maxTasksPerWorker: 1 } }, async ({ fixture, go }) => {
		go.state.behaviors.spawn = () => ({ ok: true, pane: SPAWN_PANE });
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: "burst-flash-1" }] });
		const { mind, socketPath } = await startMindmuxMind(fixture, go);
		const pending = queueFlash(mind, "one task then retire");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 5000, label: "spawn op" });
		const burst = await connectWorkerClient(socketPath, {
			type: "handshake",
			role: "worker",
			generation: GENERATION,
			workerId: "burst-flash-1",
			tier: "flash",
		});
		const task = await burst.waitFor((frame) => frame.type === "task", { label: "task on the burst worker" });
		assert.match(task.task, /one task then retire/);
		burst.send({ type: "result", id: task.id, explanation: "done at the cap" });
		const result = await withTimeout(pending, 5000, "delegate result");
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, "done at the cap", "the retirement must not lose the settled result");

		await waitUntil(() => ops(go, "retire").length === 1, { timeout: 10000, label: "retire at the task cap" });
		assert.equal(ops(go, "retire")[0].pane, SPAWN_PANE);
		await sleep(300);
		assert.equal(ops(go, "retire").length, 1, "one address, one kill: never a kill loop");
		burst.close();
	});
});

// ── Pinned adapter: a late reply and its cleanup never follow an env swap ──────

test("a late spawn reply and its cleanup stay on the pinned adapter, never a newly selected one", { timeout: 30000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go }) => {
		// A second adapter that would happily report and retire the same worker id.
		const other = await startFakeGo(fixture, {
			list: () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: "burst-flash-1" }] }),
		}, "mx2");
		let release;
		go.state.behaviors.spawn = () => new Promise((resolve) => {
			release = () => resolve({ ok: true, pane: SPAWN_PANE });
		});
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: "burst-flash-1" }] });

		const { mind } = await startMindmuxMind(fixture, go);
		queueFlash(mind, "swap while pending");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 5000, label: "spawn op" });

		// Go selects a different pool (reload / force-orphan) while the reply is in flight.
		process.env.MINDMUX_ADAPTER_SOCKET = other.socketPath;
		process.env.MINDMUX_GENERATION = "43";
		process.env.PI_MIND_WORKER_INSTANCE = "mx-g43";
		release();

		// The late pane is retired as the OLD pool's terminal, on the OLD adapter.
		await waitUntil(() => ops(go, "retire").length === 1, { timeout: 10000, label: "retire on the pinned adapter" });
		assert.equal(ops(go, "retire")[0].pane, SPAWN_PANE);
		await sleep(300);
		const touched = other.state.requests.filter((request) => ["ready", "spawn", "list", "retire"].includes(request.op));
		assert.deepEqual(touched, [], "a newly selected adapter is never contacted for an old terminal");
	});
});

// ── /reload recovery from the native Go control file ─────────────────────────

function writeRecoveredControl(controlFile, { generation = GENERATION, counter = 3, address = "%7", workerId = "burst-flash-3" } = {}) {
	writeFileSync(controlFile, JSON.stringify({
		status: "running",
		generation,
		connectedWorkers: 0,
		expectedWorkers: 1,
		burstCounter: counter,
		burstWorkers: [{
			workerId,
			index: Number(workerId.replace("burst-flash-", "")),
			address,
			generation,
			terminalState: "spawned",
			spawnSettled: true,
			sessionDir: "/tmp/recovered-session",
			logFile: "/tmp/recovered-burst.log",
			lastEvent: "spawned",
		}],
	}, null, 2));
}

test("a reload reseeds Go's surviving burst cleanup-only and never reuses its id", { timeout: 30000 }, async () => {
	await withMindmux({ burstFlash: { ...BURST, maxBurst: 2 } }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: "%7", worker_id: "burst-flash-3" }] });
		writeRecoveredControl(controlFile);
		const { mind } = await startMindmuxMind(fixture, go);

		// The survivor is retired through Go, never adopted for work.
		await waitUntil(() => ops(go, "retire").some((op) => op.pane === "%7"), { timeout: 10000, label: "survivor retired" });
		assert.equal(ops(go, "spawn").length, 0, "recovery never spawns");

		// The next spawn reserves past the recovered id, because Go rejects a reused one.
		queueFlash(mind, "after reload");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 10000, label: "new spawn op" });
		assert.equal(ops(go, "spawn")[0].worker_id, "burst-flash-4", "the next spawn is past the recovered id");
	});
});

test("a reload whose adapter cannot answer keeps the survivor tracked", { timeout: 30000 }, async () => {
	await withMindmux({ burstFlash: { ...BURST, maxBurst: 2 } }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.list = () => ({ ok: false, error: "still starting", code: "unavailable" });
		writeRecoveredControl(controlFile, { address: null, workerId: "burst-flash-3" });
		const { mind } = await startMindmuxMind(fixture, go);

		// An unanswered list is not proof of absence: no retire, the entry stays tracked.
		await waitUntil(() => /kept tracked/.test(fixture.readLog()), { timeout: 15000, label: "survivor kept tracked" });
		assert.match(fixture.readLog(), /retire unresolved: core unavailable/, "unavailable is never claimed as gone");
		assert.deepEqual(ops(go, "retire"), [], "an unanswered list never retires");

		// The id is still reserved, so Go never sees a duplicate.
		queueFlash(mind, "after an unavailable reload");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 10000, label: "new spawn op" });
		assert.equal(ops(go, "spawn")[0].worker_id, "burst-flash-4");
	});

});

test("a cold start with an unavailable list still boots and spawns from one", { timeout: 30000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go }) => {
		go.state.behaviors.list = () => ({ ok: false, error: "still starting", code: "unavailable" });
		const { mind, socketPath } = await startMindmuxMind(fixture, go);
		assert.ok(existsSync(socketPath), "the Mind still listens");
		assert.ok(ops(go, "ready").length >= 1, "readiness is still registered");
		void queueFlash(mind, "cold start queue");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 10000, label: "cold-start spawn" });
		assert.equal(ops(go, "spawn")[0].worker_id, "burst-flash-1", "a cold start starts at one");
	});
});

test("a reload snapshot from another generation is ignored", { timeout: 30000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: "%7", worker_id: "burst-flash-7" }] });
		writeRecoveredControl(controlFile, { generation: GENERATION - 1, counter: 7, address: "%7", workerId: "burst-flash-7" });
		const { mind } = await startMindmuxMind(fixture, go);

		await sleep(500);
		assert.deepEqual(ops(go, "retire"), [], "a foreign generation's worker is never retired");
		queueFlash(mind, "fresh generation");
		await waitUntil(() => ops(go, "spawn").length === 1, { timeout: 10000, label: "spawn op" });
		assert.equal(ops(go, "spawn")[0].worker_id, "burst-flash-1", "a foreign counter is not reserved");
	});
});
