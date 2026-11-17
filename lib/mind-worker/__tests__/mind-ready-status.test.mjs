// mind-ready-status.test.mjs — "ready" means Mind waits for input.
//
// A live run is busy; agent_end is not readiness because retries and follow-ups
// continue the run. The status is ready only once the run settles with nothing
// pending (pi's notify.ts settles on agent_settled for the same reason).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { withFixture, waitUntil } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

function assistant(text) {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function startRun(instance) {
	return instance.call("agent_start", { type: "agent_start" });
}

function endRun(instance, text) {
	return instance.call("agent_end", { type: "agent_end", messages: [assistant(text)] });
}

function beforeSettle(instance, outcome = "completed") {
	return instance.call("agent_before_settle", {
		type: "agent_before_settle",
		outcome,
		entries: [],
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
	});
}

function settle(instance, aborted = false) {
	return instance.call("agent_settled", { type: "agent_settled", aborted });
}

/** Run a registered /command through the fixture's own ctx, as prompt() would. */
async function runCommand(instance, text) {
	instance.pi.sendUserMessage(text, { expandPromptTemplates: true });
	await instance.settleCommands();
}

/** A restarted Mind listens on the same socket path; connectWorker needs it up. */
function waitForMindSocket(fixture) {
	return waitUntil(
		async () => {
			try {
				const socket = createConnection(fixture.socketPath);
				await new Promise((resolve, reject) => {
					socket.once("connect", resolve);
					socket.once("error", reject);
				});
				socket.destroy();
				return true;
			} catch {
				return false;
			}
		},
		{ timeout: 5000, label: "mind socket after /be-mind" },
	);
}

describe("mind ready status", { concurrency: 1 }, () => {
	it("busy during a run, ready only at settlement", { timeout: 20000 }, async () => {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			assert.equal(fixture.readControl()?.status, "ready", "an idle Mind is ready");

			await startRun(mind);
			assert.equal(fixture.readControl()?.status, "busy", "a live run is busy");

			await endRun(mind, "Interim: retrying");
			await beforeSettle(mind);
			assert.equal(fixture.readControl()?.status, "busy", "agent_end is not readiness");

			await settle(mind);
			assert.equal(fixture.readControl()?.status, "ready", "settlement is readiness");
		});
	});

	it("an aborted run stays busy until it settles", { timeout: 20000 }, async () => {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			await startRun(mind);
			await endRun(mind, "Interim: aborting");
			assert.equal(fixture.readControl()?.status, "busy");
			await settle(mind, true);
			assert.equal(fixture.readControl()?.status, "ready");
		});
	});

	it("a worker result mid-run keeps Mind busy", { timeout: 20000 }, async () => {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			const worker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
			await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) >= 1, { timeout: 4000, label: "worker connected" });

			await startRun(mind);
			await mind.runTool("delegate_async", { task: "mid-run work", tier: "flash" });
			const task = await worker.waitFor((frame) => frame.type === "task" && frame.task.includes("mid-run work"), { label: "task frame" });
			worker.send({ type: "result", id: task.id, explanation: "worker result" });
			await waitUntil(() => mind.messages.some((entry) => entry.message?.customType === "mind-worker-result"), { timeout: 5000, label: "worker result" });

			assert.equal(fixture.readControl()?.status, "busy", "the run is still live after the result");

			await settle(mind);
			assert.equal(fixture.readControl()?.status, "worker-connected", "settled with an idle worker");
		});
	});

	it("stopping the mind mid-run leaves no stale busy behind", { timeout: 20000 }, async () => {
		await withFixture({ workerCount: 1 }, async (fixture) => {
			const mind = await fixture.startMind();
			// A run that never settles: the flag is cleared by the role stop, not by agent_settled.
			await startRun(mind);
			assert.equal(fixture.readControl()?.status, "busy");

			await runCommand(mind, "/stop-mind");
			await runCommand(mind, "/be-mind");
			await waitForMindSocket(fixture);
			await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
			await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) >= 1, { timeout: 4000, label: "worker reconnected" });

			assert.equal(fixture.readControl()?.status, "worker-connected", "a restarted mind is not stuck busy");
		});
	});
});
