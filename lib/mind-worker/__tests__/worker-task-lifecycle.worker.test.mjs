// worker-task-lifecycle.worker.test.mjs
//
// Worker-side half of plan 001: a task settles once, from `agent_settled`,
// classified by `agent_before_settle`; an abort (matching, stale or late) never
// frees the worker or cancels children it does not own; teardown never erases an
// unsettled record; context identity is never ownership.
//
// The Mind side is a fake Unix-socket server here. The real-Pi suite proves
// Pi's own event ordering; the fixture reproduces the documented contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFixture, waitUntil, sleep } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

function assistant(text, stopReason = "stop") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

function terminalFrames(conn) {
	return conn.seen((frame) => frame.type === "result" || frame.type === "error");
}

function taskFrames(conn, needle) {
	return conn.seen((frame) => frame.type === "task" && (!needle || frame.task.includes(needle)));
}

async function startWorker(fixture, loadOptions = {}) {
	const fakeMind = await fixture.startFakeMind();
	const worker = await fixture.load("worker", loadOptions);
	await worker.sessionStart();
	const conn = await fakeMind.next();
	await conn.waitFor((frame) => frame.type === "handshake", { label: "worker handshake" });
	return { fakeMind, worker, conn };
}

async function startTask(worker, conn, id, task = "lifecycle work") {
	conn.send({ type: "task", id, task });
	await waitUntil(() => worker.userMessages.some((entry) => entry.content.includes(task)), {
		timeout: 4000,
		label: "task prompt",
	});
}

test("a retry is not a completion: one agent_settled sends exactly one result", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-retry", "retry work");

		await worker.emitAgentRun([assistant("first attempt", "error")]);
		assert.equal(terminalFrames(conn).length, 0, "agent_end must not send a frame");

		await worker.emitAgentRun([assistant("final answer", "stop")]);
		assert.equal(terminalFrames(conn).length, 0, "a second agent_end must not send either");

		await worker.emitBeforeSettle({ outcome: "completed", messages: [assistant("final answer", "stop")] });
		await worker.emitSettled({ aborted: false });

		const settled = await conn.waitFor((frame) => frame.type === "result" || frame.type === "error", { label: "settlement" });
		await sleep(80);
		const results = conn.seen((frame) => frame.type === "result");
		assert.equal(settled.type, "result");
		assert.equal(results.length, 1, "exactly one settlement");
		assert.equal(results[0].id, "t-retry");
		assert.match(results[0].explanation, /final answer/);
		assert.equal(conn.seen((frame) => frame.type === "error").length, 0);
	});
});

test("exhausted retries settle as one AGENT_ERROR, never as a result", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-exhausted");

		await worker.emitBeforeSettle({ outcome: "error", messages: [assistant("gave up", "error")] });
		await worker.emitSettled({ aborted: false });

		const settled = await conn.waitFor((frame) => frame.type === "result" || frame.type === "error", { label: "settlement" });
		await sleep(80);
		const errors = conn.seen((frame) => frame.type === "error");
		assert.equal(settled.type, "error");
		assert.equal(errors.length, 1);
		assert.equal(errors[0].id, "t-exhausted");
		assert.equal(errors[0].code, "AGENT_ERROR");
		assert.equal(conn.seen((frame) => frame.type === "result").length, 0);
	});
});

test("an explicit error outcome without assistant text is still AGENT_ERROR", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-empty-error");

		await worker.emitBeforeSettle({ outcome: "error", messages: [] });
		await worker.emitSettled({ aborted: false });

		await conn.waitFor((frame) => frame.type === "result" || frame.type === "error", { label: "settlement" });
		await sleep(80);
		const errors = conn.seen((frame) => frame.type === "error");
		assert.equal(errors.length, 1, "the outcome is authoritative, not the transcript scan");
		assert.equal(errors[0].code, "AGENT_ERROR");
		assert.equal(conn.seen((frame) => frame.type === "result").length, 0);
	});
});

