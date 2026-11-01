// worker-burst-native.mind.test.mjs
//
// Native hc burst lifecycle against the real helper contract and a fake hc that
// speaks the probed herdr-core shapes (server status core ids, compact run reply,
// full get record, ls, --rm kill reported as not_found). Nothing here reaches a
// real core, spawns a paid agent, or types into a parent terminal.
//
// Pinned here: identity-only child env with a selector snapshot the hc client keeps,
// argv contract (--rm/--no-notify/--parent, mise/node, no rpc), manifest v2 core
// pinning, pending dashboard shape, retire-before-address, bounded retirement with
// confirmation and retry, connect-timeout retirement, spawnPending reconciliation,
// wrong/restarted core handling, run-scoped names, and the /new + /reload policies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, waitUntil, withFixture } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

const BURST = {
	enabled: true,
	model: "vendor/burst",
	maxBurst: 1,
	idleTtlMs: 60000,
	maxTasksPerWorker: 3,
	queuePressureThreshold: 1,
	spawnWaitMs: 10,
	logDetail: "compact",
};

/** Rewrite the fixture's mind-worker.json; loadConfig() runs on every activation. */
function writeConfig(fixture, overrides) {
	const path = join(fixture.agentDir, "mind-worker.json");
	const config = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...config, ...overrides }, null, 2));
}

/** Queue work no static worker can serve, which is what triggers a burst. */
function queueFlashTask(mind) {
	return mind.runTool("delegate", { task: "burst please", tier: "flash" }).catch(() => {});
}

/** The pool's real selectors: a root terminal and an explicit core selector. */
function pinPool(fixture) {
	process.env.HC_TERMINAL_ID = fixture.rootAddress;
	process.env.HC_SESSION = "test-" + fixture.hash;
}

function waitForRuns(hc, count) {
	return waitUntil(() => hc.runs().length >= count, { timeout: 5000, label: count + " hc run call(s)" });
}

function burstLog(fixture, n = 1) {
	const path = join(fixture.stateDir, fixture.hash + "-burst-flash-" + n + ".log");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function burstEntry(fixture, workerId) {
	const tracked = fixture.readControl()?.burstWorkers;
	return Array.isArray(tracked) ? tracked.find((entry) => entry.workerId === workerId) : undefined;
}

function identityOf(argv) {
	const from = argv.indexOf("/usr/bin/env") + 1;
	const to = argv.indexOf("/usr/bin/mise", from);
	assert.ok(from > 0 && to > from, "worker argv must be /usr/bin/env ... /usr/bin/mise x node@26 -- ...");
	return argv.slice(from, to);
}

function nameOf(run) {
	return run.argv[run.argv.indexOf("--name") + 1];
}

test("native burst spawn: argv, identity-only child env, pinned core, and no secret anywhere", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST, configOverrides: { dashboardEnabled: true } }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("logEnv", true);
		process.env.PROBE_SECRET = "sentinel-value-xyz";
		try {
			const mind = await fixture.load("mind");
			await mind.sessionStart();
			void queueFlashTask(mind);
			await waitForRuns(hc, 1);

			const run = hc.runs()[0];
			const argv = run.argv;
			const separator = argv.indexOf("--");
			const hcArgs = argv.slice(0, separator);
			assert.deepEqual(hcArgs.slice(0, 5), ["run", "--bg", "--json", "--no-notify", "--rm"]);
			assert.equal(hcArgs[hcArgs.indexOf("--parent") + 1], fixture.rootAddress);
			assert.equal(hcArgs[hcArgs.indexOf("--cwd") + 1], fixture.cwd);
			assert.match(nameOf(run), /^[a-z0-9][a-z0-9._-]{0,31}$/, "hc-valid run-scoped name");
			for (const forbidden of ["--no-parent", "--keep", "--mode", "rpc"]) assert.ok(!argv.includes(forbidden));

			// The child env is identity only: never an HC_* selector, never a shell export.
			const env = identityOf(argv);
			assert.deepEqual(env.map((entry) => entry.split("=")[0]), [
				"PI_MIND_WORKER_ROLE",
				"PI_MIND_WORKER_TIER",
				"PI_MIND_WORKER_ID",
				"PI_MIND_WORKER_GENERATION",
				"PI_MIND_WORKER_SESSION_DIR",
			]);
			for (const entry of env) assert.ok(!entry.startsWith("HC_"), "no HC_* may be copied into a child");

			// The program is a TUI under mise/node around the absolute installed CLI.
			const program = argv.slice(separator + 1);
			const mise = program.indexOf("/usr/bin/mise");
			assert.equal(program[mise + 1], "x");
			assert.equal(program[mise + 2], "node@26");
			const cli = program[program.indexOf("node", mise) + 1];
			assert.ok(cli.startsWith("/") && cli.endsWith("/dist/cli.js"));
			assert.equal(program[program.indexOf("--model") + 1], "vendor/burst");
			assert.equal(program[program.indexOf("--thinking") + 1], "max");

			// hc calls reach the pool core through the selector snapshot, without the secret.
			const probe = hc.statusCalls()[0];
			assert.ok(probe, "the core is probed before any spawn");
			assert.equal(probe.env.HC_SESSION, process.env.HC_SESSION);
			assert.equal(probe.env.secret, false, "the hc client env is an allowlisted snapshot");
			for (const surface of [JSON.stringify(hc.calls()), fixture.readLog(), burstLog(fixture)]) {
				assert.ok(!surface.includes("sentinel-value-xyz"), "the secret must not travel");
			}
		} finally {
			delete process.env.PROBE_SECRET;
		}
	});
});

