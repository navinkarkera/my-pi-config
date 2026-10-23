// worker-session-reset.worker.test.mjs
//
// Worker-side half of the reset protocol (plan §9): the reset control, the
// in-flight guard, nonce inertness, the private command dispatch, flag lifetime
// across a replacement, and the subdelegate rejection.
//
// The Mind side is a fake Unix-socket server here. The replacement itself is
// simulated by the fixture's fake Pi (see support/fixture.mjs for the source
// citations); the real-Pi suite proves Pi's own replacement behavior.
//
// Coverage intentionally omitted: "flags retained when the replacement
// connection fails before the handshake write" is not observable through a real
// local socket (the write succeeds even after the peer closes).

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFixture, waitUntil, withTimeout } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

async function startWorker(fixture, loadOptions = {}) {
	const fakeMind = await fixture.startFakeMind();
	const worker = await fixture.load("worker", loadOptions);
	await worker.sessionStart();
	const conn = await fakeMind.next();
	const handshake = await conn.waitFor((frame) => frame.type === "handshake", { label: "worker handshake" });
	return { fakeMind, worker, conn, handshake };
}

function waitForUserMessage(worker, predicate = () => true) {
	// Task prompts are sent synchronously by the socket handler; reset dispatch
	// happens on a microtask. Wait instead of assuming either has run.
	return waitUntil(() => worker.userMessages.some(predicate), {
		timeout: 4000,
		label: "user message",
	});
}

function dispatchCall(worker) {
	return worker.userMessages.find((entry) => entry.options?.expandPromptTemplates === true) ?? null;
}

test("the harness isolates HOME and PI_CODING_AGENT_DIR", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { getAgentDir, getPackageDir } = await import("@earendil-works/pi-coding-agent");
		assert.equal(getAgentDir(), fixture.agentDir);
		assert.ok(fixture.socketPath.startsWith(fixture.root), "socket path must live in the temp root");
		assert.ok(getPackageDir().length > 0);
		assert.equal(process.env.HOME, fixture.homeDir);
	});
});

test("reset control dispatches the private command and the replacement handshake carries resetId", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { fakeMind, worker, conn } = await startWorker(fixture);
		conn.send({ type: "reset", resetId: "r-1" });

		await waitUntil(() => dispatchCall(worker), { timeout: 3000, label: "reset command dispatch" });
		const call = dispatchCall(worker);
		assert.ok(call, "reset must be dispatched through pi.sendUserMessage with expandPromptTemplates");
		assert.equal(typeof call.content, "string");
		assert.ok(call.content.startsWith("/"), "reset must invoke a registered command, not a prompt");
		const commandName = call.content.slice(1).split(" ")[0];
		assert.ok(worker.commands.has(commandName), "dispatched command must be registered: " + commandName);
		assert.ok(call.content.slice(1 + commandName.length).trim().length > 0, "command must carry a nonce");

		await worker.settleCommands();
		assert.equal(worker.newSessionCount, 1, "the command handler must call ctx.newSession()");

		const replacement = await fakeMind.next({ timeout: 5000 });
		const handshake = await replacement.waitFor((frame) => frame.type === "handshake", {
			label: "replacement handshake",
		});
		assert.equal(handshake.resetId, "r-1", "the replacement handshake must carry the reset id");
		assert.equal(handshake.workerId, "worker-0");
		assert.equal(handshake.tier, "flash");
		await conn.waitForClose({ timeout: 3000 });

		// Flags must clear after the handshake write: a second reset is accepted
		// on the replacement connection instead of RESET_IN_PROGRESS.
		replacement.send({ type: "reset", resetId: "r-2" });
		await waitUntil(
			() => worker.userMessages.filter((entry) => entry.options?.expandPromptTemplates === true).length === 2,
			{ timeout: 3000, label: "second reset command dispatch" },
		);
		await worker.settleCommands();
		const third = await fakeMind.next({ timeout: 5000 });
		const thirdHandshake = await third.waitFor((frame) => frame.type === "handshake", {
			label: "third handshake",
		});
		assert.equal(thirdHandshake.resetId, "r-2");
		assert.equal(worker.newSessionCount, 2);
	});
});

test("a manual command invocation with a stale or bogus nonce is inert", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { fakeMind, worker, conn } = await startWorker(fixture);
		conn.send({ type: "reset", resetId: "r-manual" });
		await waitUntil(() => dispatchCall(worker), { timeout: 3000, label: "reset command dispatch" });
		const call = dispatchCall(worker);
		await worker.settleCommands();
		await fakeMind.next({ timeout: 5000 });

		const commandName = call.content.slice(1).split(" ")[0];
		const command = worker.commands.get(commandName);
		assert.ok(command, "command must be registered");

		// Same args again, and a bogus nonce: neither may replace the session.
		await withTimeout(command.handler(call.content.slice(1 + commandName.length).trim(), worker.ctx), 2000, "stale reset");
		await withTimeout(command.handler("bogus-nonce", worker.ctx), 2000, "bogus reset");
		assert.equal(worker.newSessionCount, 1, "manual invocations must not start another session");
	});
});

