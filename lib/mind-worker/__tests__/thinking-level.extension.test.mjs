// thinking-level.extension.test.mjs
//
// Where the extension applies the configured thinking levels: role activation,
// legacy metadata restore, session replacement, and the burst worker selection.
// The fake Pi records setModel/setThinkingLevel so the assertions can also pin
// the order (model first, then level).
//
// The headless burst spawn is pinned end to end with a fake Pi CLI on
// PI_PACKAGE_DIR. Coverage intentionally omitted: the kitty launch argv (burst
// kitty path and legacy `spawnWorkerInKitty`), which needs a fake kitty; both
// read the same resolved config value pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil, withFixture } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

/** Rewrite the fixture's mind-worker.json; loadConfig() runs on every activation. */
function writeConfig(fixture, overrides) {
	const path = join(fixture.agentDir, "mind-worker.json");
	const config = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...config, ...overrides }, null, 2));
}

/** Record [model, id] / [thinking, level] in call order. modelRegistry.find must resolve. */
function recordCalls(instance) {
	const calls = [];
	instance.ctx.modelRegistry.find = (provider, id) => ({ provider, id });
	instance.pi.setModel = async (model) => {
		calls.push(["model", model.id]);
		return true;
	};
	instance.pi.setThinkingLevel = (level) => {
		calls.push(["thinking", level]);
	};
	return calls;
}

async function activateWorker(fixture, loadOptions = {}) {
	const worker = await fixture.load("worker", loadOptions);
	const calls = recordCalls(worker);
	await fixture.startFakeMind();
	await worker.sessionStart();
	return { worker, calls };
}

test("worker: the configured global level is applied after the model", { timeout: 20000 }, async () => {
	await withFixture({ workerModels: [{ model: "vendor/flash", count: 2, tier: "flash" }] }, async (fixture) => {
		writeConfig(fixture, { workerThinkingLevel: "high" });
		const { calls } = await activateWorker(fixture, { workerId: "worker-1" });
		assert.deepEqual(calls, [["model", "flash"], ["thinking", "high"]]);
	});
});

test("worker: an absent level keeps the pre-config max, an invalid one falls back to it", { timeout: 20000 }, async () => {
	await withFixture({ workerModels: [{ model: "vendor/flash", count: 1, tier: "flash" }] }, async (fixture) => {
		const first = await activateWorker(fixture, { workerId: "worker-0" });
		assert.deepEqual(first.calls, [["model", "flash"], ["thinking", "max"]]);

		writeConfig(fixture, { workerThinkingLevel: "ultra" });
		const second = await activateWorker(fixture, { workerId: "worker-0" });
		assert.deepEqual(second.calls, [["model", "flash"], ["thinking", "max"]]);
	});
});

test("worker: a per-entry level wins and an entry without one inherits the global level", { timeout: 20000 }, async () => {
	await withFixture({
		workerModels: [
			{ model: "vendor/flash", count: 1, tier: "flash", thinkingLevel: "low" },
			{ model: "vendor/strong", count: 1, tier: "strong" },
		],
	}, async (fixture) => {
		writeConfig(fixture, { workerThinkingLevel: "high" });

		const overridden = await activateWorker(fixture, { workerId: "worker-0" });
		assert.deepEqual(overridden.calls, [["model", "flash"], ["thinking", "low"]]);

		const inherited = await activateWorker(fixture, { workerId: "worker-1" });
		assert.deepEqual(inherited.calls, [["model", "strong"], ["thinking", "high"]]);
	});
});

test("mind: the configured level is applied after the model", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		writeConfig(fixture, { mindThinkingLevel: "high" });
		const mind = await fixture.load("mind");
		const calls = recordCalls(mind);
		await mind.sessionStart();
		assert.deepEqual(calls, [["model", "model"], ["thinking", "high"]]);
	});
});

test("mind: an absent or invalid level leaves Pi's own level untouched", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		const mind = await fixture.load("mind");
		const calls = recordCalls(mind);
		await mind.sessionStart();
		assert.deepEqual(calls, [["model", "model"]]);

		writeConfig(fixture, { mindThinkingLevel: "ludicrous" });
		const second = await fixture.load("mind");
		const secondCalls = recordCalls(second);
		await second.sessionStart();
		assert.deepEqual(secondCalls, [["model", "model"]]);
	});
});

test("burst: a burst worker takes the burstFlash model and level, not the static flash tier", { timeout: 20000 }, async () => {
	await withFixture({
		workerModels: [{ model: "vendor/static-flash", count: 2, tier: "flash", thinkingLevel: "low" }],
	}, async (fixture) => {
		writeConfig(fixture, {
			workerThinkingLevel: "high",
			burstFlash: { enabled: true, model: "vendor/burst", maxBurst: 2, spawnWaitMs: 50, thinkingLevel: "medium" },
		});
		const { calls } = await activateWorker(fixture, { workerId: "burst-flash-1", tier: "flash" });
		assert.deepEqual(calls, [["model", "burst"], ["thinking", "medium"]]);
	});
});

