// on-demand-assignment.mind.test.mjs
//
// The explicit on-demand surface against a fake Go adapter: assign one Worker,
// follow up by its id, refresh in the same slot, close it, and surface capacity
// refusal without a hidden queue, retry, burst spawn or automatic replacement.
//
// Inert unless MINDMUX_ON_DEMAND=1; the legacy path is covered by the existing
// mindmux-adapter and burst suites.

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
	"MINDMUX_ON_DEMAND",
	"MINDMUX_ASSIGN_CONNECT_TIMEOUT_MS",
];

const GENERATION = 42;
const SPAWN_PANE = "%9";
/** Drop the connection instead of replying, so the adapter reports an unconfirmed spawn. */
const CLOSE = Object.freeze({ close: true });
const ON_DEMAND_CONFIG = {
	workerCount: 2,
	workerModels: [
		{ model: "vendor/flash", count: 1, tier: "flash", thinkingLevel: "medium" },
		{ model: "vendor/strong", count: 1, tier: "strong", thinkingLevel: "max" },
	],
	burstFlash: {
		enabled: true,
		model: "vendor/burst",
		thinkingLevel: "max",
		maxBurst: 1,
		idleTtlMs: 10000,
		maxTasksPerWorker: 3,
		queuePressureThreshold: 1,
		spawnWaitMs: 500,
		logDetail: "compact",
	},
};

