// worker-task-lifecycle.mind.test.mjs
//
// Mind-side half of plan 001: a timed-out, aborted or disconnected task keeps its
// worker busy until the worker acknowledges quiescence; the caller settles once
// and early; a foreign or stale terminal frame can never free or resolve another
// actor; the drain deadline closes the socket through the existing close funnel.
//
// Real extension as Mind, real Unix sockets, fake worker peers. No fixture flag
// fakes the drain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFixture, waitUntil, sleep, withTimeout } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

async function startMind(fixture, workers) {
	const mind = await fixture.startMind();
	const clients = new Map();
	for (const worker of workers) {
		clients.set(worker.workerId, await fixture.connectWorker(worker));
	}
	await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) === workers.length, {
		timeout: 4000,
		label: "all workers connected",
	});
	return { mind, clients };
}

function taskFrame(client, needle) {
	return client.waitFor((frame) => frame.type === "task" && frame.task.includes(needle), {
		label: "task " + needle,
	});
}

function taskFrames(client, needle) {
	return client.seen((frame) => frame.type === "task" && (!needle || frame.task.includes(needle)));
}

function abortFrames(client, taskId) {
	return client.seen((frame) => frame.type === "abort" && (!taskId || frame.id === taskId));
}

function asyncResults(mind, taskId) {
	return mind.messages.filter(
		(entry) => entry.message?.customType === "mind-worker-result" && entry.message?.details?.taskId === taskId,
	);
}

function queuedId(response) {
	const text = response.content?.[0]?.text || "";
	assert.match(text, /queued/, "the task must queue while the drain holds its worker");
	const id = /Task (\S+) queued/.exec(text)?.[1];
	assert.ok(id, "a queued response must expose the task id: " + JSON.stringify(response.content));
	return id;
}

test("timeout drains the worker: the caller settles, the next task waits for the ack", { timeout: 20000 }, async () => {
	await withFixture({ taskTimeout: 1, workerCount: 1 }, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [{ workerId: "worker-0", tier: "flash" }]);
		const worker = clients.get("worker-0");

		const pendingA = mind.runTool("delegate", { task: "task A", workerId: "worker-0" });
		const taskA = await taskFrame(worker, "task A");

		const queuedB = await withTimeout(
			mind.runTool("delegate_async", { task: "task B", tier: "flash" }),
			3000,
			"queue task B",
		);
		assert.equal(queuedB.isError, undefined);
		const taskBId = queuedId(queuedB);

		const resultA = await withTimeout(pendingA, 6000, "caller timeout settlement");
		assert.equal(resultA.isError, true);
		assert.equal(resultA.details?.code, "TIMEOUT", "the caller settles once with TIMEOUT");

		await waitUntil(() => abortFrames(worker, taskA.id).length === 1, { timeout: 3000, label: "drain abort" });
		await sleep(150);
		assert.equal(taskFrames(worker, "task B").length, 0, "B must not be dispatched before the ack");

		worker.send({ type: "error", id: taskA.id, code: "ABORTED", message: "Task aborted" });
		const taskB = await taskFrame(worker, "task B");
		assert.equal(taskB.id, taskBId, "B is dispatched with its own id after the ack");
		worker.send({ type: "result", id: taskB.id, explanation: "B done" });
		await waitUntil(() => asyncResults(mind, taskB.id).some((entry) => entry.message?.details?.status === "completed"), {
			timeout: 5000,
			label: "B completion",
		});
	});
});

test("an abort signal drains once: a second abort sends no frame and dispatches nothing", { timeout: 20000 }, async () => {
	await withFixture({ taskTimeout: 5, workerCount: 1 }, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [{ workerId: "worker-0", tier: "flash" }]);
		const worker = clients.get("worker-0");

		const controller = new AbortController();
		const pending = mind.runTool("delegate", { task: "signal task", workerId: "worker-0" }, { signal: controller.signal });
		const task = await taskFrame(worker, "signal task");

		controller.abort();
		const result = await withTimeout(pending, 5000, "abort settlement");
		assert.equal(result.isError, true);
		await waitUntil(() => abortFrames(worker, task.id).length === 1, { timeout: 3000, label: "drain abort" });

		const queued = await withTimeout(
			mind.runTool("delegate_async", { task: "waits for signal ack", tier: "flash" }),
			3000,
			"queue after signal abort",
		);
		queuedId(queued);

		controller.abort();
		await sleep(150);
		assert.equal(abortFrames(worker, task.id).length, 1, "one abort frame only");
		assert.equal(taskFrames(worker, "waits for signal ack").length, 0, "no dispatch while draining");

		worker.send({ type: "error", id: task.id, code: "ABORTED", message: "Task aborted" });
		const next = await taskFrame(worker, "waits for signal ack");
		worker.send({ type: "result", id: next.id, explanation: "queued done" });
	});
});

