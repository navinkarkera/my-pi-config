// fixture-harness.test.mjs — the fake hc must outlive the fixture that installed it.
//
// A burst timer can fire after cleanup(): it still carries the fixture's PATH
// snapshot. While the shim lived inside the fixture root, cleanup() deleted it,
// the lookup fell through to the real hc binary, and that binary daemonized a
// core in the user's runtime dir and recreated $HOME/.local/state under the
// deleted /tmp fixture root — one leaked core and one resurrected dir per call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { createFixture } from "./support/fixture.mjs";

test("the fake hc survives cleanup, so a late spawn cannot reach a real core", async () => {
	const fixture = await createFixture({});
	const hc = fixture.installFakeHc();
	assert.notEqual(dirname(hc.shimPath), fixture.root, "the shim must live outside the deleted fixture root");
	await fixture.cleanup();
	assert.equal(existsSync(fixture.root), false, "cleanup removes the fixture root");
	assert.equal(existsSync(hc.shimPath), true, "the shim survives it");

	const status = spawnSync(hc.shimPath, ["server", "status", "--json"], { encoding: "utf8", env: process.env });
	assert.equal(status.status, 0, status.stderr);
	assert.equal(JSON.parse(status.stdout).core.id, fixture.coreId);
});

test("every fixture puts the fake hc first on PATH before any extension loads", async () => {
	const fixture = await createFixture({});
	try {
		const hc = fixture.installFakeHc();
		assert.equal(process.env.PATH.split(":")[0], dirname(hc.shimPath));
	} finally {
		await fixture.cleanup();
	}
});