test("duplicate concurrent agent_settled sends exactly one frame", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		const gate = fixture.installGatedGit();
		const { worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-once");
		await worker.emitBeforeSettle({ outcome: "completed", messages: [assistant("settled once")] });

		const first = worker.emitSettled({ aborted: false });
		await gate.started();
		await worker.emitSettled({ aborted: false });
		gate.release();
		await first;
		await conn.waitFor((frame) => frame.type === "result" || frame.type === "error", { label: "settlement" });
		await sleep(80);

		const frames = terminalFrames(conn);
		assert.equal(frames.length, 1, "a duplicate settlement must not send twice");
		assert.equal(frames[0].type, "result");
	});
});

test("without agent_before_settle the transcript stopReason classifies the settlement", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture);

		await startTask(worker, conn, "t-fallback-error", "fallback error");
		await worker.emitAgentRun([assistant("failed", "error")]);
		await worker.emitSettled({ aborted: false });
		const errorFrame = await conn.waitFor((frame) => frame.type === "result" || frame.type === "error", { label: "fallback error" });
		assert.equal(errorFrame.type, "error");
		assert.equal(errorFrame.code, "AGENT_ERROR");

		await startTask(worker, conn, "t-fallback-aborted", "fallback abort");
		await worker.emitAgentRun([assistant("cancelled", "aborted")]);
		await worker.emitSettled({ aborted: false });
		const abortFrame = await conn.waitFor((frame) => frame.type === "result" || frame.type === "error", { label: "fallback abort" });
		assert.equal(abortFrame.type, "error");
		assert.equal(abortFrame.code, "ABORTED");

		await startTask(worker, conn, "t-fallback-result", "fallback result");
		await worker.emitAgentRun([assistant("fine", "stop")]);
		await worker.emitSettled({ aborted: false });
		const resultFrame = await conn.waitFor((frame) => frame.type === "result" || frame.type === "error", { label: "fallback result" });
		assert.equal(resultFrame.type, "result");
		assert.equal(resultFrame.id, "t-fallback-result");
	});
});

test("an abort matching the current task aborts once and sends one ABORTED frame", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-abort");

		conn.send({ type: "abort", id: "t-abort" });
		await waitUntil(() => worker.abortCalls === 1, { timeout: 3000, label: "ctx.abort" });
		assert.equal(terminalFrames(conn).length, 0, "the frame belongs to the settlement, not the abort");

		await worker.emitSettled({ aborted: true });
		await conn.waitFor((frame) => frame.type === "error", { label: "ABORTED frame" });
		const errors = conn.seen((frame) => frame.type === "error");
		assert.equal(errors.length, 1);
		assert.equal(errors[0].id, "t-abort");
		assert.equal(errors[0].code, "ABORTED");
	});
});

test("an abort while extraction awaits turns the pending success into ABORTED", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		const gate = fixture.installGatedGit();
		const { worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-late-abort");
		await worker.emitBeforeSettle({ outcome: "completed", messages: [assistant("too late")] });

		const settling = worker.emitSettled({ aborted: false });
		await gate.started();
		conn.send({ type: "abort", id: "t-late-abort" });
		await sleep(80);
		gate.release();
		await settling;
		await conn.waitFor((frame) => frame.type === "result" || frame.type === "error", { label: "settlement" });
		await sleep(80);

		assert.equal(conn.seen((frame) => frame.type === "result").length, 0, "never a result");
		const errors = conn.seen((frame) => frame.type === "error");
		assert.equal(errors.length, 1);
		assert.equal(errors[0].code, "ABORTED");
	});
});

