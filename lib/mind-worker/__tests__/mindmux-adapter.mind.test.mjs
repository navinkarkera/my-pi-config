// mindmux-adapter.mind.test.mjs
//
// The real extension as Mind against a fake Go adapter socket. No hc, no tmux, no
// Go binary and no model request: the fake speaks the documented NDJSON ops and
// records every request.
//
// Pinned here: the explicit opt-in, ready ordering (draft first, then Go), the
// insert-only draft ACK, generation-namespaced paths for the same cwd, spawn
// through Go with the values Go needs, retire through Go, and the difference
// between an empty worker list and a list that could not answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { sleep, waitUntil, withFixture } from "./support/fixture.mjs";
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

const BURST = {
	enabled: true,
	model: "vendor/burst",
	maxBurst: 1,
	// loadConfig refuses an idleTtlMs below 10s, so retirement here is driven by the
	// explicit Mind stop (the same bounded driver), never by waiting out a TTL.
	idleTtlMs: 10000,
	maxTasksPerWorker: 3,
	queuePressureThreshold: 1,
	spawnWaitMs: 500,
	logDetail: "compact",
};

/** A fake Go adapter. Its behaviors are read per request, so a test can change them. */
async function startFakeGo(fixture, options = {}) {
	const socketPath = join(fixture.root, "mx", "adapter.sock");
	mkdirSync(join(fixture.root, "mx"), { recursive: true });
	const state = {
		requests: [],
		behaviors: {
			list: () => ({ ok: true, workers: [] }),
			spawn: () => ({ ok: true, pane: "%9" }),
			retire: () => ({ ok: true }),
			ready: () => ({ ok: true }),
			...options.behaviors,
		},
		readyDraftListening: null,
	};
	const server = createServer((conn) => {
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("error", () => {});
		conn.on("data", async (chunk) => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const request = JSON.parse(line);
				state.requests.push(request);
				if (request.op === "ready") {
					// Proof of ordering: the draft must already accept connections.
					state.readyDraftListening = await canConnect(request.draft_socket);
				}
				const reply = state.behaviors[request.op]?.(request, state) ?? { ok: false, error: "unknown op", code: "bad_op" };
				conn.write(JSON.stringify(await reply) + "\n");
			}
		});
	});
	await new Promise((resolve) => server.listen(socketPath, resolve));
	fixture.servers.push(server);
	return { socketPath, state, close: () => server.close() };
}

function canConnect(socketPath) {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

/** One append, as Go's mindmux send would send it. */
function appendDraft(socketPath, text) {
	return new Promise((resolve, reject) => {
		const conn = createConnection(socketPath);
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("error", reject);
		conn.on("connect", () => conn.write(JSON.stringify({ op: "append", text }) + "\n"));
		conn.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			conn.destroy();
			resolve(JSON.parse(buffer.split("\n")[0]));
		});
	});
}

/**
 * A Go-managed Mind in one fixture: env first, then the fake adapter, then the
 * extension. Every MINDMUX_* key is removed afterwards so no later suite inherits it.
 */
async function withMindmux(fixtureOptions, fn) {
	await withFixture(fixtureOptions, async (fixture) => {
		const go = await startFakeGo(fixture);
		const runtimeDir = join(fixture.root, "rt");
		mkdirSync(runtimeDir, { recursive: true });
		const draftSocket = join(runtimeDir, "draft.sock");
		const controlFile = join(runtimeDir, "control.json");
		const manifestPath = join(runtimeDir, "record.json");
		// A record that is NOT the old v3 shape: Go owns it, so the extension must not
		// need it, parse it, or write it.
		const record = { version: 1, key: "k" + fixture.hash, generation: 42, state: "starting", workers: [] };
		writeFileSync(manifestPath, JSON.stringify(record, null, 2));

		Object.assign(process.env, {
			MINDMUX_ADAPTER_SOCKET: go.socketPath,
			MINDMUX_MANIFEST: manifestPath,
			MINDMUX_CONTROL_FILE: controlFile,
			MINDMUX_DRAFT_SOCKET: draftSocket,
			MINDMUX_GENERATION: "42",
			MINDMUX_SESSION_ID: "$3",
			PI_MIND_WORKER_INSTANCE: "mx-g42",
		});
		try {
			return await fn({ fixture, go, draftSocket, controlFile, manifestPath, record });
		} finally {
			for (const key of MINDMUX_KEYS) delete process.env[key];
		}
	});
}