test("a pending spawn counts against maxBurst, so a second flash task spawns nothing", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: { ...BURST, maxBurst: 1 } }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runDelayMs", 400);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		void mind.runTool("delegate", { task: "burst again", tier: "flash" }).catch(() => {});
		await waitForRuns(hc, 1);
		await sleep(250);
		assert.equal(hc.runs().length, 1, "a pending spawn must consume a maxBurst slot");
	});
});

test("the control file lists every tracked burst, pending included, with the agreed shape", { timeout: 30000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runDelayMs", 2500);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		const entry = await waitUntil(
			() => burstEntry(fixture, "burst-flash-1"),
			{ timeout: 5000, label: "pending burst in the control file" },
		);
		assert.equal(entry.address, null);
		assert.equal(entry.terminalState, "pending");
		assert.equal(entry.sessionDir, join(fixture.agentDir, "sessions", "burst-flash-" + fixture.hash + "-1"));
		assert.match(entry.logFile, /burst-flash-1\.log$/);
		assert.equal(entry.taskCount, 0);
		assert.equal(typeof entry.lastEvent, "string");
		for (const dead of ["pid", "launchMode", "paneTitle", "kittyWindowId"]) assert.ok(!(dead in entry));
	});
});

test("retire-before-address: a retirement that lands before the reply kills once the address is known", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runDelayMs", 300);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		const sessionDir = join(fixture.agentDir, "sessions", "burst-flash-" + fixture.hash + "-1");
		await waitUntil(() => existsSync(sessionDir), { timeout: 5000, label: "session dir" });

		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => hc.kills().length === 1, { timeout: 8000, label: "retire after the address arrived" });
		assert.equal(Object.keys(hc.terminals()).length, 0, "the terminal record is gone");
		assert.ok(existsSync(sessionDir), "retirement never deletes the transcript/session dir");
	});
});

test("a failed kill is retried within a bounded schedule until the terminal is confirmed gone", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("killFailTimes", 2);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawned: address="), { timeout: 5000, label: "spawned" });

		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 15000, label: "confirmed gone" });
		assert.equal(hc.kills().length, 3, "two failures then one success, no more");
		await waitUntil(() => burstLog(fixture).includes("retired:"), { timeout: 5000, label: "retired logged" });
	});
});