test("subdelegate timeout drains the flash worker; the queued child waits for its ack", { timeout: 20000 }, async () => {
	await withFixture({
		taskTimeout: 1,
		workerModels: [
			{ model: "stub/model", count: 1, tier: "strong" },
			{ model: "stub/model", count: 1, tier: "flash" },
		],
	}, async (fixture) => {
		const { clients } = await startMind(fixture, [
			{ workerId: "worker-strong", tier: "strong" },
			{ workerId: "worker-flash", tier: "flash" },
		]);
		const strong = clients.get("worker-strong");
		const flash = clients.get("worker-flash");

		strong.send({ type: "subdelegate-request", id: "sub-1", task: "child one" });
		const child = await taskFrame(flash, "child one");

		const timedOut = await strong.waitFor(
			(frame) => frame.type === "subdelegate-response" && frame.id === "sub-1" && frame.code === "TIMEOUT",
			{ timeout: 6000, label: "subdelegate TIMEOUT" },
		);
		assert.equal(timedOut.code, "TIMEOUT");
		await waitUntil(() => abortFrames(flash, child.id).length === 1, { timeout: 3000, label: "child drain abort" });

		strong.send({ type: "subdelegate-request", id: "sub-2", task: "child two" });
		await sleep(150);
		assert.equal(taskFrames(flash, "child two").length, 0, "the queued child waits for the ack");

		flash.send({ type: "error", id: child.id, code: "ABORTED", message: "Task aborted" });
		const second = await taskFrame(flash, "child two");
		flash.send({ type: "result", id: second.id, explanation: "child two done" });
		const response = await strong.waitFor(
			(frame) => frame.type === "subdelegate-response" && frame.id === "sub-2",
			{ timeout: 5000, label: "second subdelegate response" },
		);
		assert.match(response.explanation, /child two done/);
	});
});

test("a requester abort drains the flash worker and still answers the requester", { timeout: 20000 }, async () => {
	await withFixture({
		taskTimeout: 10,
		workerModels: [
			{ model: "stub/model", count: 1, tier: "strong" },
			{ model: "stub/model", count: 1, tier: "flash" },
		],
	}, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [
			{ workerId: "worker-strong", tier: "strong" },
			{ workerId: "worker-flash", tier: "flash" },
		]);
		const strong = clients.get("worker-strong");
		const flash = clients.get("worker-flash");

		strong.send({ type: "subdelegate-request", id: "sub-abort", task: "abortable child" });
		const child = await taskFrame(flash, "abortable child");

		strong.send({ type: "abort", id: "sub-abort" });
		const response = await strong.waitFor(
			(frame) => frame.type === "subdelegate-response" && frame.id === "sub-abort" && frame.code === "ABORTED",
			{ label: "requester ABORTED response" },
		);
		assert.equal(response.code, "ABORTED");
		await waitUntil(() => abortFrames(flash, child.id).length === 1, { timeout: 3000, label: "child drain abort" });

		const queued = await withTimeout(
			mind.runTool("delegate_async", { task: "waits for child ack", tier: "flash" }),
			3000,
			"queue after requester abort",
		);
		queuedId(queued);
		await sleep(100);
		assert.equal(taskFrames(flash, "waits for child ack").length, 0, "no re-dispatch before the ack");

		flash.send({ type: "error", id: child.id, code: "ABORTED", message: "Task aborted" });
		const next = await taskFrame(flash, "waits for child ack");
		flash.send({ type: "result", id: next.id, explanation: "queued done" });
	});
});