test("a second reset while the command is in flight is rejected with RESET_IN_PROGRESS", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { fakeMind, worker, conn } = await startWorker(fixture);
		let release;
		worker.newSessionGate = new Promise((resolve) => {
			release = resolve;
		});
		conn.send({ type: "reset", resetId: "r-guard-1" });
		conn.send({ type: "reset", resetId: "r-guard-2" });

		const busy = await conn.waitFor((frame) => frame.type === "error" && frame.code === "RESET_IN_PROGRESS", {
			label: "RESET_IN_PROGRESS",
		});
		assert.equal(busy.resetId, "r-guard-2");

		release();
		worker.newSessionGate = null;
		await worker.settleCommands();
		const replacement = await fakeMind.next({ timeout: 5000 });
		const handshake = await replacement.waitFor((frame) => frame.type === "handshake", {
			label: "replacement handshake",
		});
		assert.equal(handshake.resetId, "r-guard-1", "the first reset must still win");
		assert.equal(worker.newSessionCount, 1);
	});
});

test("a busy worker rejects the reset with RESET_BUSY and keeps the task", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture);
		conn.send({ type: "task", id: "t-busy", task: "long running work" });
		await waitForUserMessage(worker, (entry) => entry.content.includes("long running work"));
		assert.equal(worker.userMessages.length, 1, "the task prompt must be sent first");

		conn.send({ type: "reset", resetId: "r-busy" });
		const error = await conn.waitFor((frame) => frame.type === "error" && frame.code === "RESET_BUSY", {
			label: "RESET_BUSY",
		});
		assert.equal(error.resetId, "r-busy");
		assert.equal(worker.userMessages.length, 1, "a rejected reset must not dispatch the command");
		assert.equal(worker.newSessionCount, 0);
	});
});

test("a cancelled session replacement reports RESET_CANCELLED and clears the flags", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { fakeMind, worker, conn } = await startWorker(fixture);
		worker.cancelNextNewSession = true;
		conn.send({ type: "reset", resetId: "r-cancel" });
		const error = await conn.waitFor((frame) => frame.type === "error" && frame.code === "RESET_CANCELLED", {
			label: "RESET_CANCELLED",
		});
		assert.equal(error.resetId, "r-cancel");
		assert.equal(worker.newSessionCount, 1);

		// Flags must be clear: a later reset is accepted, not refused as in-flight.
		conn.send({ type: "reset", resetId: "r-after-cancel" });
		await worker.settleCommands();
		const replacement = await fakeMind.next({ timeout: 5000 });
		const handshake = await replacement.waitFor((frame) => frame.type === "handshake", {
			label: "replacement handshake",
		});
		assert.equal(handshake.resetId, "r-after-cancel");
		assert.equal(worker.newSessionCount, 2);
	});
});

test("a normal task message never carries reset and starts no replacement", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture);
		conn.send({ type: "task", id: "t-1", task: "plain task" });
		const taskMessage = await waitForUserMessage(worker, (entry) => entry.content.includes("plain task"));
		assert.ok(taskMessage);
		assert.equal(worker.newSessionCount, 0);
		assert.equal(worker.userMessages.length, 1);
		assert.match(worker.userMessages[0].content, /plain task/);
	});
});

test("a subdelegate carrying reset is rejected with SUBDELEGATE_NO_RESET", { timeout: 15000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker, conn } = await startWorker(fixture, { tier: "strong" });
		const result = await withTimeout(
			worker.runTool("delegate", { task: "flash work", reset: true }),
			3000,
			"subdelegate rejection",
		);
		assert.equal(result.isError, true);
		assert.equal(result.details?.code, "SUBDELEGATE_NO_RESET");
		assert.equal(conn.seen((frame) => frame.type === "subdelegate-request").length, 0);
	});
});

// ── Final-review regressions ────────────────────────────────────────────────

test("the private reset command with ctx.isIdle() false clears its flags and reports an error", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { fakeMind, worker, conn } = await startWorker(fixture);
		const dispatchCount = () =>
			worker.userMessages.filter((entry) => entry.options?.expandPromptTemplates === true).length;

		// The control is accepted (workerBusy is false) but the agent is not idle
		// when the command runs. It must report instead of silently doing nothing.
		fixture.idle = false;
		conn.send({ type: "reset", resetId: "r-not-idle" });
		const error = await conn.waitFor(
			(frame) => frame.type === "error" && frame.resetId === "r-not-idle",
			{ label: "reset error" },
		);
		assert.ok(
			["RESET_BUSY", "RESET_CANCELLED"].includes(error.code),
			"unexpected code for a non-idle reset: " + error.code,
		);
		assert.equal(worker.newSessionCount, 0, "a non-idle worker must not replace its session");

		// Flags cleared: the next reset is accepted instead of RESET_IN_PROGRESS.
		fixture.idle = true;
		conn.send({ type: "reset", resetId: "r-idle-after" });
		await waitUntil(() => dispatchCount() === 2, { timeout: 3000, label: "second reset dispatch" });
		await worker.settleCommands();
		const replacement = await fakeMind.next({ timeout: 5000 });
		const handshake = await replacement.waitFor((frame) => frame.type === "handshake", {
			label: "replacement handshake",
		});
		assert.equal(handshake.resetId, "r-idle-after");
		assert.equal(worker.newSessionCount, 1);
	});
});
