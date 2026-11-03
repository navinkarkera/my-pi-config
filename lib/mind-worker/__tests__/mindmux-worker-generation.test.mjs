// mindmux-worker-generation.test.mjs
//
// The worker half of the Go adapter: the generation a worker handshakes with is
// the one the launcher passed, not whatever an old record on disk says, and the
// socket it connects to is namespaced by the same session+generation label. A
// stale v3 record in the state dir must change nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { waitUntil, withFixture } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

const MINDMUX_KEYS = ["MINDMUX_ADAPTER_SOCKET", "MINDMUX_MANIFEST", "MINDMUX_GENERATION", "MINDMUX_SESSION_ID"];

test("a worker handshakes with the generation it was passed, not the stale record", { timeout: 20000 }, async () => {
	// The fixture writes a v3-style v2/hc record with generation 1.
	await withFixture({ generation: 1 }, async (fixture) => {
		const label = "mx-g7";
		process.env.PI_MIND_WORKER_INSTANCE = label;
		for (const key of MINDMUX_KEYS) delete process.env[key];
		const hash = createHash("sha256").update(fixture.cwd).digest("hex").slice(0, 16);
		const socketPath = join(fixture.stateDir, label + "-" + hash + ".sock");

		const frames = [];
		const server = createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				buffer += chunk;
				let newline;
				while ((newline = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) frames.push(JSON.parse(line));
				}
			});
		});
		await new Promise((resolve) => server.listen(socketPath, resolve));
		fixture.servers.push(server);

		try {
			// The record on disk still says generation 1: the worker must not read it.
			const recordPath = join(fixture.stateDir, fixture.hash + "-manifest.json");
			assert.equal(JSON.parse(readFileSync(recordPath, "utf8")).generation, 1);

			const worker = await fixture.load("worker", { workerId: "burst-flash-1", tier: "flash", generation: 7 });
			await worker.sessionStart();
			await waitUntil(() => frames.some((frame) => frame.type === "handshake"), {
				timeout: 5000,
				label: "handshake frame",
			});

			const handshake = frames.find((frame) => frame.type === "handshake");
			assert.equal(handshake.generation, 7, "the passed generation is authoritative");
			assert.equal(handshake.role, "worker");
			assert.equal(handshake.workerId, "burst-flash-1");
			assert.equal(handshake.tier, "flash");
			// It found the namespaced socket, not the legacy cwd-hash path.
			assert.notEqual(socketPath, join(fixture.stateDir, fixture.hash + ".sock"));

			await worker.sessionShutdown("quit");
		} finally {
			delete process.env.PI_MIND_WORKER_INSTANCE;
			writeFileSync(join(fixture.stateDir, fixture.hash + "-manifest.json"), JSON.stringify({ schemaVersion: 2, terminalBackend: "hc" }));
		}
	});
});