test("exhausted retirement attempts stay tracked and the next sweep finishes the job", { timeout: 60000 }, async () => {
	await withFixture({ burstFlash: { ...BURST, maxTasksPerWorker: 1 } }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("killFailTimes", 3);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		const client = await fixture.connectWorker({ workerId: "burst-flash-1", tier: "flash" });
		const task = await client.waitFor((frame) => frame.type === "task", { timeout: 5000, label: "task" });
		client.send({ type: "result", id: task.id, explanation: "done" });

		// maxTasksPerWorker=1 makes the next idle sweep retire it.
		await waitUntil(() => hc.kills().length === 3, { timeout: 20000, label: "three bounded attempts" });
		assert.equal(Object.keys(hc.terminals()).length, 1, "the record stays while it cannot be retired");
		await waitUntil(() => burstLog(fixture).includes("retire failed"), { timeout: 15000, label: "bounded failure" });

		// Tracked again, not stuck retiring: a later sweep retries and succeeds.
		hc.setToggle("killFailTimes", 0);
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 25000, label: "later sweep retired it" });
		await waitUntil(() => burstLog(fixture).includes("retired:"), { timeout: 5000, label: "retired logged" });
	});
});

test("/new retires bursts on session shutdown instead of warming them, and never respawns", { timeout: 45000 }, async () => {
	await withFixture({ burstFlash: { ...BURST, idleTtlMs: 10000 } }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawned: address="), { timeout: 5000, label: "spawned" });

		// /new replaces the session: session_shutdown marks and retires every burst before
		// suspend. Nothing is warmed for reuse and no agent is restarted.
		await mind.replaceSession();
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 25000, label: "session-shutdown retirement" });
		assert.match(burstLog(fixture), /retire: session-shutdown/);
		assert.equal(hc.runs().length, 1, "a session replacement never respawns a burst");

		// Work queued after the replacement still reaches a static worker.
		const client = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		void mind.runTool("delegate", { task: "after new", tier: "flash" }).catch(() => {});
		const frame = await client.waitFor((f) => f.type === "task", { timeout: 5000, label: "new task served" });
		assert.equal(frame.task, "after new");
	});
});

test("spawnPending: an unreadable reply keeps the name tracked, then reconciles and retires it", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runMode", "malformed");
		hc.setToggle("lsFail", true);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawn-unconfirmed"), { timeout: 8000, label: "pending kept" });
		assert.equal(Object.keys(hc.terminals()).length, 1, "the terminal hc created is still there");
		assert.equal(hc.kills().length, 0, "nothing is killed on a guess");

		// Once the core answers ls again, retirement reconciles by name and proves ownership.
		hc.setToggle("lsFail", false);
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 10000, label: "reconciled and retired" });
	});
});

test("a spawn on a core that is not the pool core is refused before any terminal exists", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setCoreId("ffffffffffffffffffffffffffffffff");
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitUntil(() => /not the pool core/.test(fixture.readLog()), { timeout: 5000, label: "core refusal" });
		assert.equal(hc.runs().length, 0, "no run on a foreign core");
		assert.match(fixture.readLog(), new RegExp(fixture.coreId));
	});
});

test("a core restart during the spawn drops the late result instead of killing an unknown address", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runDelayMs", 400);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		// The pool's core is replaced while the run reply is in flight.
		hc.setCoreId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		await sleep(800);
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await sleep(600);
		assert.equal(hc.kills().length, 0, "an address on a replaced core is never killed");
	});
});