/** The namespaced socket path this run derives: label-cwdhash.sock. */
function mindSocketPath(fixture, label = "mx-g42") {
	const hash = createHash("sha256").update(fixture.cwd).digest("hex").slice(0, 16);
	return join(fixture.stateDir, label + "-" + hash + ".sock");
}

async function startMindmuxMind(fixture) {
	const mind = await fixture.load("mind");
	// The editor the extension appends to: recorded so a test can prove no submit.
	const editor = { text: "", updates: [] };
	mind.ctx.ui.getEditorText = () => editor.text;
	mind.ctx.ui.setEditorText = (text) => {
		editor.text = text;
		editor.updates.push(text);
	};
	await mind.sessionStart();
	const socketPath = mindSocketPath(fixture);
	await waitUntil(() => existsSync(socketPath), { timeout: 5000, label: "namespaced mind socket" });
	return { mind, editor, socketPath };
}

/** The burst worker's own event log: written on every transition, not on a heartbeat. */
function burstLogPath(fixture, label = "mx-g42") {
	const hash = createHash("sha256").update(fixture.cwd).digest("hex").slice(0, 16);
	return join(fixture.stateDir, label + "-" + hash + "-burst-flash-1.log");
}

function burstEvents(fixture) {
	try {
		return readFileSync(burstLogPath(fixture), "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function readControl(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function connectMindmuxWorker(socketPath, generation = 42) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.write(JSON.stringify({
				type: "handshake",
				role: "worker",
				generation,
				workerId: "worker-0",
				tier: "flash",
			}) + "\n");
			resolve(socket);
		});
	});
}

function queueFlash(mind) {
	return mind.runTool("delegate", { task: "burst please", tier: "flash" }).catch(() => {});
}

test("ready is registered with Go only after the draft socket listens", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, draftSocket, controlFile, manifestPath, record }) => {
		const { socketPath } = await startMindmuxMind(fixture);
		await waitUntil(() => go.state.requests.some((request) => request.op === "ready"), {
			timeout: 5000,
			label: "ready op",
		});

		const ready = go.state.requests.find((request) => request.op === "ready");
		assert.equal(ready.draft_socket, draftSocket);
		assert.equal(go.state.readyDraftListening, true, "the draft must accept connections before Go is told ready");

		// The control file still carries the real Mind task readiness, at Go's path,
		// but only after the async Go ready ACK.
		await waitUntil(() => readControl(controlFile)?.status === "ready", { timeout: 5000, label: "control ready" });
		const control = readControl(controlFile);
		assert.equal(control.status, "ready");
		assert.equal(control.generation, 42);
		assert.equal(control.expectedWorkers, 1);

		// Go's record is not the old shape, and it was never treated as one.
		assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), record, "Go owns its record; nothing rewrote it");
		assert.equal(existsSync(join(fixture.stateDir, fixture.hash + "-mind-control.json")), false, "no legacy control file");
		assert.equal(existsSync(socketPath), true);
	});
});

test("control ready waits for the Go ready ACK", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		let release;
		go.state.behaviors.ready = () => new Promise((resolve) => {
			release = () => resolve({ ok: true });
		});
		const { mind } = await startMindmuxMind(fixture);
		await waitUntil(() => go.state.requests.some((request) => request.op === "ready"), {
			timeout: 5000,
			label: "ready op",
		});

		// The draft exists, but the ACK is held: Go must not see control ready yet.
		assert.notEqual(readControl(controlFile)?.status, "ready", "ready was published before the Go ACK");
		release();
		await waitUntil(() => readControl(controlFile)?.status === "ready", { timeout: 5000, label: "ready after ACK" });
		await mind.sessionShutdown("quit");
	});
});