async function startFakeGo(fixture, behaviors = {}) {
	const socketPath = join(fixture.root, "mx", "adapter.sock");
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
				try { request = JSON.parse(line); } catch { continue; }
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
				try { conn.write(JSON.stringify(reply) + "\n"); } catch { /* client went away */ }
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

async function withMindmux(options, fn) {
	const onDemand = options.onDemand !== false;
	await withFixture(options, async (fixture) => {
		const go = await startFakeGo(fixture);
		const runtimeDir = join(fixture.root, "rt");
		mkdirSync(runtimeDir, { recursive: true });
		const draftSocket = join(runtimeDir, "draft.sock");
		const controlFile = join(runtimeDir, "control.json");
		const manifestPath = join(runtimeDir, "record.json");
		writeFileSync(manifestPath, JSON.stringify({ version: 1, generation: GENERATION, state: "starting", workers: [] }, null, 2));

		const env = {
			MINDMUX_ADAPTER_SOCKET: go.socketPath,
			MINDMUX_MANIFEST: manifestPath,
			MINDMUX_CONTROL_FILE: controlFile,
			MINDMUX_DRAFT_SOCKET: draftSocket,
			MINDMUX_GENERATION: String(GENERATION),
			MINDMUX_SESSION_ID: "$3",
			PI_MIND_WORKER_INSTANCE: "mx-g" + GENERATION,
			MINDMUX_EXPECTED_WORKERS: onDemand ? "0" : "1",
			MINDMUX_ASSIGN_CONNECT_TIMEOUT_MS: String(options.assignTimeoutMs ?? 5000),
		};
		if (onDemand) env.MINDMUX_ON_DEMAND = "1";
		Object.assign(process.env, env);
		try {
			return await fn({ fixture, go, controlFile, draftSocket, manifestPath, onDemand });
		} finally {
			for (const key of MINDMUX_KEYS) delete process.env[key];
		}
	});
}

function mindSocketPath(fixture) {
	const hash = createHash("sha256").update(fixture.cwd).digest("hex").slice(0, 16);
	return join(fixture.stateDir, "mx-g" + GENERATION + "-" + hash + ".sock");
}

async function startMindmuxMind(fixture, go, controlFile) {
	const mind = await fixture.load("mind");
	await mind.sessionStart();
	await waitUntil(() => go.state.requests.some((request) => request.op === "ready"), {
		timeout: 5000,
		label: "ready op",
	});
	// startMindmuxRuntime runs recovery before publishing control ready.
	await waitUntil(() => readControl(controlFile)?.status === "ready", { timeout: 5000, label: "control ready" });
	const socketPath = mindSocketPath(fixture);
	await waitUntil(() => existsSync(socketPath), { timeout: 5000, label: "mind socket" });
	return { mind, socketPath };
}

/** The system prompt Pi builds after every before_agent_start handler has run. */
async function systemPromptFor(instance, cwd) {
	let systemPrompt = "BASE PROMPT";
	for (const handler of instance.handlers.get("before_agent_start") ?? []) {
		const result = await handler({ systemPrompt, systemPromptOptions: { cwd } });
		if (typeof result?.systemPrompt === "string") systemPrompt = result.systemPrompt;
	}
	return systemPrompt;
}

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
				try { frame = JSON.parse(line); } catch { continue; }
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
		client.waitFor = (predicate, options = {}) => {
			const timeout = options.timeout ?? 5000;
			const label = options.label ?? "frame";
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
	try { return JSON.parse(readFileSync(controlFile, "utf8")); } catch { return null; }
}

function ops(go, name) {
	return go.state.requests.filter((request) => request.op === name);
}

async function assignOne(mind, go, socketPath, tier = "flash") {
	const pending = mind.runTool("worker", { op: "assign", tier });
	await waitUntil(() => ops(go, "spawn").length > 0, { timeout: 5000, label: "spawn op" });
	const spawn = ops(go, "spawn").at(-1);
	const worker = await connectWorkerClient(socketPath, {
		type: "handshake", role: "worker", generation: GENERATION, workerId: spawn.worker_id, tier,
	});
	const result = await withTimeout(pending, 5000, "assign result");
	return { result, spawn, worker };
}

test("on-demand policy reuses Workers and prefers async, with no one-item or close-on-acceptance language", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind } = await startMindmuxMind(fixture, go, controlFile);
		const prompt = await systemPromptFor(mind, fixture.cwd);
		assert.match(prompt, /reuse them across work/);
		assert.match(prompt, /Reuse an idle connected Worker of a suitable tier before assigning/);
		assert.match(prompt, /keep the same Worker and context for related follow-ups/);
		assert.match(prompt, /unrelated work with delegate_async reset:true \(never without reset\)/);
		assert.match(prompt, /Assign another Worker only when none suitable is idle/);
		assert.match(prompt, /Do not close a Worker just because a task finished/);
		assert.match(prompt, /There is no idle TTL/);
		assert.match(prompt, /Use delegate_async first for initial tasks, follow-ups and resets/);
		assert.match(prompt, /do not block just because no independent task exists/);
		assert.match(prompt, /Use blocking delegate only when the user explicitly requests synchronous work/);
		assert.doesNotMatch(prompt, /one work item|accepted or abandoned/i);
		// The legacy blocking exception must not survive in on-demand: only an explicit
		// user request for synchronous work is a legitimate reason to block.
		assert.doesNotMatch(prompt, /Use blocking delegate only when its result is required before continuing/);
		assert.doesNotMatch(prompt, /no useful independent work can proceed/);
		assert.doesNotMatch(prompt, /the blocking exception above/i);
		assert.doesNotMatch(prompt, /use blocking delegate when the immediate-result exception above applies/i);

		const worker = mind.tools.get("worker");
		assert.match(worker.description, /reuse that Worker for related and unrelated work/);
		assert.match(worker.description, /unrelated work on the same Worker uses delegate_async reset:true/);
		assert.doesNotMatch(worker.description, /one work item|accepted or abandoned/i);
		assert.ok(worker.promptGuidelines.some((line) => /Reuse an idle connected Worker/.test(line)));
		assert.ok(worker.promptGuidelines.some((line) => /Do not close a Worker just because a task finished/.test(line)));
		const asyncTool = mind.tools.get("delegate_async");
		assert.match(asyncTool.description, /reset:true for unrelated work/);
	});
});

test("assign starts exactly one Worker with the selected tier and waits for its handshake", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		assert.equal(mind.tools.has("worker"), true, "the worker tool is registered");
		const { result, spawn } = await assignOne(mind, go, socketPath);
		assert.notEqual(result.isError, true, result.content?.[0]?.text);
		assert.equal(result.details.code, "ASSIGNED");
		assert.match(spawn.worker_id, /^assign-/);
		assert.equal(spawn.tier, "flash");
		assert.equal(spawn.model, "vendor/flash");
		assert.equal(spawn.thinking, "medium");
		assert.match(spawn.session_dir, /\/assignments\/assign-/);

		const control = readControl(controlFile);
		assert.equal(control.expectedWorkers, 0, "on-demand starts with zero expected workers");
		assert.equal(control.connectedWorkers, 1, "the assigned worker is connected");
		assert.equal(ops(go, "spawn").length, 1);

		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: spawn.worker_id }] });
		const listed = await mind.runTool("worker", { op: "list" });
		assert.notEqual(listed.isError, true, listed.content?.[0]?.text);
		assert.equal(listed.details.code, "ASSIGNMENTS");
		assert.equal(listed.details.listOk, true);
		assert.equal(listed.details.assignments.length, 1);
		assert.equal(listed.details.assignments[0].workerId, spawn.worker_id);
		assert.equal(listed.details.assignments[0].status, "connected");
	});
});