test("run names hash the full cwd + instance + generation and never exceed the hc limit", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		process.env.PI_MIND_WORKER_INSTANCE = "a-very-long-instance-label-that-would-blow-the-name";
		// The manifest is keyed by the instance-prefixed cwd hash, exactly as the launcher writes it.
		const instanceHash = process.env.PI_MIND_WORKER_INSTANCE + "-" + fixture.hash;
		writeFileSync(
			join(fixture.stateDir, instanceHash + "-manifest.json"),
			readFileSync(join(fixture.stateDir, fixture.hash + "-manifest.json"), "utf8"),
		);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		const first = nameOf(hc.runs()[0]);
		assert.ok(first.length <= 32, "a long instance label must not consume the name budget");
		assert.match(first, /^[a-z0-9][a-z0-9._-]*$/);

		// A new generation is a new run: the hash changes with the same cwd and instance.
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => hc.kills().length === 1, { timeout: 8000, label: "first run retired" });
		const manifestPath = join(fixture.stateDir, instanceHash + "-manifest.json");
		writeFileSync(manifestPath, JSON.stringify({
			...JSON.parse(readFileSync(manifestPath, "utf8")),
			generation: fixture.generation + 1,
		}, null, 2));
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 2);
		const second = nameOf(hc.runs()[1]);
		assert.notEqual(second.split("-b")[0], first.split("-b")[0], "generation is part of the run hash");
	});
});

test("/reload adopts its own leftover bursts, including name-only pending, for cleanup only", { timeout: 40000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		const first = await fixture.load("mind");
		await first.sessionStart();
		// A name-only pending spawn: hc created the terminal but the reply was malformed and
		// ls is unavailable, so the pool never learned the address.
		hc.setToggle("runMode", "malformed");
		hc.setToggle("lsFail", true);
		void queueFlashTask(first);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawn-unconfirmed"), { timeout: 8000, label: "name-only pending" });
		const name = nameOf(hc.runs()[0]);

		// The shutdown retirement cannot resolve the name (ls unavailable), so the entry must
		// survive durably with name/core/root metadata for the next module.
		await first.sessionShutdown("reload");
		const entry = burstEntry(fixture, "burst-flash-1");
		assert.ok(entry, "the pending entry is persisted for reload cleanup");
		assert.equal(entry.name, name);
		assert.equal(entry.coreId, fixture.coreId);
		assert.equal(entry.rootAddress, fixture.rootAddress);
		assert.equal(entry.spawnSettled, true);

		// Reload: the new module captures the snapshot before the heartbeat, adopts the entry
		// as cleanup-only, resolves the name once ls recovers, and retires it. Never a task.
		hc.setToggle("lsFail", false);
		const second = await fixture.load("mind");
		await second.sessionStart();
		await waitUntil(() => /adopted 1 tracked terminal\(s\) for reload cleanup/.test(fixture.readLog()), {
			timeout: 8000,
			label: "cleanup adoption",
		});
		assert.equal(hc.runs().length, 1, "adoption never spawns");
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 15000, label: "name-only terminal retired" });
		assert.equal(hc.runs().length, 1, "cleanup never restarts work");
	});
});

test("a persisted burst snapshot from another envelope is never adopted", { timeout: 30000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		const first = await fixture.load("mind");
		await first.sessionStart();
		void queueFlashTask(first);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawned: address="), { timeout: 5000, label: "spawned" });
		await first.sessionShutdown("reload");

		// The next module belongs to a different core id: the old envelope is not its pool.
		const manifestPath = join(fixture.stateDir, fixture.hash + "-manifest.json");
		writeFileSync(manifestPath, JSON.stringify({
			...JSON.parse(readFileSync(manifestPath, "utf8")),
			coreIdentity: { id: "ffffffffffffffffffffffffffffffff", name: "test-host" },
		}, null, 2));
		const second = await fixture.load("mind");
		await second.sessionStart();
		await waitUntil(() => /another pool envelope/.test(fixture.readLog()), { timeout: 8000, label: "envelope refusal" });
		assert.equal(hc.runs().length, 1, "a refused snapshot never spawns");
	});
});

test("a deterministic spawn failure never fails queued work a static worker can serve", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runMode", "spawn_failed");
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		await waitUntil(() => /spawn failed/.test(fixture.readLog()), { timeout: 5000, label: "failure logged" });
		assert.equal(hc.kills().length, 0, "a terminal that never existed is never killed");

		// The queue is untouched: a static flash worker that connects now gets the task.
		const client = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		const frame = await client.waitFor((f) => f.type === "task", { timeout: 5000, label: "queued task dispatched" });
		assert.equal(frame.task, "burst please");
	});
});