test("a failed ready ACK never publishes ready and cannot be overwritten by a worker", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.ready = () => ({ ok: false, error: "adapter refused ready", code: "state" });
		const { mind, socketPath } = await startMindmuxMind(fixture);
		await waitUntil(() => readControl(controlFile)?.status === "error", { timeout: 5000, label: "startup error" });
		assert.notEqual(readControl(controlFile)?.status, "ready");

		const worker = await connectMindmuxWorker(socketPath);
		try {
			await new Promise((resolve) => setTimeout(resolve, 250));
			const control = readControl(controlFile);
			assert.equal(control.status, "error", "worker-connected overwrote the startup error");
			assert.match(control.message, /adapter refused ready/);
		} finally {
			worker.destroy();
		}
		await mind.sessionShutdown("quit");
	});
});

test("a failed draft never publishes ready", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, draftSocket, controlFile }) => {
		// A directory at the draft path makes bind fail deterministically.
		mkdirSync(draftSocket, { recursive: true });
		const { mind } = await startMindmuxMind(fixture);
		await waitUntil(() => readControl(controlFile)?.status === "error", { timeout: 5000, label: "draft startup error" });
		assert.notEqual(readControl(controlFile)?.status, "ready");
		await mind.sessionShutdown("quit");
	});
});

test("a draft append updates the editor and acks, with no submit and no escape, even while busy", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST, configOverrides: { dashboardEnabled: false } }, async ({ fixture, go, draftSocket }) => {
		// Busy: pending messages and no idle session. An append is still a draft write.
		fixture.pendingMessages = true;
		fixture.idle = false;
		const { mind, editor } = await startMindmuxMind(fixture);
		await waitUntil(() => go.state.requests.some((request) => request.op === "ready"), { timeout: 5000, label: "ready op" });
		const messagesBefore = mind.messages.length;

		assert.deepEqual(await appendDraft(draftSocket, "src/a.ts:1-4\nline one\nline two\nline three"), { ok: true });
		assert.deepEqual(await appendDraft(draftSocket, "second block"), { ok: true });

		assert.equal(
			editor.text,
			"src/a.ts:1-4\nline one\nline two\nline three\n\nsecond block",
			"appends are blank-line separated and multiline text is exact",
		);
		assert.equal(editor.updates.length, 2, "the ACK is written after the editor update");
		assert.deepEqual(mind.userMessages, [], "a draft append must never submit a user message");
		// Activation sends one non-triggering context message; an append adds none.
		assert.equal(mind.messages.length, messagesBefore, "a draft append must never send a custom message");

		// A malformed frame is refused and changes nothing.
		assert.deepEqual(await appendDraft(draftSocket, ""), { ok: false, error: "append needs non-empty text" });
		assert.equal(editor.updates.length, 2);
	});
});

test("Go's expected worker count sets the static capacity and the control count", { timeout: 20000 }, async () => {
	await withMindmux({ workerCount: 1 }, async ({ fixture, controlFile }) => {
		process.env.MINDMUX_EXPECTED_WORKERS = "3";
		try {
			const { socketPath } = await startMindmuxMind(fixture);
			const seen = [];
			for (const workerId of ["worker-0", "worker-1"]) {
				const socket = await new Promise((resolve, reject) => {
					const conn = createConnection(socketPath);
					conn.once("error", reject);
					conn.once("connect", () => {
						conn.write(JSON.stringify({ type: "handshake", role: "worker", generation: 42, workerId, tier: "flash" }) + "\n");
						resolve(conn);
					});
				});
				const frames = [];
				socket.setEncoding("utf8");
				socket.on("data", (chunk) => {
					for (const line of String(chunk).split("\n")) {
						if (!line.trim()) continue;
						try { frames.push(JSON.parse(line)); } catch { /* partial frame */ }
					}
				});
				seen.push({ workerId, socket, frames });
			}
			await waitUntil(() => (readControl(controlFile)?.connectedWorkers ?? 0) === 2, {
				timeout: 5000,
				label: "two static workers admitted",
			});
			assert.equal(readControl(controlFile)?.expectedWorkers, 3, "the control file carries Go's count");
			for (const worker of seen) {
				assert.ok(!worker.frames.some((frame) => frame.code === "POOL_FULL"), worker.workerId + " must not be refused by the narrower Pi resolver");
			}
		} finally {
			delete process.env.MINDMUX_EXPECTED_WORKERS;
		}
	});
});