test("admission during settlement is refused BUSY and B is accepted after cleanup", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		const gate = fixture.installGatedGit();
		const { worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-a", "task A");
		await worker.emitBeforeSettle({ outcome: "completed", messages: [assistant("A done")] });

		const settling = worker.emitSettled({ aborted: false });
		await gate.started();
		conn.send({ type: "task", id: "t-b", task: "task B" });
		const busy = await conn.waitFor((frame) => frame.type === "error" && frame.code === "BUSY", { label: "BUSY" });
		assert.equal(busy.id, "t-b");

		gate.release();
		await settling;
		await conn.waitFor((frame) => frame.type === "result" && frame.id === "t-a", { label: "A settlement" });
		await sleep(80);
		assert.equal(conn.seen((frame) => (frame.type === "result" || frame.type === "error") && frame.id === "t-a").length, 1, "only A settles here");
		assert.equal(conn.seen((frame) => frame.type === "result" && frame.id === "t-b").length, 0, "B was never adopted");

		await startTask(worker, conn, "t-b", "task B");
		await worker.emitBeforeSettle({ outcome: "completed", messages: [assistant("B done")] });
		await worker.emitSettled({ aborted: false });
		await conn.waitFor((frame) => frame.type === "result" && frame.id === "t-b", { label: "B settlement" });
		const bFrames = conn.seen((frame) => frame.type === "result" && frame.id === "t-b");
		assert.equal(bFrames.length, 1, "B is accepted after A's terminal cleanup");
	});
});

test("a stale abort cannot cancel children or touch an already-settled task", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture, { tier: "strong" });
		await startTask(worker, conn, "t-parent", "parent work");

		const delegated = worker.runTool("delegate", { task: "child work" });
		const request = await conn.waitFor((frame) => frame.type === "subdelegate-request", {
			label: "subdelegate request",
		});

		conn.send({ type: "abort", id: "someone-else" });
		await sleep(100);
		assert.equal(worker.abortCalls, 0, "a stale abort must not abort Pi");
		assert.equal(conn.seen((frame) => frame.type === "abort").length, 0, "no child cancellation");

		conn.send({ type: "subdelegate-response", id: request.id, explanation: "child done" });
		const child = await delegated;
		assert.equal(child.isError, undefined, "the in-flight subdelegate still finishes");

		await worker.emitBeforeSettle({ outcome: "completed", messages: [assistant("parent done")] });
		await worker.emitSettled({ aborted: false });
		await conn.waitFor((frame) => frame.type === "result" && frame.id === "t-parent", { label: "parent settlement" });
		assert.equal(conn.seen((frame) => frame.type === "result" && frame.id === "t-parent").length, 1);

		conn.send({ type: "abort", id: "t-parent" });
		await sleep(100);
		assert.equal(worker.abortCalls, 0, "a repeat abort for a settled task is inert");
	});
});

test("a reconnect timer from the old activation opens no socket after teardown", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { fakeMind, worker, conn } = await startWorker(fixture);
		conn.close();
		await conn.waitForClose({ timeout: 3000 });
		// The close handler scheduled a reconnect for the old run.
		await worker.sessionShutdown();
		await worker.sessionStart();
		const fresh = await fakeMind.next({ timeout: 5000 });
		await fresh.waitFor((frame) => frame.type === "handshake", { label: "fresh handshake" });

		await sleep(800);
		assert.equal(fakeMind.connections.length, 2, "the old timer must open no socket");
		assert.equal(fakeMind.connections.filter((client) => !client.closed).length, 1);

		await startTask(worker, fresh, "t-fresh", "fresh work");
		await worker.emitBeforeSettle({ outcome: "completed", messages: [assistant("fresh done")] });
		await worker.emitSettled({ aborted: false });
		await fresh.waitFor((frame) => frame.type === "result" && frame.id === "t-fresh", { label: "fresh settlement" });
		assert.equal(fresh.seen((frame) => frame.type === "result" && frame.id === "t-fresh").length, 1);
	});
});