test("removals: /mind-reset is gone while the static reset command remains", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		fixture.installFakeHc();
		pinPool(fixture);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		assert.equal(mind.commands.has("mind-reset"), false, "/mind-reset must not exist");
		assert.equal(mind.commands.has("mind-worker-internal-reset"), true, "the static conversation reset stays");
	});
});

test("hc calls keep the spawn-time selector snapshot when the shell env changes", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawned: address="), { timeout: 5000, label: "spawned" });

		// The shell that started the pool is gone; the pinned snapshot must still reach the core.
		delete process.env.HC_SESSION;
		delete process.env.HC_TERMINAL_ID;
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 10000, label: "retired with the snapshot" });
		assert.equal(hc.kills().length, 1);
	});
});

test("an unavailable core past the old grace keeps a name-only pending burst, then recovery retires it", { timeout: 45000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runMode", "malformed");
		hc.setToggle("lsFail", true);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawn-unconfirmed"), { timeout: 8000, label: "name-only pending" });
		await waitUntil(() => burstEntry(fixture, "burst-flash-1")?.name, { timeout: 5000, label: "persisted name" });

		// Core unavailable, and the clock jumps past the removed pending grace. The old
		// time-based deletion would forget the entry here; it must stay tracked.
		hc.setToggle("statusFail", true);
		const realNow = Date.now;
		const offset = 130000;
		Date.now = () => realNow() + offset;
		try {
			await sleep(6000); // at least one 5 s idle sweep
		} finally {
			Date.now = realNow;
		}
		const entry = burstEntry(fixture, "burst-flash-1");
		assert.ok(entry, "an unavailable core must not forget a possible terminal");
		assert.equal(entry.address, null);

		// Recover: the next retirement resolves the unique name and kills the terminal.
		hc.setToggle("statusFail", false);
		hc.setToggle("lsFail", false);
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 15000, label: "recovered and retired" });
	});
});

test("an untracked burst handshake is refused and never receives work", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		fixture.installFakeHc();
		pinPool(fixture);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		const unknown = await fixture.connectWorker({ workerId: "burst-flash-99", tier: "flash" });
		const error = await unknown.waitFor((f) => f.type === "error", { timeout: 5000, label: "refusal" });
		assert.equal(error.code, "UNKNOWN_BURST");
		await unknown.waitForClose({ timeout: 5000 });

		const staticWorker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		void mind.runTool("delegate", { task: "static please", tier: "flash" }).catch(() => {});
		const frame = await staticWorker.waitFor((f) => f.type === "task", { timeout: 5000, label: "task" });
		assert.equal(frame.task, "static please");
	});
});

test("/reload restores the monotonic burst counter before the next spawn, even with no entries", { timeout: 40000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		const first = await fixture.load("mind");
		await first.sessionStart();
		void queueFlashTask(first);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawned: address="), { timeout: 5000, label: "spawned" });
		const firstName = nameOf(hc.runs()[0]);
		await first.sessionShutdown("reload");
		await waitUntil(() => {
			const control = fixture.readControl();
			return control && typeof control.burstCounter === "number" && control.burstCounter >= 1;
		}, { timeout: 5000, label: "persisted counter" });

		// Empty entries + a high counter: the next module must restore it before spawning.
		const control = fixture.readControl();
		control.burstCounter = 123456789;
		control.burstWorkers = [];
		writeFileSync(fixture.controlPath, JSON.stringify(control, null, 2));

		const second = await fixture.load("mind");
		await second.sessionStart();
		void queueFlashTask(second);
		await waitForRuns(hc, 2);
		const secondName = nameOf(hc.runs()[1]);
		assert.notEqual(secondName, firstName);
		assert.match(secondName, /^[a-z0-9][a-z0-9._-]{0,31}$/);
		assert.ok(secondName.endsWith("-b123456790"), "counter restored before the spawn: " + secondName);
		assert.ok(secondName.length <= 32);
	});
});