test("a same-cwd run is namespaced by session+generation, so a stale pool cannot share its socket", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture }) => {
		const { socketPath } = await startMindmuxMind(fixture);
		assert.equal(socketPath, mindSocketPath(fixture, "mx-g42"));
		// The pre-change cwd path is not listening: an old session or force-orphan with
		// the plain cwd hash reaches nothing.
		assert.equal(await canConnect(join(fixture.stateDir, fixture.hash + ".sock")), false);
		// A different generation derives a different path.
		assert.notEqual(mindSocketPath(fixture, "mx-g41"), socketPath);
	});
});

test("a burst spawn goes to Go with the values Go builds the worker argv from", { timeout: 20000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go }) => {
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		await waitUntil(() => go.state.requests.some((request) => request.op === "ready"), { timeout: 5000, label: "ready op" });

		void queueFlash(mind);
		await waitUntil(() => go.state.requests.some((request) => request.op === "spawn"), { timeout: 10000, label: "spawn op" });

		const spawn = go.state.requests.find((request) => request.op === "spawn");
		assert.equal(spawn.worker_id, "burst-flash-1");
		assert.equal(spawn.tier, "flash");
		assert.equal(spawn.model, "vendor/burst");
		assert.equal(spawn.thinking, "max");
		assert.match(spawn.session_dir, /burst-flash-.*-1$/, "Go passes this to the worker as PI_MIND_WORKER_SESSION_DIR");
		// The legacy host seams were not used at all.
		assert.deepEqual(fixture.fakeHc.calls(), [], "no hc call on the Go path");
	});
});

test("a listed worker is retired through Go", { timeout: 30000 }, async () => {
	await withMindmux(
		{ burstFlash: BURST },
		async ({ fixture, go }) => {
			// Go reports the worker it spawned, so the retirement has a live proof.
			go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: "%9", worker_id: "burst-flash-1" }] });
			const mind = await fixture.load("mind");
			await mind.sessionStart();
			void queueFlash(mind);
			await waitUntil(() => go.state.requests.some((request) => request.op === "spawn"), { timeout: 10000, label: "spawn op" });
			// The Mind stop retires every tracked burst worker through the same driver.
			await mind.sessionShutdown("quit");
			await waitUntil(() => go.state.requests.some((request) => request.op === "retire"), {
				timeout: 15000,
				label: "retire op",
			});
			const retire = go.state.requests.find((request) => request.op === "retire");
			assert.equal(retire.pane, "%9");
			await waitUntil(() => burstEvents(fixture).some((line) => line.includes("retired")), {
				timeout: 10000,
				label: "retirement settled",
			});
		},
	);
});

test("an empty worker list proves absence; a list that cannot answer keeps the worker tracked", { timeout: 40000 }, async () => {
	// Empty list: Go answered, so the pane is provably gone and the entry settles.
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go }) => {
		go.state.behaviors.list = () => ({ ok: true, workers: [] });
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlash(mind);
		await waitUntil(() => go.state.requests.some((request) => request.op === "spawn"), { timeout: 10000, label: "spawn op" });
		await mind.sessionShutdown("quit");
		await waitUntil(() => burstEvents(fixture).some((line) => line.includes("retired")), {
			timeout: 15000,
			label: "worker settled after an empty list",
		});
		assert.deepEqual(go.state.requests.filter((request) => request.op === "retire"), [], "no retire op without a live proof");
		assert.ok(!burstEvents(fixture).some((line) => line.includes("retire failed")), "an empty list is not a failure");
	});

	// Error reply: Go did not answer, so nothing is proven and the worker stays tracked.
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.list = () => ({ ok: false, error: "adapter is restarting", code: "unavailable" });
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlash(mind);
		await waitUntil(() => go.state.requests.some((request) => request.op === "spawn"), { timeout: 10000, label: "spawn op" });
		await mind.sessionShutdown("quit");
		// The bounded schedule is exhausted, and the entry stays tracked: no silent leak,
		// no kill loop, and no retire op invented from an unanswered list.
		await waitUntil(() => burstEvents(fixture).some((line) => line.includes("retire failed")), {
			timeout: 20000,
			label: "bounded retire attempts after an unanswered list",
		});
		assert.match(fixture.readLog(), /retire attempt 3 failed/, "three bounded attempts, then tracked");
		assert.deepEqual(go.state.requests.filter((request) => request.op === "retire"), [], "no retire op without a live proof");
	});
});