test("assign selects the configured strong profile, not the flash default", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		const { result, spawn } = await assignOne(mind, go, socketPath, "strong");
		assert.notEqual(result.isError, true, result.content?.[0]?.text);
		assert.equal(spawn.tier, "strong");
		assert.equal(spawn.model, "vendor/strong");
		assert.equal(spawn.thinking, "max");
	});
});

test("follow-up uses the assigned id; a busy worker is refused instead of queued", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		const { spawn, worker } = await assignOne(mind, go, socketPath);
		const first = mind.runTool("delegate", { task: "first", workerId: spawn.worker_id });
		const task = await worker.waitFor((frame) => frame.type === "task", { label: "first task" });

		const second = await withTimeout(
			mind.runTool("delegate", { task: "second", workerId: spawn.worker_id }),
			2000,
			"busy refusal",
		);
		assert.equal(second.isError, true);
		assert.match(second.content[0].text, /busy/i);
		assert.match(second.content[0].text, /same workerId/i);
		assert.doesNotMatch(second.content[0].text, /auto-routing|queues if all busy/i);

		const asyncBusy = await mind.runTool("delegate_async", { task: "async second", workerId: spawn.worker_id });
		assert.equal(asyncBusy.isError, true);
		assert.doesNotMatch(asyncBusy.content[0].text, /auto-routing|queues if all busy/i);
		assert.match(asyncBusy.content[0].text, /same workerId/i);

		const resetBusy = await mind.runTool("delegate", { task: "reset second", workerId: spawn.worker_id, reset: true });
		assert.equal(resetBusy.isError, true);
		assert.doesNotMatch(resetBusy.content[0].text, /auto-routing/i);
		assert.match(resetBusy.content[0].text, /idle|close/i);
		await sleep(100);
		assert.equal(worker.frames.filter((frame) => frame.type === "task").length, 1, "nothing is queued");

		worker.send({ type: "result", id: task.id, explanation: "first done" });
		const done = await withTimeout(first, 5000, "first result");
		assert.equal(done.content[0].text, "first done");
		assert.equal(ops(go, "spawn").length, 1, "a follow-up never allocates");
	});
});

test("refresh reuses the same slot with a fresh context; close retires only that assignment", { timeout: 25000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		const { spawn, worker } = await assignOne(mind, go, socketPath);

		const pending = mind.runTool("delegate", { task: "after refresh", workerId: spawn.worker_id, reset: true });
		const reset = await worker.waitFor((frame) => frame.type === "reset", { label: "reset frame" });
		worker.close();

		const replacement = await connectWorkerClient(socketPath, {
			type: "handshake", role: "worker", generation: GENERATION,
			workerId: spawn.worker_id, tier: "flash", resetId: reset.resetId,
		});
		const task = await replacement.waitFor((frame) => frame.type === "task", { label: "task after refresh" });
		replacement.send({ type: "result", id: task.id, explanation: "refreshed" });
		const done = await withTimeout(pending, 5000, "refresh result");
		assert.equal(done.content[0].text, "refreshed");
		assert.equal(ops(go, "spawn").length, 1, "refresh takes no new slot");
		assert.equal(ops(go, "retire").length, 0, "refresh retires nothing");

		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: spawn.worker_id }] });
		const closed = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.notEqual(closed.isError, true, closed.content?.[0]?.text);
		assert.equal(closed.details.code, "CLOSED");
		assert.equal(ops(go, "retire").at(-1).pane, SPAWN_PANE);
	});
});