test("a generation change mid-pending never adopts the late success; it retires the old-owned address", { timeout: 30000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runDelayMs", 500);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		const manifestPath = join(fixture.stateDir, fixture.hash + "-manifest.json");
		writeFileSync(manifestPath, JSON.stringify({
			...JSON.parse(readFileSync(manifestPath, "utf8")),
			generation: fixture.generation + 1,
		}, null, 2));
		await waitUntil(() => hc.kills().length === 1, { timeout: 10000, label: "old-owned address retired" });
		const address = hc.kills()[0].argv[1];
		assert.equal(hc.terminals()[address], undefined);
		await waitUntil(() => burstEntry(fixture, "burst-flash-1")?.address === null, { timeout: 5000, label: "entry not adopted" });
		assert.equal(hc.runs().length, 1);
	});
});

test("a root change mid-pending never adopts the late failure; cleanup stays tracked", { timeout: 30000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runMode", "malformed");
		hc.setToggle("lsFail", true);
		hc.setToggle("runDelayMs", 500);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		process.env.HC_TERMINAL_ID = "t2";
		await waitUntil(() => /stale spawn unconfirmed/.test(fixture.readLog()), { timeout: 10000, label: "stale failure" });
		const entry = await waitUntil(() => {
			const current = burstEntry(fixture, "burst-flash-1");
			return current && current.spawnSettled === true ? current : undefined;
		}, { timeout: 5000, label: "settled cleanup entry" });
		assert.ok(entry, "the old entry stays tracked");
		assert.equal(entry.address, null);

		// With ls healthy again, the later sweep retires the old-owned name.
		hc.setToggle("lsFail", false);
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 15000, label: "old-owned name retired" });
		assert.equal(hc.runs().length, 1);
	});
});

test("a reload with an unavailable core keeps the durable cleanup entry, then retries and retires", { timeout: 40000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		const first = await fixture.load("mind");
		await first.sessionStart();
		hc.setToggle("runMode", "malformed");
		hc.setToggle("lsFail", true);
		void queueFlashTask(first);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawn-unconfirmed"), { timeout: 8000, label: "name-only pending" });
		await first.sessionShutdown("reload");
		assert.ok(burstEntry(fixture, "burst-flash-1"), "durable entry before reload");

		// Reload while the core is unavailable: adoption must still keep the entry tracked.
		hc.setToggle("statusFail", true);
		const second = await fixture.load("mind");
		await second.sessionStart();
		await waitUntil(() => /adopted 1 tracked terminal\(s\) for reload cleanup/.test(fixture.readLog()), { timeout: 8000, label: "cleanup adoption" });
		const kept = await waitUntil(() => burstEntry(fixture, "burst-flash-1"), { timeout: 5000, label: "durable entry kept" });
		assert.equal(kept.address, null);
		assert.ok(kept.terminalState === "retiring" || kept.terminalState === "pending");

		// Recover: the tracked cleanup retires the old-owned name.
		hc.setToggle("statusFail", false);
		hc.setToggle("lsFail", false);
		await second.commands.get("stop-mind").handler("", second.ctx);
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 15000, label: "recovered and retired" });
		assert.equal(hc.runs().length, 1);
	});
});

test("a manifest without exact v2 markers refuses every burst before any hc run", { timeout: 30000 }, async () => {
	await withFixture({ burstFlash: BURST }, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		const manifestPath = join(fixture.stateDir, fixture.hash + "-manifest.json");
		const base = JSON.parse(readFileSync(manifestPath, "utf8"));
		const variants = [
			["missing markers", { ...base, schemaVersion: undefined, terminalBackend: undefined }],
			["wrong schema", { ...base, schemaVersion: 1 }],
			["wrong backend", { ...base, terminalBackend: "herdr" }],
			["generation zero", { ...base, generation: 0 }],
			["generation negative", { ...base, generation: -1 }],
			["generation float", { ...base, generation: 1.5 }],
			["generation string", { ...base, generation: "1" }],
		];
		for (const [label, manifest] of variants) {
			writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
			void queueFlashTask(mind);
			await sleep(150);
			assert.equal(hc.runs().length, 0, label + " must not spawn a burst");
			assert.match(fixture.readLog(), /manifest is not v2/);
		}
		assert.equal(hc.statusCalls().length, 0, "the manifest is rejected before any core probe");
	});
});