test("a requester disconnect drains the flash worker instead of freeing it", { timeout: 20000 }, async () => {
	await withFixture({
		taskTimeout: 10,
		workerModels: [
			{ model: "stub/model", count: 1, tier: "strong" },
			{ model: "stub/model", count: 1, tier: "flash" },
		],
	}, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [
			{ workerId: "worker-strong", tier: "strong" },
			{ workerId: "worker-flash", tier: "flash" },
		]);
		const strong = clients.get("worker-strong");
		const flash = clients.get("worker-flash");

		strong.send({ type: "subdelegate-request", id: "sub-gone", task: "orphan child" });
		const child = await taskFrame(flash, "orphan child");

		strong.close();
		await strong.waitForClose({ timeout: 3000 });
		await waitUntil(() => abortFrames(flash, child.id).length === 1, { timeout: 3000, label: "child drain abort" });

		const queued = await withTimeout(
			mind.runTool("delegate_async", { task: "waits for ack", tier: "flash" }),
			3000,
			"queue while draining",
		);
		assert.equal(queued.isError, undefined);
		await sleep(150);
		assert.equal(taskFrames(flash, "waits for ack").length, 0, "queued work waits for the ack");

		flash.send({ type: "error", id: child.id, code: "ABORTED", message: "Task aborted" });
		const next = await taskFrame(flash, "waits for ack");
		flash.send({ type: "result", id: next.id, explanation: "queued done" });
	});
});

test("fanout lane timeouts and aborts drain each worker until its ack", { timeout: 30000 }, async () => {
	await withFixture({ taskTimeout: 1, workerModels: [{ model: "stub/model", count: 3, tier: "flash" }] }, async (fixture) => {
		const workers = ["worker-0", "worker-1", "worker-2"];
		const { mind, clients } = await startMind(fixture, workers.map((workerId) => ({ workerId, tier: "flash" })));

		const fanout = mind.runTool("delegate", { task: "run tests", strategy: "fanout", intent: "test" });
		const lanes = [];
		for (const workerId of workers) {
			lanes.push(await taskFrame(clients.get(workerId), "Lane"));
		}
		const result = await withTimeout(fanout, 8000, "fanout settlement");
		assert.match(result.content[0].text, /3 errors/, "one timed-out lane makes the fanout an error");
		for (const workerId of workers) {
			const worker = clients.get(workerId);
			await waitUntil(() => abortFrames(worker).length === 1, { timeout: 3000, label: "lane drain abort" });
			assert.equal(taskFrames(worker).length, 1, "a lane timeout must not re-dispatch the worker");
		}

		for (const workerId of workers) {
			const lane = lanes[workers.indexOf(workerId)];
			clients.get(workerId).send({ type: "error", id: lane.id, code: "ABORTED", message: "Task aborted" });
		}
		await sleep(200);

		const controller = new AbortController();
		const aborted = mind.runTool(
			"delegate",
			{ task: "abort lanes", strategy: "fanout", intent: "test" },
			{ signal: controller.signal },
		);
		for (const workerId of workers) await taskFrame(clients.get(workerId), "Lane");
		controller.abort();
		const abortedResult = await withTimeout(aborted, 5000, "aborted fanout");
		assert.match(abortedResult.content[0].text, /3 errors/, "every lane reports the abort");
		for (const workerId of workers) {
			const worker = clients.get(workerId);
			await waitUntil(() => abortFrames(worker).length === 2, { timeout: 3000, label: "lane abort drain" });
			assert.equal(taskFrames(worker).length, 2, "an aborted lane must not re-dispatch its worker");
		}
	});
});

