// worker-session-reset.mind.test.mjs
//
// Mind-side half of the reset protocol (plan §4-§7, §10-§13): reservation
// ownership, the handshake coordinator, expected-disconnect suppression, and
// the observable error matrix. Real extension module, real Unix sockets, fake
// worker peers. See support/fixture.mjs for what the fake Pi reproduces.
//
// Coverage intentionally omitted:
//   - RESET_BUSY while Mind tracks an in-flight task: unreachable through the
//     public tools, which reject a busy explicit target before any control.
//   - "connected state written before dispatch": not atomically observable from
//     the socket; the post-dispatch busy control state is asserted instead.
//   - pure reservation-matching units: production exports no helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFixture, waitUntil, sleep, withTimeout } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

async function waitForWorkerCount(fixture, count = 1) {
	await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) === count, {
		timeout: 4000,
		label: "connectedWorkers === " + count,
	});
}

function isResetFrame(frame) {
	return frame.type === "reset";
}

function taskFrames(client, needle) {
	return client.seen((frame) => frame.type === "task" && (!needle || frame.task.includes(needle)));
}

function asyncResults(mind, taskId) {
	return mind.messages.filter(
		(entry) => entry.message?.customType === "mind-worker-result" && (!taskId || entry.message?.details?.taskId === taskId),
	);
}

test("blocking delegate: reset, replacement handshake, then the retained task on the new socket", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const oldWorker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const pending = mind.runTool("delegate", { task: "rewrite the parser", workerId: "worker-0", reset: true });
		const reset = await oldWorker.waitFor(isResetFrame, { label: "reset control" });
		assert.ok(typeof reset.resetId === "string" && reset.resetId.length > 0, "reset control must carry resetId");
		assert.equal(taskFrames(oldWorker).length, 0, "the retained task must never use the old context");

		oldWorker.close();
		await oldWorker.waitForClose({ timeout: 3000 });

		const replacement = await fixture.connectWorker({
			workerId: "worker-0",
			tier: "flash",
			resetId: reset.resetId,
		});
		const task = await replacement.waitFor((frame) => frame.type === "task", { label: "retained task" });
		assert.match(task.task, /rewrite the parser/);
		assert.equal("reset" in task, false, "a normal task payload must never carry reset");
		assert.equal(fixture.readControl()?.status, "busy", "the retained task must leave the control file busy");

		replacement.send({ type: "result", id: task.id, explanation: "parser rewritten" });
		const result = await withTimeout(pending, 5000, "delegate result");
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0].text, "parser rewritten");
	});
});

test("delegate_async: reset delivers exactly one completed worker_result", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const oldWorker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const dispatched = await withTimeout(
			mind.runTool("delegate_async", { task: "async reset work", workerId: "worker-0", reset: true }),
			3000,
			"delegate_async dispatch",
		);
		assert.equal(dispatched.isError, undefined);

		const reset = await oldWorker.waitFor(isResetFrame, { label: "reset control" });
		oldWorker.close();
		const replacement = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: reset.resetId });
		const task = await replacement.waitFor((frame) => frame.type === "task", { label: "retained async task" });
		replacement.send({ type: "result", id: task.id, explanation: "async done" });

		await waitUntil(
			() => mind.messages.some((entry) => entry.message?.customType === "mind-worker-result"),
			{ timeout: 5000, label: "worker_result" },
		);
		const results = mind.messages.filter((entry) => entry.message?.customType === "mind-worker-result");
		assert.equal(results.length, 1, "exactly one settlement per async task");
		assert.equal(results[0].message.details.status, "completed");
		assert.match(results[0].message.content, /async done/);
	});
});

