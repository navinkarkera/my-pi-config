// thinking-level.extension.test.mjs
//
// Where the extension applies the configured thinking levels: role activation,
// legacy metadata restore, session replacement, and the burst worker selection.
// The fake Pi records setModel/setThinkingLevel so the assertions can also pin
// the order (model first, then level).
//
// The burst spawn is pinned end to end against a fake Go adapter: the burstFlash
// model and level must reach the spawn op, because Go builds the worker argv.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
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

test("burst spawn: Go receives the burstFlash model and level to build the worker argv", { timeout: 30000 }, async () => {
	// Go builds the worker argv, so the spawn op carrying model+thinking is the contract.
	await withFixture({}, async (fixture) => {
		const runtimeDir = join(fixture.root, "mx");
		mkdirSync(runtimeDir, { recursive: true });
		const adapterPath = join(runtimeDir, "adapter.sock");
		const spawns = [];
		const server = createServer((conn) => {
			let buffer = "";
			conn.setEncoding("utf8");
			conn.on("error", () => {});
			conn.on("data", (chunk) => {
				buffer += chunk;
				let newline;
				while ((newline = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					const request = JSON.parse(line);
					if (request.op === "spawn") spawns.push(request);
					const reply = request.op === "spawn" ? { ok: true, pane: "%9" } : { ok: true, workers: [] };
					conn.write(JSON.stringify(reply) + "\n");
				}
			});
		});
		await new Promise((resolve) => server.listen(adapterPath, resolve));
		fixture.servers.push(server);
		Object.assign(process.env, {
			MINDMUX_ADAPTER_SOCKET: adapterPath,
			MINDMUX_MANIFEST: join(runtimeDir, "record.json"),
			MINDMUX_CONTROL_FILE: join(runtimeDir, "control.json"),
			MINDMUX_DRAFT_SOCKET: join(runtimeDir, "draft.sock"),
			MINDMUX_GENERATION: "7",
			PI_MIND_WORKER_INSTANCE: "mx-g7",
		});
		writeConfig(fixture, {
			workerThinkingLevel: "high",
			burstFlash: {
				enabled: true,
				model: "vendor/burst",
				maxBurst: 2,
				idleTtlMs: 60000,
				maxTasksPerWorker: 3,
				queuePressureThreshold: 1,
				spawnWaitMs: 50,
				logDetail: "compact",
				thinkingLevel: "medium",
			},
		});
		try {
			const mind = await fixture.load("mind");
			await mind.sessionStart();
			// A flash task with no idle worker is what triggers a burst spawn.
			void mind.runTool("delegate", { task: "burst please", tier: "flash" }).catch(() => {});
			await waitUntil(() => spawns.length >= 1, { timeout: 10000, label: "burst spawn" });
			assert.equal(spawns[0].model, "vendor/burst");
			assert.equal(spawns[0].thinking, "medium");
			assert.equal(spawns[0].tier, "flash");
		} finally {
			for (const key of [
				"MINDMUX_ADAPTER_SOCKET", "MINDMUX_MANIFEST", "MINDMUX_CONTROL_FILE",
				"MINDMUX_DRAFT_SOCKET", "MINDMUX_GENERATION", "PI_MIND_WORKER_INSTANCE",
			]) delete process.env[key];
		}
	});
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

// ── Mind prompt: worker profile lines ────────────────────────────────────────
//
// Mind learns its tiers from the generated before_agent_start prompt, so the
// profile line must come from the resolved config (not hardcoded) and must not
// pretend a tier is a model or a context window.

/** The system prompt Pi builds after every before_agent_start handler has run. */
async function systemPromptFor(instance, cwd) {
	let systemPrompt = "BASE PROMPT";
	for (const handler of instance.handlers.get("before_agent_start") ?? []) {
		const result = await handler({ systemPrompt, systemPromptOptions: { cwd } });
		if (typeof result?.systemPrompt === "string") systemPrompt = result.systemPrompt;
	}
	return systemPrompt;
}

const PROFILE_PREFIX = "Worker profiles (from config): ";

test("mind prompt: one profile per tier/model/level, duplicates collapsed, counts still stated", { timeout: 20000 }, async () => {
	await withFixture({
		workerModels: [
			{ model: "vendor/model", count: 2, tier: "flash", thinkingLevel: "low" },
			{ model: "vendor/model", count: 1, tier: "strong", thinkingLevel: "max" },
		],
	}, async (fixture) => {
		const mind = await fixture.load("mind");
		const prompt = await systemPromptFor(mind, fixture.cwd);
		assert.ok(
			prompt.includes(PROFILE_PREFIX + "flash: vendor/model (thinking: low); strong: vendor/model (thinking: max)."),
			"profiles are read from the resolved static worker tuples",
		);
		assert.equal(prompt.split("flash: vendor/model (thinking: low)").length - 1, 1, "the two identical flash workers collapse to one profile");
		// Deduplication would hide the worker count, so the tier sentence must keep it.
		assert.match(prompt, /2 flash/);
		assert.match(prompt, /1 strong/);
	});
});

test("mind prompt: the burst profile carries the burst model and level, not the static or global one", { timeout: 20000 }, async () => {
	await withFixture({
		workerModels: [{ model: "vendor/static", count: 1, tier: "flash", thinkingLevel: "low" }],
		burstFlash: { enabled: true, model: "vendor/burst", maxBurst: 2, thinkingLevel: "medium", spawnWaitMs: 50 },
		configOverrides: { workerThinkingLevel: "high" },
	}, async (fixture) => {
		const mind = await fixture.load("mind");
		const prompt = await systemPromptFor(mind, fixture.cwd);
		assert.ok(prompt.includes(PROFILE_PREFIX + "flash: vendor/static (thinking: low)."));
		assert.ok(prompt.includes("Burst flash profile: vendor/burst (thinking: medium)."), "burst profile uses burstFlash, not the static tier or the global level");
	});
});

test("mind prompt: re-read per turn, global level inherited, disabled or zero-burst profile omitted", { timeout: 20000 }, async () => {
	await withFixture({ workerModels: [{ model: "vendor/first", count: 1, tier: "flash" }] }, async (fixture) => {
		const mind = await fixture.load("mind");

		writeConfig(fixture, { workerThinkingLevel: "high" });
		const before = await systemPromptFor(mind, fixture.cwd);
		assert.ok(before.includes(PROFILE_PREFIX + "flash: vendor/first (thinking: high)."), "an entry without a level inherits workerThinkingLevel");
		assert.equal(before.includes("Burst flash profile:"), false, "a disabled burst worker gets no profile");

		writeConfig(fixture, {
			workerThinkingLevel: "minimal",
			workerModels: [{ model: "vendor/second", count: 1, tier: "strong", thinkingLevel: "xhigh" }],
			burstFlash: { enabled: true, model: "vendor/burst", maxBurst: 0, thinkingLevel: "medium", spawnWaitMs: 50 },
		});
		const after = await systemPromptFor(mind, fixture.cwd);
		assert.ok(after.includes(PROFILE_PREFIX + "strong: vendor/second (thinking: xhigh)."), "the next turn reads the new config instead of a cached or hardcoded profile");
		assert.equal(after.includes("vendor/first"), false, "the stale profile is gone");
		assert.equal(after.includes("Burst flash profile:"), false, "maxBurst 0 spawns no burst worker, so no profile");
	});
});

test("mind prompt: tiers are not promised different models or a bigger context window", { timeout: 20000 }, async () => {
	await withFixture({
		workerModels: [
			{ model: "vendor/model", count: 1, tier: "flash", thinkingLevel: "low" },
			{ model: "vendor/model", count: 1, tier: "strong", thinkingLevel: "max" },
		],
	}, async (fixture) => {
		const mind = await fixture.load("mind");
		const prompt = await systemPromptFor(mind, fixture.cwd);
		// The exact sentence is the source's; these are the facts it must carry.
		assert.match(prompt, /(same|one) model|different models/i);
		assert.match(prompt, /context window/i);
		assert.match(prompt, /deeper reasoning/i);
		assert.match(prompt, /not because/i);
		assert.equal(/deep context/i.test(prompt), false, "the old deep-context framing is gone");
	});
});

test("strong worker prompt: codemode/code_explore first, verification still banned, flash-only delegation", { timeout: 20000 }, async () => {
	// codemode.mode "only" hides declared tools, so a prompt telling the worker to
	// use bash/edit/write freely would name tools it cannot call.
	await withFixture({ workerModels: [{ model: "vendor/model", count: 1, tier: "strong", thinkingLevel: "max" }] }, async (fixture) => {
		const worker = await fixture.load("worker", { workerId: "worker-0", tier: "strong" });
		const prompt = await systemPromptFor(worker, fixture.cwd);
		assert.ok(prompt.includes("[STRONG WORKER MODE"), "the strong worker prompt is the one being checked");
		assert.match(prompt, /codemode/i);
		assert.match(prompt, /code_explore/);
		assert.match(prompt, /(known|identified|specific file|line range)/i, "a known file stays a direct read");
		assert.match(prompt, /tools\.read|read tool/i);
		assert.match(prompt, /do not[^.]*tests[^.]*type-check[^.]*lint[^.]*build/is, "tests/type-check/lint/build stay banned");
		assert.match(prompt, /never delegate to 'strong'/i, "strong still delegates only to flash");
		assert.equal(/use direct tools/i.test(prompt), false, "the 'use direct tools freely' conflict is gone");
	});
});
