// worker-session-reset.real.test.mjs
//
// End-to-end proof with the real Pi CLI in RPC mode. The fake Mind is a plain
// Unix-socket server; everything on the Pi side (sendUserMessage command
// dispatch, ctx.newSession(), session_shutdown/session_start, reconnect and
// handshake) is genuine.
//
// Skips only when the installed Pi CLI cannot be found. A Pi process that
// starts but fails the protocol is a test failure, not a skip.
//
// Coverage intentionally omitted: the retained task's transcript contents need
// a model turn (auth + network). The suite proves session replacement and an
// empty replacement session instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withFixture } from "./support/fixture.mjs";
import { realPiAvailability, EXTENSION_URL } from "./support/pi-resolver.mjs";

const availability = realPiAvailability();
const skipReason = availability.available ? false : availability.reason;

function createRpcClient(child) {
	let buffer = "";
	const pending = new Map();
	let seq = 0;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record.type === "response" && record.id && pending.has(record.id)) {
				const entry = pending.get(record.id);
				pending.delete(record.id);
				clearTimeout(entry.timer);
				if (record.success) entry.resolve(record.data);
				else entry.reject(new Error("RPC " + record.command + " failed: " + record.error));
			}
		}
	});
	const request = (type, params = {}, timeout = 10000) =>
		new Promise((resolve, reject) => {
			const id = "req-" + ++seq;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("RPC " + type + " timed out after " + timeout + "ms"));
			}, timeout);
			pending.set(id, { resolve, reject, timer });
			child.stdin.write(JSON.stringify({ id, type, ...params }) + "\n");
		});
	return { request };
}

test("real Pi: a worker reset replaces the session before the next handshake", { skip: skipReason, timeout: 60000 }, async () => {
	assert.equal(availability.available, true);

	await withFixture({ workerCount: 1, generation: 7 }, async (fixture) => {
		const fakeMind = await fixture.startFakeMind();
		const sessionDir = join(fixture.root, "sessions");
		const childEnv = { ...process.env };
		for (const key of Object.keys(childEnv)) {
			if (key.startsWith("PI_MIND_WORKER_")) delete childEnv[key];
		}
		Object.assign(childEnv, {
			HOME: fixture.homeDir,
			PI_CODING_AGENT_DIR: fixture.agentDir,
			PI_MIND_WORKER_ROLE: "worker",
			PI_MIND_WORKER_ID: "worker-0",
			PI_MIND_WORKER_TIER: "flash",
			PI_MIND_WORKER_GENERATION: String(fixture.generation),
		});

		const child = spawn(
			process.execPath,
			[
				availability.cliPath,
				"--mode", "rpc",
				"--extension", fileURLToPath(EXTENSION_URL),
				"--session-dir", sessionDir,
			],
			{ cwd: fixture.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stderr.length > 8000) stderr = stderr.slice(-8000);
		});
		const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

		try {
			const rpc = createRpcClient(child);
			const workerSocket = await fakeMind.next({ timeout: 30000 });
			const handshake = await workerSocket.waitFor((frame) => frame.type === "handshake", {
				timeout: 10000,
				label: "worker handshake",
			});
			assert.equal(handshake.workerId, "worker-0");
			assert.equal(handshake.generation, 7);

			const before = await rpc.request("get_state");
			assert.ok(before.sessionId, "worker must report a session id");
			const beforeMessages = await rpc.request("get_messages");
			assert.equal(beforeMessages.messages.length, 0);

			workerSocket.send({ type: "reset", resetId: "real-1" });
			// The worker answers with a replacement, not a status frame: session
			// replacement tears the old socket down (session_shutdown -> disconnect).
			await workerSocket.waitForClose({ timeout: 15000 });

			const replacement = await fakeMind.next({ timeout: 30000 });
			const replacementHandshake = await replacement.waitFor((frame) => frame.type === "handshake", {
				timeout: 10000,
				label: "replacement handshake",
			});
			assert.equal(replacementHandshake.resetId, "real-1", "the replacement handshake must carry the reset id");

			const after = await rpc.request("get_state");
			assert.notEqual(after.sessionId, before.sessionId, "the reset must install a new session");
			const afterMessages = await rpc.request("get_messages");
			assert.equal(afterMessages.messages.length, 0, "the replacement session must start empty");

			const health = await rpc.request("get_state");
			assert.equal(health.isStreaming, false);
		} catch (error) {
			const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: "still-running" }), 50))]);
			throw new Error(error.message + "\nPi stderr:\n" + stderr + "\nPi exit: " + JSON.stringify(exit));
		} finally {
			child.kill("SIGTERM");
			const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: "timeout" }), 3000))]);
			if (exit.code === "timeout") child.kill("SIGKILL");
		}
	});
});