test("replacement handshake wins the race: no DUPLICATE_ID/POOL_FULL and a late old close is harmless", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const oldWorker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const pending = mind.runTool("delegate", { task: "race work", workerId: "worker-0", reset: true });
		const reset = await oldWorker.waitFor(isResetFrame, { label: "reset control" });

		// The replacement connects while the old connection is still pooled.
		const replacement = await fixture.connectWorker({
			workerId: "worker-0",
			tier: "flash",
			resetId: reset.resetId,
		});
		const task = await replacement.waitFor((frame) => frame.type === "task", { label: "retained task" });
		assert.equal(
			replacement.seen((frame) => frame.type === "error" && (frame.code === "DUPLICATE_ID" || frame.code === "POOL_FULL")).length,
			0,
			"a reset replacement must bypass duplicate and capacity guards",
		);

		// The old socket closes after the replacement was installed.
		oldWorker.close();
		await sleep(100);

		replacement.send({ type: "result", id: task.id, explanation: "race ok" });
		const result = await withTimeout(pending, 5000, "delegate result");
		assert.equal(result.isError, undefined);

		// The replacement is still the current worker: a plain task reaches it.
		const followUp = mind.runTool("delegate", { task: "follow up", workerId: "worker-0" });
		const followTask = await replacement.waitFor((frame) => frame.type === "task", { label: "follow-up task" });
		assert.match(followTask.task, /follow up/);
		replacement.send({ type: "result", id: followTask.id, explanation: "still here" });
		const followResult = await withTimeout(followUp, 5000, "follow-up result");
		assert.equal(followResult.isError, undefined);
	});
});

test("a mismatched replacement is RESET_PROTOCOL and the worker can reconnect normally afterwards", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const oldWorker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const pending = mind.runTool("delegate", { task: "protocol work", workerId: "worker-0", reset: true });
		const reset = await oldWorker.waitFor(isResetFrame, { label: "reset control" });

		const bogus = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: "not-" + reset.resetId });
		const error = await bogus.waitFor((frame) => frame.type === "error" && frame.code === "RESET_PROTOCOL", {
			label: "RESET_PROTOCOL",
		});
		assert.ok(error);
		const result = await withTimeout(pending, 5000, "delegate result");
		assert.equal(result.isError, true);
		assert.equal(result.details?.code, "RESET_PROTOCOL");

		// The stale old socket must be gone, and a later ordinary handshake accepted.
		const revived = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);
		const followUp = mind.runTool("delegate", { task: "after protocol error", workerId: "worker-0" });
		const task = await revived.waitFor((frame) => frame.type === "task", { label: "task after reconnect" });
		assert.match(task.task, /after protocol error/);
		assert.equal(revived.seen((frame) => frame.type === "error" && frame.code === "DUPLICATE_ID").length, 0);
		revived.send({ type: "result", id: task.id, explanation: "revived" });
		await withTimeout(followUp, 5000, "revived result");
	});
});

test("an unrelated duplicate connection is still refused with DUPLICATE_ID", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 2 }, async (fixture) => {
		const mind = await fixture.startMind();
		const first = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const duplicate = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		const error = await duplicate.waitFor((frame) => frame.type === "error" && frame.code === "DUPLICATE_ID", {
			label: "DUPLICATE_ID",
		});
		assert.ok(error, "a second socket without a reset reservation must be refused");

		// The original connection is untouched.
		const pending = mind.runTool("delegate", { task: "original still works", workerId: "worker-0" });
		const task = await first.waitFor((frame) => frame.type === "task", { label: "task on original connection" });
		first.send({ type: "result", id: task.id, explanation: "ok" });
		const result = await withTimeout(pending, 5000, "original result");
		assert.equal(result.isError, undefined);
	});
});

test("an abandoned reservation expires quietly: no second settlement, stale socket dropped", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1, resetTimeout: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const controller = new AbortController();
		await withTimeout(
			mind.runTool("delegate_async", { task: "abandon me", workerId: "worker-0", reset: true }, { signal: controller.signal }),
			3000,
			"delegate_async dispatch",
		);
		await worker.waitFor(isResetFrame, { label: "reset control" });
		controller.abort();
		await waitUntil(
			() => mind.messages.some((entry) => entry.message?.customType === "mind-worker-result" && entry.message?.details?.status === "error"),
			{ timeout: 5000, label: "aborted async result" },
		);

		// No replacement arrives: the tombstone timer must destroy the socket
		// without settling the already-settled task a second time.
		await worker.waitForClose({ timeout: 5000 });
		await sleep(300);
		const errorResults = mind.messages.filter(
			(entry) => entry.message?.customType === "mind-worker-result" && entry.message?.details?.status === "error",
		);
		assert.equal(errorResults.length, 1, "an abandoned record must not settle twice");
	});
});

