// mind-stale-ctx-close.mind.test.mjs
//
// Regression for the resume crashes of 2026-11-03T06:15:52Z and 06:16:01Z:
// after a session replacement pi invalidates the old extension ctx, then a
// worker socket close from the replaced session lands. The close funnel read
// ctx.cwd before its stale-socket guard, so the delayed close escaped as an
// uncaughtException and pi exited.
//
// Real extension module, real Unix sockets, fake Pi with pi's stale-ctx behavior.
// Worker sockets are half-open: session_shutdown ends only the server side, and
// each close lands after the replacement, never during it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { withFixture, waitUntil, withTimeout } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

// pi ExtensionRunner.assertActive() text, abbreviated to the identifying part.
const STALE_CTX_ERROR = "This extension ctx is stale after session replacement or reload.";

function connectHalfOpen(fixture) {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path: fixture.socketPath, allowHalfOpen: true });
		socket.once("connect", () => {
			socket.on("error", () => { /* close is the event under test, not socket errors */ });
			resolve(socket);
		});
		socket.once("error", reject);
	});
}

async function connectHalfOpenWorker(fixture, workerId) {
	const socket = await connectHalfOpen(fixture);
	socket.setEncoding("utf8");
	socket.write(JSON.stringify({
		type: "handshake",
		role: "worker",
		workerId,
		tier: "flash",
		generation: fixture.generation,
	}) + "\n");
	await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) === 1, {
		timeout: 4000,
		label: workerId + " connected",
	});
	return socket;
}

/**
 * Destroy a client, then yield so the extension's server-side close callbacks
 * queued by the peer EOF (AF_UNIX) can settle before the assertions run.
 */
async function closeAndSettle(socket) {
	await new Promise((resolve) => {
		if (socket.destroyed) return resolve();
		socket.once("close", resolve);
		socket.destroy();
	});
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

/** Make a captured ctx read throw like pi's ExtensionRunner.assertActive(). */
function staleCtx(fixture, ctx) {
	let invalid = false;
	Object.defineProperty(ctx, "cwd", {
		configurable: true,
		get() {
			if (invalid) throw new Error(STALE_CTX_ERROR);
			return fixture.cwd;
		},
	});
	return {
		invalidate() { invalid = true; },
		restore() { Object.defineProperty(ctx, "cwd", { configurable: true, writable: true, value: fixture.cwd }); },
	};
}

/** Capture uncaught exceptions so the crash is asserted, never fatal; always restored. */
function captureEscapes() {
	assert.equal(process.hasUncaughtExceptionCaptureCallback(), false, "another uncaught capture is installed");
	const capture = { escaped: null, restore: () => process.setUncaughtExceptionCaptureCallback(null) };
	process.setUncaughtExceptionCaptureCallback((error) => { capture.escaped = error; });
	return capture;
}

test("a replaced session's close leaves a same-ID replacement worker untouched", { timeout: 30000 }, async () => {
	const capture = captureEscapes();
	try {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			const nextCtx = { ...mind.ctx };
			const notifications = [];
			nextCtx.ui = {
				...nextCtx.ui,
				notify(message, level) { notifications.push({ message, level }); },
			};
			const sockets = [];
			const stale = staleCtx(fixture, mind.ctx);
			try {
				sockets.push(await connectHalfOpenWorker(fixture, "worker-0"));

				await mind.sessionShutdown("new");
				stale.invalidate();
				await mind.call("session_start", { type: "session_start", reason: "new" }, nextCtx);
				await waitUntil(() => fixture.readControl()?.status === "ready", {
					timeout: 4000,
					label: "replacement mind ready",
				});

				const replacement = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
				await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) === 1, {
					timeout: 4000,
					label: "replacement worker-0 connected",
				});
				sockets.push(replacement.socket);

				await closeAndSettle(sockets[0]);
				assert.equal(capture.escaped, null, "a close from the replaced session must not read ctx.cwd");
				assert.equal(fixture.readControl()?.connectedWorkers, 1, "the same-ID replacement must stay pooled");

				const pending = mind.tools.get("delegate").execute(
					"test-call",
					{ task: "still owned", workerId: "worker-0" },
					undefined,
					undefined,
					nextCtx,
				);
				const task = await replacement.waitFor((frame) => frame.type === "task", { label: "replacement task" });
				assert.match(task.task, /still owned/);
				replacement.send({ type: "result", id: task.id, explanation: "replacement ok" });
				const result = await withTimeout(pending, 5000, "delegate result");
				assert.equal(result.isError, undefined);
				assert.equal(result.content[0].text, "replacement ok");

				await closeAndSettle(replacement.socket);
				await waitUntil(
					() => notifications.some((entry) => entry.message.includes("Worker worker-0 [flash] disconnected")),
					{ timeout: 4000, label: "live worker disconnect notification" },
				);
				assert.equal(capture.escaped, null, "a live worker close must still be handled without ctx errors");
			} finally {
				stale.restore();
				for (const socket of sockets) socket.destroy();
			}
		});
		assert.equal(capture.escaped, null, "no stale-ctx error escaped during cleanup");
	} finally {
		capture.restore();
	}
});

test("a connection that never handshook is ignored after replacement, not read from the stale ctx", { timeout: 20000 }, async () => {
	const capture = captureEscapes();
	try {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			const nextCtx = { ...mind.ctx };
			const sockets = [];
			const stale = staleCtx(fixture, mind.ctx);
			try {
				sockets.push(await connectHalfOpen(fixture));

				await mind.sessionShutdown("new");
				stale.invalidate();
				await mind.call("session_start", { type: "session_start", reason: "new" }, nextCtx);
				await waitUntil(() => fixture.readControl()?.status === "ready", {
					timeout: 4000,
					label: "replacement mind ready",
				});

				await closeAndSettle(sockets[0]);
				assert.equal(capture.escaped, null, "a close with no worker id must not read ctx.cwd");
			} finally {
				stale.restore();
				for (const socket of sockets) socket.destroy();
			}
		});
		assert.equal(capture.escaped, null, "no stale-ctx error escaped during cleanup");
	} finally {
		capture.restore();
	}
});
