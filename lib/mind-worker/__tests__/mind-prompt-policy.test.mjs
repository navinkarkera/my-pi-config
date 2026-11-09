// mind-prompt-policy.test.mjs
//
// The mind prompt is the only place delegation policy is stated. This pins the
// task-size gate (one worker owns a scoped deliverable end to end) and the
// guarantees that must survive it: async default, pending tracking, tier
// capacity, and fan-out for genuinely independent work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFixture } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

/** The system prompt Pi builds after every before_agent_start handler has run. */
async function systemPromptFor(instance, cwd) {
	let systemPrompt = "BASE PROMPT";
	for (const handler of instance.handlers.get("before_agent_start") ?? []) {
		const result = await handler({ systemPrompt, systemPromptOptions: { cwd } });
		if (typeof result?.systemPrompt === "string") systemPrompt = result.systemPrompt;
	}
	return systemPrompt;
}

test("mind prompt: right-sizes delegation without losing async tracking or independent fan-out", { timeout: 20000 }, async () => {
	await withFixture({ workerModels: [{ model: "vendor/model", count: 2, tier: "flash" }] }, async (fixture) => {
		const mind = await fixture.load("mind");
		const prompt = await systemPromptFor(mind, fixture.cwd);

		// Task-size gate: one owner per deliverable, no preflight/read split.
		assert.match(prompt, /Right-size the delegation: one worker owns inspect → implement\/install → verify for each scoped deliverable/);
		assert.match(prompt, /never split into separate preflight\/read tasks/);
		assert.match(prompt, /does not duplicate an in-flight delegated investigation unless new evidence requires it/);
		assert.equal(/Saturate all idle workers/i.test(prompt), false, "the saturation directive is gone");
		assert.equal(/Preflight rule/i.test(prompt), false, "the preflight fan-out rule is gone");
		assert.equal(/Parallelize\/queue independent flash work liberally/i.test(prompt), false, "the queue-pressure directive is gone");

		// Retained guarantees.
		assert.match(prompt, /Default to delegate_async/);
		assert.match(prompt, /track pending task IDs/);
		assert.match(prompt, /do not claim completion before required results/);
		assert.match(prompt, /auto-spawn burst workers/);
		assert.match(prompt, /genuinely independent tasks \(separate files, separate searches, separate assertions\) fan out across all idle workers/);
	});
});