test("reactivation mid-task opens no transport and admits nothing until the record settles", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { fakeMind, worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-held");

		await worker.commands.get("stop-worker").handler("", worker.ctx);
		await sleep(100);
		assert.equal(terminalFrames(conn).length, 0, "teardown sends no terminal frame");

		// A repeated /be-worker over an unsettled record is refused locally, before any transport.
		await worker.commands.get("be-worker").handler("", worker.ctx);
		await sleep(300);
		assert.equal(fakeMind.connections.length, 1, "no fresh idle transport over an unsettled record");
		assert.equal(worker.userMessages.some((entry) => entry.content.includes("new work")), false, "nothing was adopted");

		// Its own settlement retires it: no frame, no reconnect, no new connection.
		await worker.emitSettled({ aborted: false });
		await sleep(400);
		assert.equal(terminalFrames(conn).length, 0, "a retired record sends nothing");
		assert.equal(fakeMind.connections.length, 1, "a retired record reconnects nothing");

		// Only an explicit reactivation after the settlement connects and admits work.
		await worker.commands.get("be-worker").handler("", worker.ctx);
		const fresh = await fakeMind.next({ timeout: 5000 });
		await fresh.waitFor((frame) => frame.type === "handshake", { label: "post-settlement handshake" });
		await startTask(worker, fresh, "t-new", "new work");
		await worker.emitBeforeSettle({ outcome: "completed", messages: [assistant("new done")] });
		await worker.emitSettled({ aborted: false });
		await fresh.waitFor((frame) => frame.type === "result" && frame.id === "t-new", { label: "new settlement" });
		assert.equal(fresh.seen((frame) => frame.type === "result" && frame.id === "t-new").length, 1);
	});
});

test("session_shutdown mid-task blocks the next session_start until its own settlement", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { fakeMind, worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-shutdown");

		await worker.sessionShutdown();
		await sleep(100);
		assert.equal(terminalFrames(conn).length, 0, "shutdown is not a settlement");

		// session_start over the unsettled record is refused locally: no transport, no admission.
		await worker.sessionStart();
		await sleep(300);
		assert.equal(fakeMind.connections.length, 1, "session_start must not handshake over the unsettled record");
		assert.equal(worker.userMessages.some((entry) => entry.content.includes("after shutdown")), false, "nothing was adopted");

		// A late settlement of the retired record: identity-only cleanup, no frame, no reconnect.
		await worker.emitSettled({ aborted: false });
		await sleep(400);
		assert.equal(terminalFrames(conn).length, 0, "a retired record sends nothing");
		assert.equal(fakeMind.connections.length, 1, "a retired record reconnects nothing");

		// An explicit session_start after the settlement connects and admits work.
		await worker.sessionStart();
		const fresh = await fakeMind.next({ timeout: 5000 });
		await fresh.waitFor((frame) => frame.type === "handshake", { label: "post-settlement handshake" });
		await startTask(worker, fresh, "t-after", "after shutdown");
		await worker.emitBeforeSettle({ outcome: "completed", messages: [assistant("after done")] });
		await worker.emitSettled({ aborted: false });
		await fresh.waitFor((frame) => frame.type === "result" && frame.id === "t-after", { label: "after settlement" });
		assert.equal(fresh.seen((frame) => frame.type === "result" && frame.id === "t-after").length, 1);
	});
});

test("three distinct event contexts settle the same task exactly once", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture);
		await startTask(worker, conn, "t-ctx", "context work");

		const first = { ...worker.ctx };
		const second = { ...worker.ctx };
		const third = { ...worker.ctx };
		assert.notEqual(first, second);
		assert.notEqual(second, third);

		await worker.call("agent_end", { type: "agent_end", messages: [assistant("context answer")] }, first);
		await worker.call(
			"agent_before_settle",
			{
				type: "agent_before_settle",
				outcome: "completed",
				entries: [],
				continue: false,
				context: { contextEntries: [], contextMessages: [assistant("context answer")], llmMessages: [], pendingMessages: [], canContinue: false },
			},
			second,
		);
		await worker.call("agent_settled", { type: "agent_settled", aborted: false }, third);
		await conn.waitFor((frame) => frame.type === "result", { label: "context settlement" });

		const results = conn.seen((frame) => frame.type === "result");
		assert.equal(results.length, 1, "context identity is never ownership");
		assert.equal(results[0].id, "t-ctx");
	});
});
