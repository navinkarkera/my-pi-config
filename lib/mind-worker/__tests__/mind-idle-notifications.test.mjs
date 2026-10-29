// mind-idle-notifications.test.mjs — Mind idle notification settlement tests.
//
// One alert per settled Mind run, never from a transient agent_end, never with pending
// work/messages or a non-completed outcome. notify-send, curl and canberra-gtk-play are
// /bin/sh stubs reached through a fixture-only PATH; no real notifier, topic, audio or
// network is touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFixture, waitUntil, withTimeout } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

const NOTIFY_CONFIG = { notifyOnMindIdle: true, ntfyTopic: "not-a-real-topic", ntfyServer: "http://127.0.0.1:9" };
const RESPONSES_PATH = (fixture) => join(fixture.stateDir, fixture.hash + "-responses.jsonl");

// Stubs MUST exist before startMind: PATH is fixture.root/bin only, so a missing or
// non-executable stub fails the test instead of falling through to a real notifier.
// Each stub is #!/bin/sh with shell builtins only: printf appends the attempt, exit.
function stubNotifiers(fixture) {
	const bin = join(fixture.root, "bin");
	mkdirSync(bin, { recursive: true });
	for (const name of ["notify-send", "curl", "canberra-gtk-play"]) {
		const file = join(bin, name);
		// One count line per invocation: the body itself may contain newlines.
		writeFileSync(file, `#!/bin/sh\nprintf 'attempt\\n' >> "${file}.count"\nprintf '%s\\n' "$*" >> "${file}.attempts"\nexit 0\n`);
		chmodSync(file, 0o755);
		assert.ok(existsSync(file) && (statSync(file).mode & 0o111), name + " stub must be executable");
	}
	const saved = { PATH: process.env.PATH, ID: process.env.PI_MIND_WORKER_ID, TIER: process.env.PI_MIND_WORKER_TIER, GEN: process.env.PI_MIND_WORKER_GENERATION };
	const MIND = [["PI_MIND_WORKER_ID", saved.ID], ["PI_MIND_WORKER_TIER", saved.TIER], ["PI_MIND_WORKER_GENERATION", saved.GEN]];
	process.env.PATH = bin; // fixture bin only — no real PATH fallback
	const count = (name) => { try { return readFileSync(join(bin, name + ".count"), "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
	const text = (name) => { try { return readFileSync(join(bin, name + ".attempts"), "utf8"); } catch { return ""; } };
	return {
		notifyCount: () => count("notify-send"),
		notifyText: () => text("notify-send"),
		pushCount: () => count("curl"),
		soundCount: () => count("canberra-gtk-play"),
		soundArgs: () => text("canberra-gtk-play"),
		restore: () => { process.env.PATH = saved.PATH; for (const [k, v] of MIND) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
	};
}

async function notifyCase(options, fn) {
	await withFixture(
		{ workerCount: 1, ...options, configOverrides: { ...NOTIFY_CONFIG, ...(options?.configOverrides ?? {}) } },
		async (fixture) => {
			const notifier = stubNotifiers(fixture);
			try {
				const mind = await fixture.startMind();
				await fn({ fixture, mind, notifier });
			} finally {
				notifier.restore();
			}
		},
	);
}

function assistant(text, stopReason = "stop") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

function endRun(instance, text, stopReason = "stop") {
	return instance.call("agent_end", { type: "agent_end", messages: [assistant(text, stopReason)] });
}

function beforeSettle(instance, outcome = "completed", messages = []) {
	return instance.call("agent_before_settle", {
		type: "agent_before_settle",
		outcome,
		entries: [],
		continue: false,
		context: { contextEntries: [], contextMessages: messages, llmMessages: [], pendingMessages: [], canContinue: false },
	});
}

function settle(instance, aborted = false) {
	return instance.call("agent_settled", { type: "agent_settled", aborted });
}

function assertNoAlerts(notifier) {
	assert.equal(notifier.notifyCount(), 0, "no notify-send attempt");
	assert.equal(notifier.pushCount(), 0, "no curl attempt");
	assert.equal(notifier.soundCount(), 0, "no canberra-gtk-play attempt");
}

async function connectWorker(fixture, options = {}) {
	const client = await fixture.connectWorker({ workerId: "worker-0", tier: "flash", ...options });
	await waitUntil(() => (fixture.readControl()?.connectedWorkers ?? 0) >= 1, { timeout: 4000, label: "worker connected" });
	return client;
}

function responseLines(fixture) {
	return readFileSync(RESPONSES_PATH(fixture), "utf8").trim().split("\n").filter(Boolean);
}

describe("mind idle notifications", { concurrency: 1 }, () => {
	it("completed: one alert only at settlement", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			await endRun(mind, "Final answer");
			assertNoAlerts(notifier);
			await beforeSettle(mind);
			assertNoAlerts(notifier);
			await settle(mind, false);
			assert.equal(notifier.notifyCount(), 1);
			assert.equal(notifier.pushCount(), 1);
			assert.equal(notifier.soundCount(), 1, "one completion sound");
			assert.match(notifier.soundArgs(), /--id=complete/);
			assert.match(notifier.notifyText(), /Final answer/);
			assert.equal(fixture.readControl()?.status, "ready");
		});
	});

	it("transient retry: only the final settled summary alerts", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			await endRun(mind, "Interim: retrying");
			assertNoAlerts(notifier);
			await endRun(mind, "Final answer after retry");
			await beforeSettle(mind);
			await settle(mind, false);
			assert.equal(notifier.notifyCount(), 1);
			assert.equal(notifier.soundCount(), 1, "one sound for the final settled run only");
			assert.match(notifier.notifyText(), /Final answer after retry/);
			assert.equal(notifier.notifyText().includes("Interim: retrying"), false);
		});
	});

	it("pending async work suppresses the alert and keeps control busy", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			const worker = await connectWorker(fixture);
			const dispatched = await mind.runTool("delegate_async", { task: "pending async", tier: "flash" });
			assert.equal(dispatched.isError, undefined);
			await worker.waitFor((frame) => frame.type === "task" && frame.task.includes("pending async"), { label: "task frame" });
			await endRun(mind, "Interim: waiting");
			await beforeSettle(mind);
			await settle(mind, false);
			assertNoAlerts(notifier);
			assert.equal(fixture.readControl()?.status, "busy");
		});
	});

	it("queued work suppresses the alert", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			const worker = await connectWorker(fixture);
			await mind.runTool("delegate_async", { task: "occupy", workerId: "worker-0" });
			await worker.waitFor((frame) => frame.type === "task" && frame.task.includes("occupy"), { label: "occupy task" });
			const queued = await mind.runTool("delegate_async", { task: "queued work", tier: "flash" });
			assert.equal(queued.isError, undefined);
			await endRun(mind, "Interim: queued");
			await beforeSettle(mind);
			await settle(mind, false);
			assertNoAlerts(notifier);
			assert.equal(fixture.readControl()?.status, "busy");
		});
	});

	it("resetting and draining workers suppress the alert", { timeout: 30000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			const worker = await connectWorker(fixture);
			const reset = mind.runTool("delegate_async", { task: "reset work", workerId: "worker-0", reset: true });
			void reset.catch(() => {});
			await worker.waitFor((frame) => frame.type === "reset", { label: "reset frame" });
			await endRun(mind, "Interim: resetting");
			await beforeSettle(mind);
			await settle(mind, false);
			assertNoAlerts(notifier);
			assert.equal(fixture.readControl()?.status, "busy");
		});

		await notifyCase({ taskTimeout: 1 }, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			const worker = await connectWorker(fixture);
			const pending = mind.runTool("delegate", { task: "drain work", tier: "flash" });
			await worker.waitFor((frame) => frame.type === "task" && frame.task.includes("drain work"), { label: "drain task" });
			const caller = await withTimeout(pending, 6000, "drain caller");
			assert.equal(caller.details?.code, "TIMEOUT");
			await worker.waitFor((frame) => frame.type === "abort", { label: "drain abort" });
			await endRun(mind, "Interim: draining");
			await beforeSettle(mind);
			await settle(mind, false);
			assertNoAlerts(notifier);
			assert.equal(fixture.readControl()?.status, "busy");
		});
	});

	it("follow-up: interim run does not alert; final settlement does", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			const worker = await connectWorker(fixture);
			await mind.runTool("delegate_async", { task: "delegated work", tier: "flash" });
			const task = await worker.waitFor((frame) => frame.type === "task" && frame.task.includes("delegated work"), { label: "delegated task" });
			await endRun(mind, "Interim: delegated");
			assertNoAlerts(notifier);
			worker.send({ type: "result", id: task.id, explanation: "worker result" });
			await waitUntil(() => mind.messages.some((entry) => entry.message?.customType === "mind-worker-result"), { timeout: 5000, label: "worker result" });
			await endRun(mind, "Final answer using the worker result");
			await beforeSettle(mind, "completed");
			await settle(mind, false);
			assert.equal(notifier.notifyCount(), 1);
			assert.match(notifier.notifyText(), /Final answer using the worker result/);
			assert.equal(notifier.notifyText().includes("Interim: delegated"), false);
		});
	});

	it("worker and none roles never alert", { timeout: 20000 }, async () => {
		await withFixture({ workerCount: 1, configOverrides: { ...NOTIFY_CONFIG } }, async (fixture) => {
			const notifier = stubNotifiers(fixture);
			try {
				assertNoAlerts(notifier);
				const fakeMind = await fixture.startFakeMind();
				const worker = await fixture.load("worker");
				await worker.sessionStart();
				const conn = await fakeMind.next();
				await conn.waitFor((frame) => frame.type === "handshake", { label: "worker handshake" });
				await endRun(worker, "Worker run");
				await beforeSettle(worker);
				await settle(worker, false);
				assertNoAlerts(notifier);

				const none = await fixture.load("none");
				await none.sessionStart();
				await endRun(none, "None run");
				await beforeSettle(none);
				await settle(none, false);
				assertNoAlerts(notifier);
				assert.ok(existsSync(join(fixture.root, "bin", "notify-send")) && (statSync(join(fixture.root, "bin", "notify-send")).mode & 0o111));
			} finally {
				notifier.restore();
			}
		});
	});

	it("a retained idle worker does not suppress the alert", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			await connectWorker(fixture);
			await endRun(mind, "Final with idle worker");
			await beforeSettle(mind);
			await settle(mind, false);
			assert.equal(notifier.notifyCount(), 1);
			assert.match(notifier.notifyText(), /Final with idle worker/);
			assert.equal(fixture.readControl()?.status, "worker-connected");
		});
	});

	it("aborted and errored runs restore control but never alert", { timeout: 20000 }, async () => {
		await notifyCase({ configOverrides: { dashboardEnabled: true, dashboardLogResponses: true } }, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			await endRun(mind, "Interim: aborting");
			await beforeSettle(mind, "aborted");
			await settle(mind, true);
			assertNoAlerts(notifier);
			assert.equal(fixture.readControl()?.status, "ready");
			assert.equal(responseLines(fixture).length, 1);

			await endRun(mind, "Interim: erroring");
			await beforeSettle(mind, "error");
			await settle(mind, false);
			assertNoAlerts(notifier);
			assert.equal(responseLines(fixture).length, 2);
		});
	});

	it("startup and reload consume the capture once", { timeout: 30000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			await settle(mind, false);
			assertNoAlerts(notifier);

			await endRun(mind, "Reload interim");
			await mind.ctx.newSession();
			await settle(mind, false);
			assertNoAlerts(notifier);

			await endRun(mind, "Final after reload");
			await beforeSettle(mind);
			await settle(mind, false);
			assert.equal(notifier.notifyCount(), 1);
			assert.equal(notifier.soundCount(), 1);
			assert.match(notifier.notifyText(), /Final after reload/);
			await settle(mind, false);
			assert.equal(notifier.notifyCount(), 1);
			assert.equal(notifier.soundCount(), 1, "dedup plays no second sound");
		});
	});

	it("pending messages and non-idle parents suppress the alert", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			fixture.pendingMessages = true;
			await endRun(mind, "Interim: pending messages");
			await beforeSettle(mind);
			await settle(mind, false);
			assertNoAlerts(notifier);

			fixture.pendingMessages = false;
			fixture.idle = false;
			await endRun(mind, "Interim: not idle");
			await beforeSettle(mind);
			await settle(mind, false);
			assertNoAlerts(notifier);

			fixture.idle = true;
			await endRun(mind, "Final clean");
			await beforeSettle(mind);
			await settle(mind, false);
			assert.equal(notifier.notifyCount(), 1);
			assert.match(notifier.notifyText(), /Final clean/);
		});
	});

	it("notifier failure does not hang and still attempts both channels", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			const notifyStub = join(fixture.root, "bin", "notify-send");
			writeFileSync(notifyStub, `#!/bin/sh\nprintf 'attempt\\n' >> "${notifyStub}.count"\nprintf '%s\\n' "$*" >> "${notifyStub}.attempts"\nexit 1\n`);
			chmodSync(notifyStub, 0o755);
			await endRun(mind, "Final with failing notifier");
			await beforeSettle(mind);
			await settle(mind, false);
			assert.equal(notifier.notifyCount(), 1);
			assert.equal(notifier.pushCount(), 1);
		});
	});

	it("empty ntfyTopic still plays the completion sound", { timeout: 20000 }, async () => {
		await notifyCase({ configOverrides: { ntfyTopic: "" } }, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			await endRun(mind, "Final without a topic");
			await beforeSettle(mind);
			await settle(mind, false);
			assert.equal(notifier.soundCount(), 1);
			assert.match(notifier.soundArgs(), /--id=complete/);
			assert.equal(notifier.notifyCount(), 1);
			assert.equal(notifier.pushCount(), 0);
			assert.equal(fixture.readControl()?.status, "ready");
		});
	});

	it("missing sound player does not suppress desktop/push or settlement", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			rmSync(join(fixture.root, "bin", "canberra-gtk-play"), { force: true });
			await endRun(mind, "Final without a player");
			await beforeSettle(mind);
			await settle(mind, false);
			assert.equal(notifier.soundCount(), 0);
			assert.equal(notifier.notifyCount(), 1);
			assert.equal(notifier.pushCount(), 1);
			assert.equal(fixture.readControl()?.status, "ready");
		});
	});

	it("failing sound player does not suppress desktop/push or settlement", { timeout: 20000 }, async () => {
		await notifyCase({}, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			const soundStub = join(fixture.root, "bin", "canberra-gtk-play");
			writeFileSync(soundStub, `#!/bin/sh\nprintf 'attempt\\n' >> "${soundStub}.count"\nprintf '%s\\n' "$*" >> "${soundStub}.attempts"\nexit 1\n`);
			chmodSync(soundStub, 0o755);
			await endRun(mind, "Final with failing sound");
			await beforeSettle(mind);
			await settle(mind, false);
			assert.equal(notifier.soundCount(), 1);
			assert.match(notifier.soundArgs(), /--id=complete/);
			assert.equal(notifier.notifyCount(), 1);
			assert.equal(notifier.pushCount(), 1);
			assert.equal(fixture.readControl()?.status, "ready");
		});
	});

	it("notifications disabled never alert but restore control", { timeout: 20000 }, async () => {
		await notifyCase({ configOverrides: { notifyOnMindIdle: false } }, async ({ fixture, mind, notifier }) => {
			assertNoAlerts(notifier);
			await endRun(mind, "Final but disabled");
			await beforeSettle(mind);
			await settle(mind, false);
			assertNoAlerts(notifier);
			assert.equal(fixture.readControl()?.status, "ready");
		});
	});

	it("a retired worker record after a role switch never alerts and never leaks BUSY", { timeout: 30000 }, async () => {
		await withFixture({ workerCount: 1, configOverrides: { ...NOTIFY_CONFIG } }, async (fixture) => {
			const notifier = stubNotifiers(fixture);
			try {
				assertNoAlerts(notifier);
				const fakeMind = await fixture.startFakeMind();
				const worker = await fixture.load("worker");
				await worker.sessionStart();
				const conn = await fakeMind.next();
				await conn.waitFor((frame) => frame.type === "handshake", { label: "worker handshake" });
				conn.send({ type: "task", id: "t-retired", task: "retired work" });
				await waitUntil(() => worker.userMessages.some((entry) => entry.content.includes("retired work")), { timeout: 4000, label: "retired task prompt" });

				// Drop the fake Mind; the worker record is unsettled across the role switch.
				fakeMind.server.close();
				rmSync(fixture.socketPath, { force: true });
				await worker.commands.get("stop-worker").handler("", worker.ctx);
				await worker.commands.get("be-mind").handler("", worker.ctx);
				assert.equal(worker.handlers.get("agent_settled")?.length, 1, "exactly one agent_settled registration");

				// The old worker run settles late, now in Mind role: never alert for it.
				await endRun(worker, "Late worker answer");
				await beforeSettle(worker, "completed", [assistant("Late worker answer")]);
				await settle(worker, false);
				assertNoAlerts(notifier);
				assert.equal(conn.seen((frame) => frame.type === "result" || frame.type === "error").length, 0, "no frame to the old Mind socket");
				assert.notEqual(fixture.readControl()?.status, "busy", "control is not left busy");

				// The record was finalized: a new worker role admits and settles a fresh task.
				await worker.commands.get("stop-mind").handler("", worker.ctx);
				const revived = await fixture.startFakeMind();
				await worker.commands.get("be-worker").handler("", worker.ctx);
				const fresh = await revived.next({ timeout: 5000 });
				await fresh.waitFor((frame) => frame.type === "handshake", { label: "reactivated handshake" });
				fresh.send({ type: "task", id: "t-new", task: "new work" });
				await waitUntil(() => worker.userMessages.some((entry) => entry.content.includes("new work")), { timeout: 4000, label: "new task prompt" });
				await endRun(worker, "New worker answer");
				await beforeSettle(worker, "completed", [assistant("New worker answer")]);
				await settle(worker, false);
				await fresh.waitFor((frame) => frame.type === "result" && frame.id === "t-new", { label: "new task result" });
				assert.equal(fresh.seen((frame) => frame.type === "result" && frame.id === "t-new").length, 1, "new task settles once");
				assertNoAlerts(notifier);
			} finally {
				notifier.restore();
			}
		});

		// Optional sub-case: a terminal claim already in flight (extraction behind the
		// real 001 gated git) must not be preempted by a later Mind-role settlement.
		await withFixture({ workerCount: 1, configOverrides: { ...NOTIFY_CONFIG } }, async (fixture) => {
			const gate = fixture.installGatedGit();
			const notifier = stubNotifiers(fixture);
			try {
				assertNoAlerts(notifier);
				const fakeMind = await fixture.startFakeMind();
				const worker = await fixture.load("worker");
				await worker.sessionStart();
				const conn = await fakeMind.next();
				await conn.waitFor((frame) => frame.type === "handshake", { label: "gated worker handshake" });
				conn.send({ type: "task", id: "t-gated", task: "gated work" });
				await waitUntil(() => worker.userMessages.some((entry) => entry.content.includes("gated work")), { timeout: 4000, label: "gated task prompt" });
				await beforeSettle(worker, "completed", [assistant("Gated worker answer")]);

				const settling = worker.emitSettled({ aborted: false });
				await gate.started();

				fakeMind.server.close();
				rmSync(fixture.socketPath, { force: true });
				await worker.commands.get("stop-worker").handler("", worker.ctx);
				// Do not await: the role flips to mind, while getProjectSnapshot is also behind the gate.
				const beMind = worker.commands.get("be-mind").handler("", worker.ctx);

				await endRun(worker, "Late gated worker answer");
				await worker.emitSettled({ aborted: false }); // duplicate in Mind role: never preempt the claim
				gate.release();
				await settling;
				await beMind;

				assertNoAlerts(notifier);
				assert.equal(conn.seen((frame) => frame.type === "result" || frame.type === "error").length, 0, "no frame from the claimed record");
				assert.notEqual(fixture.readControl()?.status, "busy", "control is not left busy");

				await worker.commands.get("stop-mind").handler("", worker.ctx);
				const revived = await fixture.startFakeMind();
				await worker.commands.get("be-worker").handler("", worker.ctx);
				const fresh = await revived.next({ timeout: 5000 });
				await fresh.waitFor((frame) => frame.type === "handshake", { label: "after gated handshake" });
				fresh.send({ type: "task", id: "t-after-gated", task: "after gated work" });
				await waitUntil(() => worker.userMessages.some((entry) => entry.content.includes("after gated work")), { timeout: 4000, label: "after gated task prompt" });
				await endRun(worker, "After gated answer");
				await beforeSettle(worker, "completed", [assistant("After gated answer")]);
				await settle(worker, false);
				await fresh.waitFor((frame) => frame.type === "result" && frame.id === "t-after-gated", { label: "after gated result" });
				assertNoAlerts(notifier);
			} finally {
				notifier.restore();
			}
		});
	});
});