test("cap_reached is a visible capacity refusal: no assignment, no retry, no retire", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind } = await startMindmuxMind(fixture, go, controlFile);
		go.state.behaviors.spawn = () => ({ ok: false, error: "per-Mind limit reached", code: "cap_reached" });
		const result = await mind.runTool("worker", { op: "assign", tier: "flash" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Capacity reached/);
		assert.equal(result.details.code, "CAP_REACHED");
		assert.equal(ops(go, "spawn").length, 1, "one attempt, no retry");
		assert.equal(ops(go, "retire").length, 0);
		const id = ops(go, "spawn")[0].worker_id;
		const close = await mind.runTool("worker", { op: "close", workerId: id });
		assert.equal(close.isError, true);
		assert.equal(close.details.code, "NOT_ASSIGNED", "a refused assignment is not owned");
	});
});

test("a worker that never handshakes is reported held, and close can still retire it", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG, assignTimeoutMs: 200 }, async ({ fixture, go, controlFile }) => {
		const { mind } = await startMindmuxMind(fixture, go, controlFile);
		const result = await withTimeout(mind.runTool("worker", { op: "assign", tier: "flash" }), 5000, "held assign");
		assert.equal(result.isError, true);
		assert.equal(result.details.code, "ASSIGN_HELD");
		assert.match(result.content[0].text, /is held/);
		assert.match(result.content[0].text, /No retry/);
		const id = ops(go, "spawn")[0].worker_id;
		assert.ok(result.content[0].text.includes(id), "the held assignment is named");

		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: id }] });
		const closed = await mind.runTool("worker", { op: "close", workerId: id });
		assert.notEqual(closed.isError, true, closed.content?.[0]?.text);
		assert.equal(ops(go, "retire").at(-1).pane, SPAWN_PANE);
	});
});

test("an unconfirmed spawn plus an empty owned list stays unconfirmed and clears only local metadata", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG, assignTimeoutMs: 500 }, async ({ fixture, go, controlFile }) => {
		const { mind } = await startMindmuxMind(fixture, go, controlFile);
		go.state.behaviors.spawn = () => CLOSE;
		const result = await withTimeout(mind.runTool("worker", { op: "assign", tier: "flash" }), 5000, "unconfirmed assign");
		assert.equal(result.isError, true);
		assert.equal(result.details.code, "ASSIGN_UNCONFIRMED");
		const id = ops(go, "spawn")[0].worker_id;

		go.state.behaviors.list = () => ({ ok: true, workers: [] });
		const closed = await mind.runTool("worker", { op: "close", workerId: id });
		assert.equal(closed.isError, true);
		assert.equal(closed.details.code, "CLOSE_UNLISTED");
		assert.equal(closed.details.cleared, true);
		assert.doesNotMatch(closed.content[0].text, /slot is released/i);
		assert.match(closed.content[0].text, /not proven|pool status/i);
		assert.equal(ops(go, "retire").length, 0, "no pane was ever known; nothing is claimed retired");

		const after = await mind.runTool("worker", { op: "close", workerId: id });
		assert.equal(after.isError, true);
		assert.equal(after.details.code, "NOT_ASSIGNED");
	});
});

test("close abandons a busy assignment through retire and settles its task", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		const { spawn, worker } = await assignOne(mind, go, socketPath);
		const pending = mind.runTool("delegate", { task: "slow", workerId: spawn.worker_id });
		await worker.waitFor((frame) => frame.type === "task", { label: "task before close" });

		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: spawn.worker_id }] });
		const closed = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.notEqual(closed.isError, true, closed.content?.[0]?.text);
		assert.equal(closed.details.code, "CLOSED");
		assert.equal(ops(go, "retire").at(-1).pane, SPAWN_PANE);

		const settled = await withTimeout(pending, 5000, "abandoned task");
		assert.equal(settled.isError, true, "closing a busy assignment settles its task");
		assert.match(settled.content[0].text, /closed|disconnected|stopped/i);
	});
});