test("no ack by the deadline: the drain closes the worker and only unservable queue entries fail", { timeout: 30000 }, async () => {
	await withFixture({ taskTimeout: 1, workerCount: 1 }, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [{ workerId: "worker-0", tier: "flash" }]);
		const worker = clients.get("worker-0");

		const pendingA = mind.runTool("delegate", { task: "dead task", workerId: "worker-0" });
		const taskA = await taskFrame(worker, "dead task");
		const resultA = await withTimeout(pendingA, 6000, "caller timeout");
		assert.equal(resultA.details?.code, "TIMEOUT");

		const queued = await withTimeout(
			mind.runTool("delegate_async", { task: "unservable", tier: "flash" }),
			3000,
			"queue unservable",
		);
		const queuedTaskId = queuedId(queued);

		await worker.waitForClose({ timeout: 12000 });
		await waitUntil(() => fixture.readControl()?.status === "ready", { timeout: 3000, label: "control ready after the deadline" });
		await waitUntil(() => asyncResults(mind, queuedTaskId).length > 0, { timeout: 5000, label: "queued failure" });
		const failures = asyncResults(mind, queuedTaskId);
		assert.equal(failures.length, 1, "the queue entry settles exactly once");
		assert.match(failures[0].message.content, /WORKER_UNAVAILABLE/);
		assert.equal(taskFrames(worker, "unservable").length, 0, "no task frame reached the dead socket");

		// The pool still serves a fresh connection after the deadline cleanup.
		const revived = await fixture.connectWorker({ workerId: "worker-1", tier: "flash" });
		await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) === 1, {
			timeout: 4000,
			label: "revived worker connected",
		});
		const pending = mind.runTool("delegate", { task: "after expiry", workerId: "worker-1" });
		const task = await taskFrame(revived, "after expiry");
		revived.send({ type: "result", id: task.id, explanation: "revived" });
		const done = await withTimeout(pending, 5000, "revived delegate");
		assert.equal(done.isError, undefined);
	});
});

test("the deadline keeps work a compatible reset in flight still serves, and the replacement dispatches it", { timeout: 40000 }, async () => {
	await withFixture({ taskTimeout: 1, resetTimeout: 30, workerModels: [{ model: "stub/model", count: 2, tier: "flash" }] }, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [
			{ workerId: "worker-0", tier: "flash" },
			{ workerId: "worker-1", tier: "flash" },
		]);
		const resetting = clients.get("worker-0");
		const dying = clients.get("worker-1");

		// worker-0 holds a valid reset: the fake worker never answers the control.
		const resetTask = mind.runTool("delegate_async", { task: "reset work", workerId: "worker-0", reset: true });
		const resetFrame = await resetting.waitFor((frame) => frame.type === "reset", { timeout: 4000, label: "reset control" });

		// worker-1 times out, drains and never acknowledges: the deadline closes it.
		const pendingDrain = mind.runTool("delegate", { task: "dead task", workerId: "worker-1" });
		await dying.waitFor((frame) => frame.type === "task" && frame.task.includes("dead task"), { timeout: 4000 });
		const drainCaller = await withTimeout(pendingDrain, 6000, "drain caller");
		assert.equal(drainCaller.details?.code, "TIMEOUT");

		const queued = await withTimeout(mind.runTool("delegate_async", { task: "served after reset", tier: "flash" }), 4000, "queue");
		const queuedTaskId = queuedId(queued);

		await dying.waitForClose({ timeout: 12000 });
		await sleep(400);
		assert.equal(asyncResults(mind, queuedTaskId).length, 0, "a compatible reset in flight still owns this entry");

		// The reset replacement takes the retained reset task, then the queued work.
		const fresh = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: resetFrame.resetId });
		const retained = await fresh.waitFor((frame) => frame.type === "task" && frame.task.includes("reset work"), { timeout: 6000, label: "retained reset task" });
		fresh.send({ type: "result", id: retained.id, explanation: "reset work done" });
		const served = await fresh.waitFor(
			(frame) => frame.type === "task" && frame.task.includes("served after reset"),
			{ timeout: 6000, label: "queued work dispatched after the reset" },
		);
		assert.equal(served.id, queuedTaskId, "the surviving entry is dispatched with its own id");
		fresh.send({ type: "result", id: served.id, explanation: "queued done" });
		await waitUntil(() => asyncResults(mind, queuedTaskId).some((entry) => entry.message?.details?.status === "completed"), {
			timeout: 5000,
			label: "queued completion",
		});
		await withTimeout(resetTask, 8000, "reset task settlement");
	});
});