test("queued reset is owned by the queue until dispatch, then by the reservation", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const first = mind.runTool("delegate", { task: "first task", workerId: "worker-0" });
		const firstFrame = await worker.waitFor((frame) => frame.type === "task", { label: "first task" });

		// No idle worker: the reset request must queue, not fail and not dispatch.
		const queued = mind.runTool("delegate", { task: "queued with reset", tier: "flash", reset: true });
		await sleep(100);
		assert.equal(taskFrames(worker, "queued with reset").length, 0);

		worker.send({ type: "result", id: firstFrame.id, explanation: "first done" });
		await withTimeout(first, 5000, "first result");

		const reset = await worker.waitFor(isResetFrame, { label: "reset from queue" });
		assert.equal(taskFrames(worker, "queued with reset").length, 0, "the queued reset must never be sent as a task");

		worker.close();
		const replacement = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: reset.resetId });
		const task = await replacement.waitFor((frame) => frame.type === "task", { label: "queued task on replacement" });
		assert.match(task.task, /queued with reset/);
		replacement.send({ type: "result", id: task.id, explanation: "queued done" });
		const result = await withTimeout(queued, 5000, "queued result");
		assert.equal(result.isError, undefined);
	});
});

test("queued work survives the empty-pool window of a reset", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const resettingTask = mind.runTool("delegate", { task: "task A", workerId: "worker-0", reset: true });
		const reset = await worker.waitFor(isResetFrame, { label: "reset control" });

		const queuedResult = await withTimeout(
			mind.runTool("delegate_async", { task: "task B", tier: "flash" }),
			3000,
			"queue task B",
		);
		assert.equal(queuedResult.isError, undefined, "task B must queue, not fail");
		const taskBId = /Task (\S+) queued/.exec(queuedResult.content[0].text)?.[1];
		assert.ok(taskBId, "queued response must expose the task id: " + queuedResult.content[0].text);

		worker.close();
		await worker.waitForClose({ timeout: 3000 });
		await sleep(200);
		assert.equal(
			mind.messages.filter((entry) => entry.message?.details?.taskId === taskBId && entry.message?.details?.status === "error").length,
			0,
			"an expected reset close must not fail queued work",
		);

		const replacement = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: reset.resetId });
		const taskA = await replacement.waitFor((frame) => frame.type === "task", { label: "task A" });
		assert.match(taskA.task, /task A/);
		replacement.send({ type: "result", id: taskA.id, explanation: "A done" });

		const taskB = await replacement.waitFor((frame) => frame.type === "task", { label: "task B" });
		assert.match(taskB.task, /task B/);
		replacement.send({ type: "result", id: taskB.id, explanation: "B done" });
		await waitUntil(
			() => mind.messages.some((entry) => entry.message?.details?.taskId === taskBId && entry.message?.details?.status === "completed"),
			{ timeout: 5000, label: "task B completion" },
		);
		await withTimeout(resettingTask, 5000, "task A result");
	});
});

test("a missing replacement fails the retained task with RESET_TIMEOUT", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1, resetTimeout: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const pending = mind.runTool("delegate", { task: "timed out reset", workerId: "worker-0", reset: true });
		await worker.waitFor(isResetFrame, { label: "reset control" });
		const result = await withTimeout(pending, 6000, "timeout settlement");
		assert.equal(result.isError, true);
		assert.equal(result.details?.code, "RESET_TIMEOUT");
		await worker.waitForClose({ timeout: 3000 });
	});
});

test("caller abort settles ABORTED and keeps a tombstone that still accepts the replacement", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const controller = new AbortController();
		const dispatched = await withTimeout(
			mind.runTool("delegate_async", { task: "abort me", workerId: "worker-0", reset: true }, { signal: controller.signal }),
			3000,
			"delegate_async dispatch",
		);
		assert.equal(dispatched.isError, undefined);
		const reset = await worker.waitFor(isResetFrame, { label: "reset control" });

		controller.abort();
		await waitUntil(
			() => mind.messages.some((entry) => entry.message?.customType === "mind-worker-result" && entry.message?.details?.status === "error"),
			{ timeout: 5000, label: "aborted async result" },
		);

		// The abandoned reservation still matches the replacement, but dispatches nothing.
		const replacement = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: reset.resetId });
		await sleep(300);
		assert.equal(taskFrames(replacement).length, 0, "an abandoned reservation must not dispatch a retained task");

		const followUp = mind.runTool("delegate", { task: "after abort", workerId: "worker-0" });
		const task = await replacement.waitFor((frame) => frame.type === "task", { label: "task after abort" });
		assert.match(task.task, /after abort/);
		replacement.send({ type: "result", id: task.id, explanation: "post abort" });
		const result = await withTimeout(followUp, 5000, "post-abort result");
		assert.equal(result.isError, undefined);
	});
});

