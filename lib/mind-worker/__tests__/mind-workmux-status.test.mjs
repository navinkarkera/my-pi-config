// mind-workmux-status.test.mjs — the workmux window status of a Mind.
//
// workmux-status.ts takes an activeCount from pi's shared event bus and shows "done"
// only when it is 0. Mind publishes that number from one place: the same settled gate
// that sends the idle notification — a completed run, an idle parent, and no worker
// result Mind still has to process. A worker result that has merely arrived is not
// processed work, so it must never read as done.
// Both real extension modules run against one fake Pi and one bus here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sleep, withFixture, waitUntil } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

const WORKMUX_URL = new URL("../../../extensions/workmux-status.ts", import.meta.url).href;

function assistant(text, stopReason = "stop") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

async function startRun(instance) {
	await instance.call("agent_start", { type: "agent_start" });
}

/** One low-level run: end, boundary outcome, settlement. */
async function settle(instance, { aborted = false, outcome = "completed", text = "done" } = {}) {
	await instance.call("agent_end", { type: "agent_end", messages: [assistant(text)] });
	await instance.call("agent_before_settle", {
		type: "agent_before_settle",
		outcome,
		entries: [],
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
	});
	await instance.call("agent_settled", { type: "agent_settled", aborted });
}

/** Load workmux-status into the same fake Pi and run only its session_start handler. */
async function loadWorkmuxStatus(mind) {
	const before = (mind.handlers.get("session_start") ?? []).length;
	(await import(WORKMUX_URL + "?workmux=" + Math.random().toString(36).slice(2))).default(mind.pi);
	for (const handler of (mind.handlers.get("session_start") ?? []).slice(before)) {
		await handler({ type: "session_start", reason: "startup" }, mind.ctx);
	}
	return windowStatuses(mind);
}

function windowStatuses(mind) {
	return mind.execCalls
		.filter((call) => call.command === "workmux" && call.args[0] === "set-window-status")
		.map((call) => call.args[1]);
}

function lastActivity(mind) {
	const reports = mind.events.emitted.filter((entry) => entry.channel === "suba:activity");
	return reports.length ? reports[reports.length - 1].data.activeCount : undefined;
}

function workerResultDelivered(mind) {
	return mind.messages.some((entry) => entry.message?.customType === "mind-worker-result");
}

/** A late subscriber (or a reload) asks again: workmux must not be told "0" now. */
async function replayActivityRequest(mind) {
	const seen = mind.events.emitted.length;
	mind.events.emit("suba:activity:request", {});
	await waitUntil(() => mind.events.emitted.length > seen, { timeout: 2000, label: "activity replay" });
	await sleep(20); // workmux serializes its window-status writes
}

async function connectWorker(fixture) {
	const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
	await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) >= 1, { timeout: 4000, label: "worker connected" });
	return worker;
}