test("an unrelated reservation and an incompatible live worker do not retain unservable entries", { timeout: 40000 }, async () => {
	await withFixture({
		taskTimeout: 1,
		resetTimeout: 30,
		workerModels: [
			{ model: "stub/model", count: 1, tier: "strong" },
			{ model: "stub/model", count: 1, tier: "flash" },
		],
	}, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [
			{ workerId: "worker-strong", tier: "strong" },
			{ workerId: "worker-flash", tier: "flash" },
		]);
		const strong = clients.get("worker-strong");
		const flash = clients.get("worker-flash");

		// A valid but unrelated (strong) reset reservation.
		const strongReset = mind.runTool("delegate_async", { task: "strong reset work", workerId: "worker-strong", reset: true });
		void strongReset.catch(() => {});
		await strong.waitFor((frame) => frame.type === "reset", { timeout: 4000, label: "strong reset control" });

		// The flash worker dies at the drain deadline.
		const pendingDrain = mind.runTool("delegate", { task: "flash dead task", workerId: "worker-flash" });
		await flash.waitFor((frame) => frame.type === "task" && frame.task.includes("flash dead task"), { timeout: 4000 });
		await withTimeout(pendingDrain, 6000, "flash drain caller");

		// A flash reset can never be served by the strong worker or its reservation.
		const queuedReset = await withTimeout(
			mind.runTool("delegate_async", { task: "flash reset queued", tier: "flash", reset: true }),
			4000,
			"queue flash reset",
		);
		const queuedTaskId = queuedId(queuedReset);

		await flash.waitForClose({ timeout: 12000 });
		await waitUntil(() => asyncResults(mind, queuedTaskId).length > 0, { timeout: 6000, label: "unservable flash reset fails" });
		const failures = asyncResults(mind, queuedTaskId);
		assert.equal(failures.length, 1, "the entry settles exactly once");
		assert.match(failures[0].message.content, /WORKER_UNAVAILABLE/);
		assert.equal(taskFrames(flash, "flash reset queued").length, 0, "no reset frame reached the dead flash worker");
	});
});

test("a plain entry survives the deadline while a reset replacement is in flight and is served after it", { timeout: 45000 }, async () => {
	await withFixture({
		taskTimeout: 1,
		resetTimeout: 30,
		workerCount: 2,
		workerModels: [{ model: "stub/model", count: 2, tier: "strong" }],
	}, async (fixture) => {
		const mind = await fixture.startMind();
		const a = await fixture.connectWorker({ workerId: "worker-a", tier: "strong" });
		const b = await fixture.connectWorker({ workerId: "worker-b", tier: "strong" });
		await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) === 2, { timeout: 4000, label: "two workers connected" });

		// worker-a begins a valid reset and its old socket closes (expected) before any replacement.
		const resetWork = mind.runTool("delegate_async", { task: "reset work", workerId: "worker-a", reset: true });
		void resetWork.catch(() => {});
		const resetFrame = await a.waitFor((frame) => frame.type === "reset", { timeout: 4000, label: "reset control" });
		a.close();
		await a.waitForClose({ timeout: 3000 });
		await sleep(200);

		// worker-b times out, drains and never acknowledges: the deadline closes it.
		const pendingB = mind.runTool("delegate", { task: "dead task", workerId: "worker-b" });
		await b.waitFor((frame) => frame.type === "task" && frame.task.includes("dead task"), { timeout: 4000 });
		const bCaller = await withTimeout(pendingB, 6000, "worker-b drain caller");
		assert.equal(bCaller.details?.code, "TIMEOUT");

		// A plain entry queues while worker-b is still connected (draining).
		const queued = await withTimeout(mind.runTool("delegate_async", { task: "plain X", tier: "strong" }), 4000, "queue plain X");
		const xId = queuedId(queued);

		// The deadline fires while worker-a's replacement is still absent: the live reservation keeps X queued.
		await b.waitForClose({ timeout: 12000 });
		await sleep(400);
		assert.equal(asyncResults(mind, xId).length, 0, "a reset replacement in flight still owns this entry");

		// The exact-resetId replacement accepts the retained reset task, then serves X.
		const fresh = await fixture.connectWorker({ workerId: "worker-a", tier: "strong", resetId: resetFrame.resetId });
		const retained = await fresh.waitFor(
			(frame) => frame.type === "task" && frame.task.includes("reset work"),
			{ timeout: 6000, label: "retained reset task accepted" },
		);
		fresh.send({ type: "result", id: retained.id, explanation: "reset work done" });
		const served = await fresh.waitFor(
			(frame) => frame.type === "task" && frame.task.includes("plain X"),
			{ timeout: 6000, label: "plain X dispatched after the replacement" },
		);
		assert.equal(served.id, xId, "X is dispatched with its own id");
		fresh.send({ type: "result", id: served.id, explanation: "X done" });

		await waitUntil(() => asyncResults(mind, xId).some((entry) => entry.message?.details?.status === "completed"), {
			timeout: 5000,
			label: "plain X completion",
		});
		const finals = asyncResults(mind, xId);
		assert.equal(finals.length, 1, "X settles exactly once, never with WORKER_UNAVAILABLE");
		assert.equal(finals[0].message.details.status, "completed");
		await withTimeout(resetWork, 8000, "reset task settlement");
	});
});