test("RESET_BUSY without a tracked task fails the caller and drops the desynced socket", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const pending = mind.runTool("delegate", { task: "busy reply", workerId: "worker-0", reset: true });
		const reset = await worker.waitFor(isResetFrame, { label: "reset control" });
		worker.send({ type: "error", code: "RESET_BUSY", resetId: reset.resetId });

		const result = await withTimeout(pending, 5000, "RESET_BUSY settlement");
		assert.equal(result.isError, true);
		assert.equal(result.details?.code, "RESET_BUSY");
		await worker.waitForClose({ timeout: 3000 });
	});
});

test("teardown settles every in-flight reset instead of hanging the caller", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const pending = mind.runTool("delegate", { task: "teardown", workerId: "worker-0", reset: true });
		await worker.waitFor(isResetFrame, { label: "reset control" });
		await mind.sessionShutdown("quit");
		const result = await withTimeout(pending, 5000, "teardown settlement");
		assert.equal(result.isError, true);
		assert.ok(["SUSPEND", "SESSION_END"].includes(result.details?.code), "unexpected teardown code: " + result.details?.code);
	});
});

test("fanout/auto plus reset is rejected with RESET_UNSUPPORTED", { timeout: 15000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const result = await withTimeout(
			mind.runTool("delegate", { task: "fan out", strategy: "auto", reset: true }),
			3000,
			"fanout rejection",
		);
		assert.equal(result.isError, true);
		assert.equal(result.details?.code, "RESET_UNSUPPORTED");
	});
});

test("an explicit busy target rejects reset, and a resetting target is not overwritten", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const first = mind.runTool("delegate", { task: "occupy worker", workerId: "worker-0" });
		const firstFrame = await worker.waitFor((frame) => frame.type === "task", { label: "occupying task" });

		const busyAttempt = await withTimeout(
			mind.runTool("delegate", { task: "needs reset", workerId: "worker-0", reset: true }),
			3000,
			"busy rejection",
		);
		assert.equal(busyAttempt.isError, true);
		assert.match(busyAttempt.content[0].text, /busy/i);
		assert.equal(worker.seen(isResetFrame).length, 0, "a busy worker must not receive a reset control");

		worker.send({ type: "result", id: firstFrame.id, explanation: "free now" });
		await withTimeout(first, 5000, "first result");

		const resetting = mind.runTool("delegate", { task: "third", workerId: "worker-0", reset: true });
		const reset = await worker.waitFor(isResetFrame, { label: "reset control" });
		const secondAttempt = await withTimeout(
			mind.runTool("delegate_async", { task: "fourth", workerId: "worker-0", reset: true }),
			3000,
			"resetting rejection",
		);
		assert.equal(secondAttempt.isError, true, "a resetting worker counts as busy");

		worker.close();
		const replacement = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: reset.resetId });
		const task = await replacement.waitFor((frame) => frame.type === "task", { label: "first retained task" });
		assert.match(task.task, /third/);
		replacement.send({ type: "result", id: task.id, explanation: "third done" });
		const result = await withTimeout(resetting, 5000, "retained result");
		assert.equal(result.isError, undefined);
	});
});

test("no burst spawn on the queued-reset path, and a burst worker never consumes it", { timeout: 25000 }, async () => {
	await withFixture(
		{
			// Two static flash slots: the burst connection occupies one tier slot in
			// the pool-capacity check, so a 1-worker config would reject worker-0.
			workerCount: 2,
			packageDir: "/nonexistent/pi-package-for-burst-safety",
			burstFlash: { enabled: true, maxBurst: 2, queuePressureThreshold: 1, spawnWaitMs: 10000 },
		},
		async (fixture) => {
			const mind = await fixture.startMind();
			// No worker: a reset request queues (never spawns a burst worker).
			const pending = mind.runTool("delegate", { task: "burst safety", tier: "flash", reset: true });
			await sleep(300);
			assert.doesNotMatch(fixture.readLog(), /burst-flash/i, "a queued reset must not spawn a burst worker");

			// A live burst worker must not consume the queued reset.
			const burst = await fixture.connectWorker({ workerId: "burst-flash-99", tier: "flash" });
			await sleep(400);
			assert.equal(taskFrames(burst).length, 0, "a burst worker must never receive a reset-bearing entry");

			// Explicitly targeting a burst worker with reset is unsupported.
			const rejected = await withTimeout(
				mind.runTool("delegate_async", { task: "burst reset", workerId: "burst-flash-99", reset: true }),
				3000,
				"burst reset rejection",
			);
			assert.equal(rejected.isError, true);
			assert.equal(rejected.details?.code, "RESET_UNSUPPORTED");

			// A static worker takes the reset and the queued task.
			const staticWorker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
			const reset = await staticWorker.waitFor(isResetFrame, { label: "reset control" });
			staticWorker.close();
			const replacement = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: reset.resetId });
			const task = await replacement.waitFor((frame) => frame.type === "task", { label: "queued task" });
			assert.match(task.task, /burst safety/);
			replacement.send({ type: "result", id: task.id, explanation: "done" });
			await withTimeout(pending, 5000, "queued result");
		},
	);
});