test("retire failure keeps the assignment; not_owned alone never proves the slot free", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		const { spawn, worker } = await assignOne(mind, go, socketPath);
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: spawn.worker_id }] });

		go.state.behaviors.retire = () => ({ ok: false, error: "adapter is not answering", code: "unavailable" });
		const failed = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.equal(failed.isError, true);
		assert.equal(failed.details.code, "CLOSE_FAILED");
		assert.match(failed.content[0].text, /Nothing was removed/);

		go.state.behaviors.retire = () => ({ ok: false, error: "pane belongs to another pool", code: "not_owned" });
		const kept = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.equal(kept.isError, true);
		assert.equal(kept.details.code, "CLOSE_NOT_OWNED");
		assert.equal(kept.details.cleared, false);
		assert.match(kept.content[0].text, /not owned|pool status/i);

		worker.close();
		await sleep(100);
		const unclear = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.equal(unclear.isError, true);
		assert.equal(unclear.details.code, "CLOSE_NOT_OWNED");
		assert.equal(unclear.details.cleared, true);
		assert.doesNotMatch(unclear.content[0].text, /slot is released/i);
		assert.match(unclear.content[0].text, /not proven|pool status/i);

		go.state.behaviors.list = () => ({ ok: true, workers: [] });
		const after = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.equal(after.isError, true);
		assert.equal(after.details.code, "NOT_ASSIGNED");
		assert.equal(ops(go, "retire").length, 3);
	});
});

test("reload keeps assignments alive for recovery instead of retiring them", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		await assignOne(mind, go, socketPath);
		await mind.sessionShutdown("reload");
		await sleep(150);
		assert.equal(ops(go, "retire").length, 0, "reload must not release the slot behind the next module's back");
	});
});

test("a failed list is unknown, not absent: close keeps ownership and worker list says so", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind } = await startMindmuxMind(fixture, go, controlFile);
		go.state.behaviors.list = () => ({ ok: false, error: "adapter is not answering", code: "unavailable" });

		const close = await mind.runTool("worker", { op: "close", workerId: "assign-ghost" });
		assert.equal(close.isError, true);
		assert.equal(close.details.code, "CLOSE_UNKNOWN");
		assert.equal(close.details.cleared, false);
		assert.match(close.content[0].text, /cannot verify ownership/i);
		assert.equal(ops(go, "retire").length, 0);

		const list = await mind.runTool("worker", { op: "list" });
		assert.equal(list.details.code, "ASSIGNMENTS");
		assert.equal(list.details.listOk, false);
		assert.match(list.details.listError, /not answering/);
		assert.equal(list.details.assignments.length, 0);
		assert.match(list.content[0].text, /Go list failed/i);

		const again = await mind.runTool("worker", { op: "close", workerId: "assign-ghost" });
		assert.equal(again.details.code, "CLOSE_UNKNOWN", "a failed list is not proof of absence");
	});
});

test("/new preserves this process's ids; an empty Go list is not proof of release", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		const { spawn } = await assignOne(mind, go, socketPath);
		go.state.behaviors.list = () => ({ ok: true, workers: [] });

		await mind.sessionShutdown("new");
		await mind.commands.get("be-mind").handler("", mind.ctx);

		const list = await mind.runTool("worker", { op: "list" });
		assert.equal(list.details.listOk, true);
		const row = list.details.assignments.find((entry) => entry.workerId === spawn.worker_id);
		assert.ok(row, "the local id survived /new");
		assert.equal(row.status, "not-listed");

		const follow = await mind.runTool("delegate", { task: "after new", workerId: spawn.worker_id });
		assert.equal(follow.isError, true);
		assert.match(follow.content[0].text, /not connected/i);
		assert.doesNotMatch(follow.content[0].text, /auto-routing|queues if all busy/i);
		assert.equal(ops(go, "spawn").length, 1, "a disconnected follow-up never allocates");

		const closed = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.equal(closed.isError, true);
		assert.equal(closed.details.code, "CLOSE_UNLISTED");
		assert.equal(closed.details.cleared, true);
		assert.doesNotMatch(closed.content[0].text, /slot is released/i);
		assert.match(closed.content[0].text, /not proven|pool status/i);

		const after = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.equal(after.details.code, "NOT_ASSIGNED");
	});
});