test("status unavailable with a healthy ls cannot forget a name-only pending burst, then recovery retires it", { timeout: 45000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runMode", "malformed");
		hc.setToggle("lsFail", true);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawn-unconfirmed"), { timeout: 8000, label: "name-only pending" });
		await waitUntil(() => burstEntry(fixture, "burst-flash-1")?.name, { timeout: 5000, label: "persisted name" });

		// Status probe fails while ls is healthy: the guarded lookup must return unknown,
		// never absence, so the pending entry and its terminal stay tracked.
		hc.setToggle("lsFail", false);
		hc.setToggle("statusFail", true);
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await sleep(1500);
		const kept = burstEntry(fixture, "burst-flash-1");
		assert.ok(kept, "status unavailable must not forget the name-only entry");
		assert.equal(kept.address, null);
		assert.equal(Object.keys(hc.terminals()).length, 1, "the owned terminal stays live, not killed on a guess");

		// Recover: re-activate and retire the owned terminal by its proven name.
		hc.setToggle("statusFail", false);
		await mind.commands.get("be-mind").handler("", mind.ctx);
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 15000, label: "recovered and retired" });
		assert.ok(hc.kills().length >= 1, "the recovered core retires the owned terminal");
	});
});

test("a malformed hc ls cannot prove a name-only burst absent, then recovery retires it", { timeout: 45000 }, async () => {
	await withFixture({
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		hc.setToggle("runMode", "malformed");
		hc.setToggle("lsFail", true);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawn-unconfirmed"), { timeout: 8000, label: "name-only pending" });
		await waitUntil(() => burstEntry(fixture, "burst-flash-1")?.name, { timeout: 5000, label: "persisted name" });

		// A valid JSON reply without a terminals array is not proof of absence.
		hc.setToggle("lsFail", false);
		hc.setToggle("lsMode", "no-terminals");
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await sleep(1500);
		const kept = burstEntry(fixture, "burst-flash-1");
		assert.ok(kept, "a malformed list must not forget the name-only entry");
		assert.equal(kept.address, null);
		assert.equal(Object.keys(hc.terminals()).length, 1, "the owned terminal stays live");

		hc.setToggle("lsMode", "ok");
		await mind.commands.get("be-mind").handler("", mind.ctx);
		await mind.commands.get("stop-mind").handler("", mind.ctx);
		await waitUntil(() => Object.keys(hc.terminals()).length === 0, { timeout: 15000, label: "recovered and retired" });
	});
});


test("a burst handshake cannot make static readiness or consume a static tier slot", { timeout: 30000 }, async () => {
	await withFixture({
		workerCount: 2,
		burstFlash: BURST,
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		const mind = await fixture.load("mind");
		await mind.sessionStart();
		void queueFlashTask(mind);
		await waitForRuns(hc, 1);
		await fixture.connectWorker({ workerId: "burst-flash-1", tier: "flash" });
		await waitUntil(() => fixture.readControl()?.workers?.some((w) => w.workerId === "burst-flash-1"), {
			timeout: 5000,
			label: "burst handshake recorded",
		});

		const withBurst = fixture.readControl();
		assert.equal(withBurst.connectedWorkers ?? 0, 0, "a burst must not count as a static connection");
		assert.notEqual(withBurst.status, "worker-connected", "a burst must not make the static pool ready");

		// Two static workers must both reconnect; the burst must not consume a static slot.
		await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		await fixture.connectWorker({ workerId: "worker-1", tier: "flash" });
		await waitUntil(() => {
			const control = fixture.readControl();
			const ids = (control?.workers || []).map((w) => w.workerId);
			return ids.includes("worker-0") && ids.includes("worker-1");
		}, { timeout: 5000, label: "both static workers admitted" });
		assert.equal(fixture.readControl().connectedWorkers, 2, "static readiness counts statics only");
	});
});