test("a normal flash queue does spawn a burst worker (positive control for the log assertion)", { timeout: 20000 }, async () => {
	await withFixture(
		{
			workerCount: 1,
			packageDir: "/nonexistent/pi-package-for-burst-safety",
			burstFlash: { enabled: true, maxBurst: 2, queuePressureThreshold: 1, spawnWaitMs: 10000 },
		},
		async (fixture) => {
			const mind = await fixture.startMind();
			// Queue without a worker through the blocking tool, which allows burst.
			const pending = mind.runTool("delegate", { task: "normal flash queue", tier: "flash" });
			await sleep(300);
			assert.match(fixture.readLog(), /burst-flash/i, "the harness must be able to observe a spawn attempt");
			void pending;
		},
	);
});

// ── Final-review regressions ────────────────────────────────────────────────

test("a late abort after a completed async task is inert", { timeout: 25000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		// Task A is async and carries an abort signal.
		const controller = new AbortController();
		const dispatchedA = await withTimeout(
			mind.runTool("delegate_async", { task: "task A", workerId: "worker-0" }, { signal: controller.signal }),
			3000,
			"dispatch A",
		);
		assert.equal(dispatchedA.isError, undefined);
		const frameA = await worker.waitFor((frame) => frame.type === "task" && frame.task.includes("task A"), {
			label: "task A",
		});
		worker.send({ type: "result", id: frameA.id, explanation: "A done" });
		await waitUntil(() => asyncResults(mind, frameA.id).length === 1, { timeout: 5000, label: "A settlement" });
		assert.equal(asyncResults(mind, frameA.id)[0].message.details.status, "completed");

		// A newer task B runs on the same worker; task C queues behind it.
		const pendingB = mind.runTool("delegate", { task: "task B", workerId: "worker-0" });
		const frameB = await worker.waitFor((frame) => frame.type === "task" && frame.task.includes("task B"), {
			label: "task B",
		});
		const queuedC = await withTimeout(
			mind.runTool("delegate_async", { task: "task C", tier: "flash" }),
			3000,
			"queue C",
		);
		assert.equal(queuedC.isError, undefined);
		const taskCId = /Task (\S+) queued/.exec(queuedC.content[0].text)?.[1];
		assert.ok(taskCId, "queued response must expose the task id");

		// Abort A long after it settled.
		controller.abort();
		await sleep(250);

		assert.equal(asyncResults(mind, frameA.id).length, 1, "a late abort must not emit a second worker_result");
		assert.equal(
			worker.seen((frame) => frame.type === "abort" && frame.id === frameA.id).length,
			0,
			"a late abort must not send a stale abort control",
		);
		assert.equal(
			worker.seen((frame) => frame.type === "task" && frame.task.includes("task C")).length,
			0,
			"a late abort must not dispatch queued work into a busy worker",
		);
		assert.equal(
			worker.seen((frame) => frame.type === "error" && frame.code === "BUSY").length,
			0,
			"Mind must not cause a BUSY reply",
		);
		assert.equal(
			mind.messages.filter(
				(entry) => entry.message?.customType === "mind-worker-result" && entry.message?.details?.status === "error",
			).length,
			0,
			"a late abort must not settle anything as an error",
		);

		// The newer task B is still the worker's current task and settles normally.
		worker.send({ type: "result", id: frameB.id, explanation: "B done" });
		const resultB = await withTimeout(pendingB, 5000, "B result");
		assert.equal(resultB.isError, undefined);
		assert.equal(resultB.content[0].text, "B done");

		// C dispatches only after B finishes, then completes.
		const frameC = await worker.waitFor((frame) => frame.type === "task" && frame.task.includes("task C"), {
			label: "task C",
		});
		assert.equal(frameC.id, taskCId);
		worker.send({ type: "result", id: frameC.id, explanation: "C done" });
		await waitUntil(
			() => asyncResults(mind, taskCId).some((entry) => entry.message.details.status === "completed"),
			{ timeout: 5000, label: "C completion" },
		);
	});
});