test("a replacement module discovers same-owner ids from Go and can close them", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const first = await startMindmuxMind(fixture, go, controlFile);
		const { spawn } = await assignOne(first.mind, go, first.socketPath);
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: spawn.worker_id }] });
		await first.mind.sessionShutdown("reload");

		const second = await fixture.load("mind");
		await second.commands.get("be-mind").handler("", second.ctx);
		const list = await second.runTool("worker", { op: "list" });
		assert.equal(list.details.listOk, true);
		const row = list.details.assignments.find((entry) => entry.workerId === spawn.worker_id);
		assert.ok(row, "Go's list recovers the same owner's id");
		assert.equal(row.status, "disconnected");

		const closed = await second.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.notEqual(closed.isError, true, closed.content?.[0]?.text);
		assert.equal(closed.details.code, "CLOSED");
		assert.equal(ops(go, "retire").at(-1).pane, SPAWN_PANE);
	});
});

test("a connected Worker Go does not list is kept, not claimed closed", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		const { spawn } = await assignOne(mind, go, socketPath);
		go.state.behaviors.list = () => ({ ok: true, workers: [] });

		const kept = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.equal(kept.isError, true);
		assert.equal(kept.details.code, "CLOSE_UNLISTED");
		assert.equal(kept.details.cleared, false);
		assert.match(kept.content[0].text, /connected/i);
		assert.doesNotMatch(kept.content[0].text, /slot is released/i);

		const list = await mind.runTool("worker", { op: "list" });
		assert.equal(list.details.assignments[0].status, "connected-not-listed");

		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: spawn.worker_id }] });
		const closed = await mind.runTool("worker", { op: "close", workerId: spawn.worker_id });
		assert.notEqual(closed.isError, true, closed.content?.[0]?.text);
		assert.equal(closed.details.code, "CLOSED");
	});
});

test("/stop-mind recovers and retires same-owner ids after a module replacement", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const first = await startMindmuxMind(fixture, go, controlFile);
		const { spawn } = await assignOne(first.mind, go, first.socketPath);
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: SPAWN_PANE, worker_id: spawn.worker_id }] });
		await first.mind.sessionShutdown("reload");

		const second = await fixture.load("mind");
		await second.commands.get("be-mind").handler("", second.ctx);
		await second.commands.get("stop-mind").handler("", second.ctx);
		assert.equal(ops(go, "retire").at(-1).pane, SPAWN_PANE);
		assert.equal(ops(go, "retire").length, 1);
	});
});

test("on-demand refuses unassigned delegation, stray workers and burst spawns", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind, socketPath } = await startMindmuxMind(fixture, go, controlFile);
		const stray = await connectWorkerClient(socketPath, {
			type: "handshake", role: "worker", generation: GENERATION, workerId: "worker-0", tier: "flash",
		});
		const refused = await stray.waitFor((frame) => frame.type === "error", { label: "stray worker refusal" });
		assert.equal(refused.code, "UNKNOWN_ASSIGNMENT");
		const noId = await mind.runTool("delegate", { task: "unassigned" });
		assert.equal(noId.isError, true);
		assert.equal(noId.details.code, "ASSIGNMENT_REQUIRED");
		const bogus = await mind.runTool("delegate", { task: "not mine", workerId: "assign-not-mine" });
		assert.equal(bogus.isError, true);
		assert.equal(bogus.details.code, "NOT_ASSIGNED");
		await sleep(100);
		assert.equal(ops(go, "spawn").length, 0, "no hidden allocator");
	});
});

test("legacy mode keeps the worker tool inert", { timeout: 20000 }, async () => {
	await withMindmux({ onDemand: false, configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		const { mind } = await startMindmuxMind(fixture, go, controlFile);
		const result = await mind.runTool("worker", { op: "assign", tier: "flash" });
		assert.equal(result.isError, true);
		assert.equal(result.details.code, "NOT_ON_DEMAND");
		assert.equal(ops(go, "spawn").length, 0);
	});
});

test("close adopts an assign- worker from Go's list so a reload cannot orphan it", { timeout: 20000 }, async () => {
	await withMindmux({ configOverrides: ON_DEMAND_CONFIG }, async ({ fixture, go, controlFile }) => {
		go.state.behaviors.list = () => ({ ok: true, workers: [{ pane: "%7", worker_id: "assign-existing" }] });
		const { mind } = await startMindmuxMind(fixture, go, controlFile);
		const closed = await mind.runTool("worker", { op: "close", workerId: "assign-existing" });
		assert.notEqual(closed.isError, true, closed.content?.[0]?.text);
		assert.equal(closed.details.code, "CLOSED");
		assert.equal(ops(go, "retire").at(-1).pane, "%7");
	});
});