test("cleanup-only reload bursts never count available and cannot receive fanout or queued work", { timeout: 60000 }, async () => {
	await withFixture({
		workerCount: 1,
		burstFlash: { ...BURST, maxBurst: 2 },
		configOverrides: { dashboardEnabled: true, dashboardHeartbeatMs: 1000 },
	}, async (fixture) => {
		const hc = fixture.installFakeHc();
		pinPool(fixture);
		const first = await fixture.load("mind");
		await first.sessionStart();
		void queueFlashTask(first);
		await waitForRuns(hc, 1);
		await waitUntil(() => burstLog(fixture).includes("spawned: address="), { timeout: 5000, label: "first burst spawned" });
		await fixture.connectWorker({ workerId: "burst-flash-1", tier: "flash" });
		await waitUntil(() => Boolean(burstEntry(fixture, "burst-flash-1")?.address), {
			timeout: 5000,
			label: "first burst address recorded",
		});

		// Keep the reload cleanup entry alive through exhausted kill retries, so its
		// retirement state is exactly "spawned with retireReason" rather than gone.
		hc.setToggle("killFailTimes", 100);
		await first.sessionShutdown("reload");
		const second = await fixture.load("mind");
		await second.sessionStart();
		await waitUntil(() => /adopted 1 tracked terminal\(s\) for reload cleanup/.test(fixture.readLog()), {
			timeout: 8000,
			label: "cleanup adoption",
		});
		await waitUntil(() => burstEntry(fixture, "burst-flash-1")?.terminalState === "spawned"
			&& burstEntry(fixture, "burst-flash-1")?.retireReason, {
			timeout: 20000,
			label: "cleanup burst stays tracked after kill failures",
		});

		const cleanup = await fixture.connectWorker({ workerId: "burst-flash-1", tier: "flash" });
		await waitUntil(() => fixture.readControl()?.workers?.some((w) => w.workerId === "burst-flash-1"), {
			timeout: 5000,
			label: "cleanup reconnect admitted",
		});
		assert.deepEqual(cleanup.seen((frame) => frame.type === "error"), [], "cleanup reconnect must not be refused");

		// Fanout sees no idle worker; cleanup-only is not an idle worker.
		const fanout = await second.runTool("delegate", { task: "fanout cleanup", strategy: "fanout", tier: "flash" });
		assert.equal(fanout.isError, true);
		assert.equal(fanout.details?.code, "NO_IDLE_WORKERS");
		assert.equal(cleanup.seen((frame) => frame.type === "task").length, 0, "fanout must not reach cleanup");

		// Explicit targeting is refused before dispatch, not left hanging.
		const direct = await second.runTool("delegate", { task: "direct cleanup", tier: "flash", workerId: "burst-flash-1" });
		assert.equal(direct.isError, true);
		assert.equal(direct.details?.code, "WORKER_UNAVAILABLE", JSON.stringify(direct));
		assert.equal(cleanup.seen((frame) => frame.type === "task").length, 0, "direct dispatch must not reach cleanup");

		// A queued flash task may spawn a replacement because cleanup consumes one of
		// two burst slots but does not reserve queued work. The static worker serves it.
		void second.runTool("delegate", { task: "static after cleanup", tier: "flash" }).catch(() => {});
		await waitForRuns(hc, 2);
		const staticWorker = await fixture.connectWorker({ workerId: "worker-0", tier: "flash" });
		const frame = await staticWorker.waitFor((f) => f.type === "task", { timeout: 5000, label: "static task" });
		assert.equal(frame.task, "static after cleanup");
		await sleep(100);
		assert.equal(cleanup.seen((f) => f.type === "task").length, 0, "cleanup must never receive queued work");
	});
});