test("stop during a reset still delivers the shutdown frame and settles retained work", { timeout: 25000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const retained = mind.runTool("delegate", { task: "retained during stop", workerId: "worker-0", reset: true });
		await worker.waitFor(isResetFrame, { label: "reset control" });

		const stop = mind.commands.get("stop-mind").handler("", mind.ctx);
		const shutdown = await worker.waitFor((frame) => frame.type === "shutdown", {
			timeout: 3000,
			label: "shutdown frame",
		});
		assert.equal(shutdown.type, "shutdown");

		const result = await withTimeout(retained, 5000, "retained settlement");
		assert.equal(result.isError, true);
		assert.equal(result.details?.code, "STOP");
		await withTimeout(stop, 3000, "stop-mind");
	});
});

test("legacy mode rejects reset with RESET_UNSUPPORTED", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		// "legacy" is not a launcher role, so LAUNCHER_ROLE_FLAG stays null.
		const mind = await fixture.load("legacy");
		await mind.commands.get("be-mind").handler("", mind.ctx);

		const blocking = await withTimeout(
			mind.runTool("delegate", { task: "legacy reset", reset: true }),
			3000,
			"legacy delegate",
		);
		assert.equal(blocking.isError, true);
		assert.equal(blocking.details?.code, "RESET_UNSUPPORTED");

		const asyncAttempt = await withTimeout(
			mind.runTool("delegate_async", { task: "legacy async reset", reset: true }),
			3000,
			"legacy delegate_async",
		);
		assert.equal(asyncAttempt.isError, true);
		assert.equal(asyncAttempt.details?.code, "RESET_UNSUPPORTED");
	});
});

// ── Reset visibility regressions ────────────────────────────────────────────

test("a direct reset reports control status busy while waiting for the replacement", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);
		assert.equal(fixture.readControl()?.status, "worker-connected");

		const pending = mind.runTool("delegate", { task: "busy during reset", workerId: "worker-0", reset: true });
		const reset = await worker.waitFor(isResetFrame, { label: "reset control" });
		assert.equal(
			fixture.readControl()?.status,
			"busy",
			"control status must be busy while the worker waits for its replacement",
		);
		assert.equal(taskFrames(worker).length, 0, "no task may be dispatched on the old context");

		worker.close();
		const replacement = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: reset.resetId });
		const task = await replacement.waitFor((frame) => frame.type === "task", { label: "retained task" });
		replacement.send({ type: "result", id: task.id, explanation: "done" });
		const result = await withTimeout(pending, 5000, "retained result");
		assert.equal(result.isError, undefined);
	});
});

test("a blocking reset reports a reset:start progress update before dispatch", { timeout: 20000 }, async () => {
	await withFixture({ workerCount: 1 }, async (fixture) => {
		const mind = await fixture.startMind();
		const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await waitForWorkerCount(fixture);

		const updates = [];
		const pending = mind.runTool(
			"delegate",
			{ task: "update during reset", workerId: "worker-0", reset: true },
			{ onUpdate: (update) => updates.push(update) },
		);
		const reset = await worker.waitFor(isResetFrame, { label: "reset control" });

		assert.ok(updates.length >= 1, "onUpdate must receive a progress update before the replacement");
		const resetUpdate = updates.find((update) => /reset/i.test(update.content?.[0]?.text ?? ""));
		assert.ok(resetUpdate, "missing reset progress update: " + JSON.stringify(updates));
		assert.match(resetUpdate.content[0].text, /start/i);
		assert.equal(taskFrames(worker).length, 0, "no task may be dispatched on the old context");

		worker.close();
		const replacement = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", resetId: reset.resetId });
		const task = await replacement.waitFor((frame) => frame.type === "task", { label: "retained task" });
		replacement.send({ type: "result", id: task.id, explanation: "done" });
		const result = await withTimeout(pending, 5000, "retained result");
		assert.equal(result.isError, undefined);
	});
});
