// thinking-level.test.mjs
//
// The split config field shared by the extension and both launchers:
// resolveThinkingLevel() accepts exactly Pi's seven levels and otherwise returns
// the fallback (undefined = "leave it to Pi" for Mind, "max" for workers).

import { test } from "node:test";
import assert from "node:assert/strict";
import { THINKING_LEVELS, resolveThinkingLevel } from "../thinking-level.mjs";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

test("the level list matches Pi's seven levels in order", () => {
	assert.deepEqual([...THINKING_LEVELS], LEVELS);
});

test("every valid level is returned unchanged", () => {
	for (const level of LEVELS) assert.equal(resolveThinkingLevel(level), level);
});

test("an absent or unusable value yields the fallback, which defaults to undefined", () => {
	const invalid = [undefined, null, "", " high", "high ", "HIGH", "ultra", "max ", 0, 1, true, {}, ["high"], { level: "high" }];
	for (const value of invalid) {
		assert.equal(resolveThinkingLevel(value), undefined, "no fallback for " + JSON.stringify(value));
		assert.equal(resolveThinkingLevel(value, "max"), "max", "fallback for " + JSON.stringify(value));
	}
});

test("a caller-supplied fallback is returned only when the value is unusable", () => {
	assert.equal(resolveThinkingLevel("low", "max"), "low");
	assert.equal(resolveThinkingLevel("off", "max"), "off");
	assert.equal(resolveThinkingLevel("nope", undefined), undefined);
});