test("burst: an omitted burstFlash level inherits the global worker level", { timeout: 20000 }, async () => {
	await withFixture({
		workerModels: [{ model: "vendor/static-flash", count: 1, tier: "flash" }],
	}, async (fixture) => {
		writeConfig(fixture, {
			workerThinkingLevel: "high",
			burstFlash: { enabled: true, model: "vendor/burst", maxBurst: 2, spawnWaitMs: 50 },
		});
		const { calls } = await activateWorker(fixture, { workerId: "burst-flash-2", tier: "flash" });
		assert.deepEqual(calls, [["model", "burst"], ["thinking", "high"]]);
	});
});

test("replacement session: activation re-applies the configured level", { timeout: 20000 }, async () => {
	await withFixture({ workerModels: [{ model: "vendor/flash", count: 1, tier: "flash" }] }, async (fixture) => {
		writeConfig(fixture, { workerThinkingLevel: "low" });
		const { worker, calls } = await activateWorker(fixture, { workerId: "worker-0" });
		await worker.replaceSession();
		assert.deepEqual(calls, [
			["model", "flash"], ["thinking", "low"],
			["model", "flash"], ["thinking", "low"],
		]);
	});
});

test("legacy restore: the worker role keeps the configured level and does not re-set the model", { timeout: 20000 }, async () => {
	await withFixture({
		workerModels: [
			{ model: "vendor/flash", count: 1, tier: "flash" },
			{ model: "vendor/strong", count: 1, tier: "strong", thinkingLevel: "xhigh" },
		],
	}, async (fixture) => {
		writeConfig(fixture, { workerThinkingLevel: "high" });
		// The legacy kitty spawn sets the worker id without a launcher role flag.
		process.env.PI_MIND_WORKER_ID = "worker-1";
		const worker = await fixture.load("none");
		worker.ctx.sessionManager.getEntries = () => [
			{ type: "custom", customType: "mind-worker-role", data: { role: "worker", cwd: fixture.cwd } },
		];
		const calls = recordCalls(worker);
		await fixture.startFakeMind();
		await worker.sessionStart();
		assert.deepEqual(calls, [["thinking", "xhigh"]]);
		delete process.env.PI_MIND_WORKER_ID;
	});
});

test("burst spawn: the headless Pi process gets the burstFlash model and level", { timeout: 30000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "thinking-spawn-"));
	const pkgDir = join(root, "pkg");
	mkdirSync(join(pkgDir, "dist"), { recursive: true });
	const logPath = join(root, "spawn.jsonl");
	writeFileSync(
		join(pkgDir, "dist", "cli.js"),
		"#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
	);
	chmodSync(join(pkgDir, "dist", "cli.js"), 0o755);
	process.env.FAKE_PI_LOG = logPath;
	try {
		// PI_PACKAGE_DIR is where the extension resolves its Pi CLI, so the spawn hits the fake.
		await withFixture({ packageDir: pkgDir }, async (fixture) => {
			writeConfig(fixture, {
				workerThinkingLevel: "high",
				burstFlash: {
					enabled: true,
					model: "vendor/burst",
					maxBurst: 2,
					idleTtlMs: 60000,
					maxTasksPerWorker: 3,
					launchMode: "headless",
					queuePressureThreshold: 1,
					spawnWaitMs: 50,
					killTimeoutMs: 1000,
					logDetail: "compact",
					thinkingLevel: "medium",
				},
			});
			const mind = await fixture.load("mind");
			await mind.sessionStart();
			// A flash task with no idle worker is what triggers a burst spawn.
			void mind.runTool("delegate", { task: "burst please", tier: "flash" }).catch(() => {});
			await waitUntil(
				() => existsSync(logPath) && readFileSync(logPath, "utf8").trim().length > 0,
				{ timeout: 5000, label: "burst spawn" },
			);
			const args = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n")[0]);
			assert.equal(args[args.indexOf("--model") + 1], "vendor/burst");
			assert.equal(args[args.indexOf("--thinking") + 1], "medium");
		});
	} finally {
		delete process.env.FAKE_PI_LOG;
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy restore: the mind role applies the configured level", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		writeConfig(fixture, { mindThinkingLevel: "minimal" });
		const mind = await fixture.load("none");
		mind.ctx.sessionManager.getEntries = () => [
			{ type: "custom", customType: "mind-worker-role", data: { role: "mind", cwd: fixture.cwd } },
		];
		const calls = recordCalls(mind);
		await mind.sessionStart();
		assert.deepEqual(calls, [["thinking", "minimal"]]);
	});
});