test("retire-before-address: a retirement that lands before the reply retires once the pane is known", { timeout: 30000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go }) => {
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: "%9", worker_id: "burst-flash-1" }] });
		go.state.behaviors.spawn = async () => { await sleep(400); return { ok: true, pane: "%9" }; };
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlash(mind);
		await waitUntil(() => go.state.requests.some((request) => request.op === "spawn"), { timeout: 10000, label: "spawn op" });
		// The Mind stops while the spawn reply is still in flight.
		await mind.sessionShutdown("quit");
		await waitUntil(() => go.state.requests.some((request) => request.op === "retire"), { timeout: 15000, label: "retire op" });
		await waitUntil(() => burstEvents(fixture).some((line) => line.includes("retired")), {
			timeout: 10000,
			label: "retirement settled",
		});
		const retires = go.state.requests.filter((request) => request.op === "retire");
		assert.equal(retires.length, 1, "one retirement for the late address");
		assert.equal(retires[0].pane, "%9");
	});
});

test("an unconfirmed spawn stays tracked and is reconciled by the adapter's own list", { timeout: 40000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go }) => {
		// Go accepted the spawn but the reply is lost: nothing proves the pane exists.
		go.state.behaviors.spawn = () => new Promise(() => {});
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: "%9", worker_id: "burst-flash-1" }] });
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlash(mind);
		await waitUntil(() => go.state.requests.some((request) => request.op === "spawn"), { timeout: 10000, label: "spawn op" });
		await waitUntil(() => burstEvents(fixture).some((line) => line.includes("spawn-unconfirmed")), {
			timeout: 15000,
			label: "spawn timed out as unconfirmed",
		});
		// The entry is still tracked, and the list is what retires it.
		await mind.sessionShutdown("quit");
		await waitUntil(() => go.state.requests.some((request) => request.op === "retire"), { timeout: 20000, label: "retire op" });
		const retire = go.state.requests.find((request) => request.op === "retire");
		assert.equal(retire.pane, "%9");
	});
});

test("a generation change mid-pending never adopts the late pane; it retires the old-owned address", { timeout: 30000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.spawn = async () => { await sleep(400); return { ok: true, pane: "%9" }; };
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: "%9", worker_id: "burst-flash-1" }] });
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlash(mind);
		await waitUntil(() => go.state.requests.some((request) => request.op === "spawn"), { timeout: 10000, label: "spawn op" });
		// Go replaced the pool while the spawn reply was in flight.
		process.env.MINDMUX_GENERATION = "43";
		process.env.PI_MIND_WORKER_INSTANCE = "mx-g43";
		await waitUntil(() => go.state.requests.some((request) => request.op === "retire"), { timeout: 15000, label: "retire op" });
		const retire = go.state.requests.find((request) => request.op === "retire");
		assert.equal(retire.pane, "%9", "the late pane is retired, never adopted");
		await waitUntil(() => burstEvents(fixture).some((line) => line.includes("retired")), {
			timeout: 10000,
			label: "late result settled",
		});
		// The stale success never becomes an adopted terminal in this generation.
		assert.ok(!burstEvents(fixture).some((line) => line.includes("spawned %9")), "the late pane is not adopted");
	});
});

test("a Go retire error decides by kind: not_owned is gone, without a kill loop", { timeout: 30000 }, async () => {
	await withMindmux({ burstFlash: BURST }, async ({ fixture, go }) => {
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: "%9", worker_id: "burst-flash-1" }] });
		go.state.behaviors.retire = () => ({ ok: false, error: "pane belongs to another pool", code: "not_owned" });
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlash(mind);
		await waitUntil(() => go.state.requests.some((request) => request.op === "spawn"), { timeout: 10000, label: "spawn op" });
		await mind.sessionShutdown("quit");
		await waitUntil(() => go.state.requests.some((request) => request.op === "retire"), { timeout: 15000, label: "retire op" });
		// not_owned means our terminal is already gone: the entry goes, without a kill loop.
		await waitUntil(() => burstEvents(fixture).some((line) => line.includes("retired")), {
			timeout: 10000,
			label: "not_owned settled the entry",
		});
		assert.equal(go.state.requests.filter((request) => request.op === "retire").length, 1, "one attempt, never a loop");
	});
});