describe("workmux status reflects real Mind idle", { concurrency: 1 }, () => {
	it("a worker result Mind has not processed is not done", { timeout: 20000 }, async () => {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			await loadWorkmuxStatus(mind);
			// session_start asked for the current count: an idle Mind answers 0.
			assert.equal(lastActivity(mind), 0, "Mind reports idle on the startup request");

			const worker = await connectWorker(fixture);
			await startRun(mind);
			const dispatched = await mind.runTool("delegate_async", { task: "live worker", tier: "flash" });
			assert.equal(dispatched.isError, undefined);
			const task = await worker.waitFor((frame) => frame.type === "task" && frame.task.includes("live worker"), { label: "task frame" });

			// The interim run ends while the worker is still live: not idle, not done.
			await settle(mind, { text: "Interim: waiting for the worker" });
			assert.equal(lastActivity(mind), 1, "a live worker is reported as activity");
			assert.equal(windowStatuses(mind).at(-1), "working");
			assert.equal(fixture.readControl()?.status, "busy");

			// The result reaches Mind, but Mind has not run on it yet: still working.
			const beforeResult = windowStatuses(mind).length;
			worker.send({ type: "result", id: task.id, explanation: "worker result" });
			await waitUntil(() => workerResultDelivered(mind), { timeout: 5000, label: "worker result message" });
			assert.equal(lastActivity(mind), 1, "a delivered result Mind has not processed is still activity");
			assert.equal(windowStatuses(mind).at(-1), "working", "no done flash between result and processing");
			assert.equal(windowStatuses(mind).length, beforeResult, "the result alone writes no window status");

			// A re-request in this gap replays the latch, not an inferred idle.
			await replayActivityRequest(mind);
			assert.equal(lastActivity(mind), 1, "the replay keeps working while the result is unprocessed");
			assert.equal(windowStatuses(mind).at(-1), "working", "the replay writes no done");
			assert.equal(windowStatuses(mind).length, beforeResult, "the replay writes no window status");

			// The run that consumes the result is the authoritative gate.
			await startRun(mind);
			await settle(mind, { text: "Final answer using the worker result" });
			await waitUntil(() => windowStatuses(mind).at(-1) === "done", { timeout: 5000, label: "done status" });
			assert.equal(lastActivity(mind), 0, "the processed result settles Mind to done");
			assert.equal(fixture.readControl()?.status, "worker-connected");
		});
	});

	it("an idle Mind with only connected workers reports done", { timeout: 20000 }, async () => {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			await loadWorkmuxStatus(mind);
			await connectWorker(fixture);

			await startRun(mind);
			await settle(mind, { text: "Final answer" });
			await waitUntil(() => windowStatuses(mind).at(-1) === "done", { timeout: 4000, label: "done status" });
			assert.equal(lastActivity(mind), 0);
			assert.equal(fixture.readControl()?.status, "worker-connected");
		});
	});

	it("aborted and errored settlements never report done", { timeout: 20000 }, async () => {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			await loadWorkmuxStatus(mind);
			await connectWorker(fixture);

			await startRun(mind);
			await settle(mind, { aborted: true, text: "Interim: aborting" });
			assert.equal(lastActivity(mind), 1, "an aborted run is not finished work");
			assert.equal(windowStatuses(mind).at(-1), "working");
			await replayActivityRequest(mind);
			assert.equal(lastActivity(mind), 1, "the replay does not infer idle after an aborted settle");

			await startRun(mind);
			await settle(mind, { outcome: "error", text: "Interim: erroring" });
			assert.equal(lastActivity(mind), 1, "an errored run is not finished work");
			assert.equal(windowStatuses(mind).at(-1), "working");

			await startRun(mind);
			await settle(mind, { text: "Final answer" });
			await waitUntil(() => windowStatuses(mind).at(-1) === "done", { timeout: 4000, label: "done status" });
			assert.equal(lastActivity(mind), 0);
		});
	});

	it("a queued follow-up message keeps Mind from done", { timeout: 20000 }, async () => {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			await loadWorkmuxStatus(mind);
			await connectWorker(fixture);

			// Mind still owes an answer to a message it has not consumed yet.
			fixture.pendingMessages = true;
			await startRun(mind);
			await settle(mind, { text: "Interim: follow-up queued" });
			assert.equal(lastActivity(mind), 1, "a queued follow-up is not finished work");
			assert.equal(windowStatuses(mind).at(-1), "working");
			await replayActivityRequest(mind);
			assert.equal(lastActivity(mind), 1, "the replay keeps the pending state");

			fixture.pendingMessages = false;
			await startRun(mind);
			await settle(mind, { text: "Final answer" });
			await waitUntil(() => windowStatuses(mind).at(-1) === "done", { timeout: 4000, label: "done status" });
			assert.equal(lastActivity(mind), 0);
		});
	});

	it("a non-mind session publishes no activity", { timeout: 20000 }, async () => {
		await withFixture({}, async (fixture) => {
			const none = await fixture.load("none");
			await none.sessionStart();
			none.events.emit("suba:activity:request", {});
			assert.deepEqual(
				none.events.emitted.filter((entry) => entry.channel === "suba:activity"),
				[],
				"a normal pi session never publishes activity",
			);
		});
	});
});
