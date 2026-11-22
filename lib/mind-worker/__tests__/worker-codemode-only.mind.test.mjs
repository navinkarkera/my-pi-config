// worker-codemode-only.mind.test.mjs
//
// Managed on-demand Workers reach tools only through codemode. This pins the
// enforcement: codemode stays active when settings omit it, direct tool calls
// are blocked, nested codemode calls pass, both tiers get the codemode-only
// prompt, and legacy workers are untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFixture } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

async function withOnDemand(fn) {
	process.env.MINDMUX_ON_DEMAND = "1";
	try {
		return await fn();
	} finally {
		delete process.env.MINDMUX_ON_DEMAND;
	}
}

/** The system prompt Pi builds after every before_agent_start handler has run. */
async function systemPromptFor(instance, cwd) {
	let systemPrompt = "BASE PROMPT";
	for (const handler of instance.handlers.get("before_agent_start") ?? []) {
		const result = await handler({ systemPrompt, systemPromptOptions: { cwd } });
		if (typeof result?.systemPrompt === "string") systemPrompt = result.systemPrompt;
	}
	return systemPrompt;
}

/** First blocking tool_call decision, or null when the call is allowed. */
async function toolCallDecision(instance, event) {
	for (const handler of instance.handlers.get("tool_call") ?? []) {
		const result = await handler(event, instance.ctx);
		if (result?.block) return result;
	}
	return null;
}

async function startWorker(fixture, loadOptions = {}) {
	const fakeMind = await fixture.startFakeMind();
	const worker = await fixture.load("worker", loadOptions);
	await worker.sessionStart();
	const conn = await fakeMind.next();
	await conn.waitFor((frame) => frame.type === "handshake", { label: "worker handshake" });
	return { worker, conn };
}

test("on-demand flash Worker activates codemode even when settings omit it, and only codemode is permitted", { timeout: 20000 }, async () => {
	await withOnDemand(async () => {
		await withFixture({}, async (fixture) => {
			// Settings expose only direct tools; codemode is not in defaultTools.
			const { worker } = await startWorker(fixture, { activeTools: ["read", "bash"], settings: { defaultTools: ["read", "bash"] } });
			assert.deepEqual(worker.pi.getActiveTools(), ["read", "bash", "codemode"], "existing tools stay active and codemode joins them");

			const prompt = await systemPromptFor(worker, fixture.cwd);
			assert.match(prompt, /\[ON-DEMAND WORKER — Codemode only\]/);
			assert.match(prompt, /Use only the codemode tool/);
			assert.match(prompt, /Direct tool calls are blocked/);
			assert.match(prompt, /No subdelegate tools are available/);

			const directRead = await toolCallDecision(worker, { toolName: "read", toolCallId: "c1", input: { path: "a" } });
			assert.equal(directRead?.block, true);
			assert.match(directRead.reason, /use only codemode/i);
			const directBash = await toolCallDecision(worker, { toolName: "bash", toolCallId: "c2", input: { command: "ls" } });
			assert.equal(directBash?.block, true);

			const topCodemode = await toolCallDecision(worker, { toolName: "codemode", toolCallId: "c3", input: { code: "return 1" } });
			assert.equal(topCodemode, null, "the top-level codemode call is allowed");
			const nestedRead = await toolCallDecision(worker, { toolName: "read", toolCallId: "c4", parentToolCallId: "c3", input: { path: "a" } });
			assert.equal(nestedRead, null, "calls nested under codemode are allowed");
			const nestedBash = await toolCallDecision(worker, { toolName: "bash", toolCallId: "c5", parentToolCallId: "c3", input: { command: "ls" } });
			assert.equal(nestedBash, null);
		});
	});
});

test("on-demand strong Worker gets the same codemode-only rule and no subdelegate instructions", { timeout: 20000 }, async () => {
	await withOnDemand(async () => {
		await withFixture({}, async (fixture) => {
			const { worker } = await startWorker(fixture, { tier: "strong", activeTools: ["read"], settings: { defaultTools: ["read"] } });
			assert.deepEqual(worker.pi.getActiveTools(), ["read", "codemode"]);

			const prompt = await systemPromptFor(worker, fixture.cwd);
			assert.match(prompt, /\[STRONG WORKER MODE — Codemode Tools\]/);
			assert.match(prompt, /You are a strong-tier worker\. Use only codemode/);
			assert.match(prompt, /a direct tool call is blocked/);
			assert.match(prompt, /no subdelegate tools are available/);
			assert.doesNotMatch(prompt, /You have full access to the codemode tools .* and delegate/);
			assert.doesNotMatch(prompt, /Delegate to flash ONLY/);
			assert.doesNotMatch(prompt, /Never delegate to 'strong' tier/);

			const directWrite = await toolCallDecision(worker, { toolName: "write", toolCallId: "s1", input: { path: "a", content: "b" } });
			assert.equal(directWrite?.block, true);
			const nestedWrite = await toolCallDecision(worker, { toolName: "write", toolCallId: "s2", parentToolCallId: "s0", input: { path: "a", content: "b" } });
			assert.equal(nestedWrite, null);
		});
	});
});

test("on-demand worker role recovery keeps codemode active", { timeout: 20000 }, async () => {
	await withOnDemand(async () => {
		await withFixture({}, async (fixture) => {
			const fakeMind = await fixture.startFakeMind();
			// No launcher/env role: session_start takes the legacy role-restore branch.
			const worker = await fixture.load("interactive", { activeTools: ["read", "bash"] });
			worker.ctx.sessionManager.getEntries = () => [
				{ type: "custom", customType: "mind-worker-role", data: { role: "worker", cwd: fixture.cwd } },
			];
			await worker.sessionStart();
			await fakeMind.next();
			assert.deepEqual(worker.pi.getActiveTools(), ["read", "bash", "codemode"], "recovery adds codemode for on-demand only");
			const blocked = await toolCallDecision(worker, { toolName: "bash", toolCallId: "r1", input: { command: "ls" } });
			assert.equal(blocked?.block, true);
		});
	});
});

test("legacy Workers keep their existing tools and are not blocked", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		const { worker } = await startWorker(fixture, { activeTools: ["read", "bash"] });
		assert.deepEqual(worker.pi.getActiveTools(), ["read", "bash"], "legacy adds no codemode");
		const prompt = await systemPromptFor(worker, fixture.cwd);
		assert.doesNotMatch(prompt, /Codemode only/);
		const directRead = await toolCallDecision(worker, { toolName: "read", toolCallId: "l1", input: { path: "a" } });
		assert.equal(directRead, null);
	});
});