test("a foreign ack or result cannot free or resolve another worker's task", { timeout: 30000 }, async () => {
	await withFixture({
		taskTimeout: 1,
		workerModels: [
			{ model: "stub/model", count: 1, tier: "strong" },
			{ model: "stub/model", count: 1, tier: "flash" },
		],
	}, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [
			{ workerId: "worker-flash", tier: "flash" },
			{ workerId: "worker-strong", tier: "strong" },
		]);
		const flash = clients.get("worker-flash");
		const strong = clients.get("worker-strong");

		const pendingA = mind.runTool("delegate", { task: "flash task", workerId: "worker-flash" });
		const taskA = await taskFrame(flash, "flash task");
		await withTimeout(pendingA, 6000, "caller timeout");

		const queued = await withTimeout(
			mind.runTool("delegate_async", { task: "queued flash", tier: "flash" }),
			3000,
			"queue flash work",
		);
		queuedId(queued);

		strong.send({ type: "error", id: taskA.id, code: "ABORTED", message: "foreign ack" });
		await sleep(200);
		assert.equal(taskFrames(flash, "queued flash").length, 0, "a foreign ack must not free the draining worker");

		flash.send({ type: "error", id: taskA.id, code: "ABORTED", message: "Task aborted" });
		const dispatched = await taskFrame(flash, "queued flash");
		flash.send({ type: "result", id: dispatched.id, explanation: "queued done" });
	});

	await withFixture({
		taskTimeout: 5,
		workerModels: [
			{ model: "stub/model", count: 1, tier: "strong" },
			{ model: "stub/model", count: 1, tier: "flash" },
		],
	}, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [
			{ workerId: "worker-flash", tier: "flash" },
			{ workerId: "worker-strong", tier: "strong" },
		]);
		const flash = clients.get("worker-flash");
		const strong = clients.get("worker-strong");

		const pending = mind.runTool("delegate", { task: "strong task", workerId: "worker-strong" });
		const task = await taskFrame(strong, "strong task");

		flash.send({ type: "result", id: task.id, explanation: "foreign result" });
		await sleep(200);
		assert.equal(taskFrames(flash).length, 0, "the foreign result is ignored");

		strong.send({ type: "result", id: task.id, explanation: "real result" });
		const done = await withTimeout(pending, 5000, "real result");
		assert.equal(done.isError, undefined);
		assert.equal(done.content[0].text, "real result", "only the owning socket resolves the caller");
	});
});

test("reset guards: a draining worker is not reset target and teardown clears the drain once", { timeout: 25000 }, async () => {
	await withFixture({ taskTimeout: 1, workerCount: 1 }, async (fixture) => {
		const { mind, clients } = await startMind(fixture, [{ workerId: "worker-0", tier: "flash" }]);
		const worker = clients.get("worker-0");

		const pendingA = mind.runTool("delegate", { task: "drain target", workerId: "worker-0" });
		await taskFrame(worker, "drain target");
		await withTimeout(pendingA, 6000, "caller timeout");
		await waitUntil(() => abortFrames(worker).length === 1, { timeout: 3000, label: "drain abort" });

		const resetTry = await mind.runTool("delegate", { task: "reset target", workerId: "worker-0", reset: true });
		assert.equal(resetTry.isError, true);
		assert.match(resetTry.content[0].text, /busy/i, "reset cannot steal a draining worker");

		const queued = await mind.runTool("delegate_async", { task: "queued during drain", tier: "flash" });
		const queuedTaskId = queuedId(queued);
		await sleep(150);
		assert.equal(taskFrames(worker, "queued during drain").length, 0, "the plain task stays queued until the ack");

		await mind.sessionShutdown();
		await waitUntil(() => asyncResults(mind, queuedTaskId).length > 0, { timeout: 5000, label: "teardown settlement" });
		assert.equal(asyncResults(mind, queuedTaskId).length, 1, "teardown settles the queued caller exactly once");
	});
});
