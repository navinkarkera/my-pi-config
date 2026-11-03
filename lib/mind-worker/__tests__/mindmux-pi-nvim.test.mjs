// mindmux-pi-nvim.test.mjs
//
// pi-nvim under a Go-managed Mind: the generic discovery surface is absent
// entirely. mindmux-host owns the private draft server, so publishing a second
// .sock/.info would make standalone discovery select a Mind it cannot submit to.
// No raw prompt path exists. Outside managed mode the legacy followUp behaviour
// and its info/latest discovery stay unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync, unlinkSync, symlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { waitUntil, withFixture } from "./support/fixture.mjs";
import { installPiResolver } from "./support/pi-resolver.mjs";

installPiResolver();

const NVIM_EXTENSION = new URL("../../../extensions/pi-nvim.ts", import.meta.url).href;
const SOCKETS_DIR = "/tmp/pi-nvim-sockets";
const LATEST_LINK = "/tmp/pi-nvim-latest.sock";
const MINDMUX_KEYS = ["MINDMUX_ADAPTER_SOCKET", "MINDMUX_MANIFEST", "MINDMUX_GENERATION", "MINDMUX_SESSION_ID"];

function nvimSocketPath(cwd, label) {
	const hash = createHash("md5").update(cwd).digest("hex").slice(0, 12);
	const base = hash + "-" + process.pid + ".sock";
	return join(SOCKETS_DIR, label ? label + "-" + base : base);
}

function join(dir, name) {
	return dir.replace(/\/$/, "") + "/" + name;
}

/** Headless pi API: only the pieces pi-nvim touches. */
function fakePi() {
	const handlers = new Map();
	const sent = [];
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
			return () => {};
		},
		registerCommand() {},
		sendUserMessage(content, options) {
			sent.push([content, options]);
		},
	};
	return { pi, handlers, sent };
}

function request(socketPath, payload, tag) {
	return new Promise((resolve, reject) => {
		const conn = createConnection(socketPath);
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("error", reject);
		conn.on("connect", () => conn.write(JSON.stringify(payload) + "\n"));
		conn.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			conn.destroy();
			resolve(JSON.parse(buffer.split("\n")[0]));
		});
	});
}

test("a Go-managed Mind publishes no generic pi-nvim socket, info, or latest", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		Object.assign(process.env, {
			MINDMUX_ADAPTER_SOCKET: "/run/mindmux/k/adapter.sock",
			MINDMUX_MANIFEST: "/state/mindmux/sessions/k.json",
			MINDMUX_GENERATION: "42",
			PI_MIND_WORKER_INSTANCE: "mx-g42",
		});
		const before = existsSync(LATEST_LINK) ? readlinkSync(LATEST_LINK) : null;
		const legacySocket = nvimSocketPath(fixture.cwd, null);
		const namespacedSocket = nvimSocketPath(fixture.cwd, "mx-g42");
		const { pi, handlers, sent } = fakePi();
		const module = await import(NVIM_EXTENSION + "?managed=1");
		module.default(pi);
		try {
			await handlers.get("session_start")({}, { mode: "tui", cwd: fixture.cwd, ui: { notify() {} } });

			// No generic socket or discovery manifest exists, so there is no raw
			// prompt path to refuse: absence is stricter than an error response.
			assert.equal(existsSync(legacySocket), false, "managed Mind published a legacy socket");
			assert.equal(existsSync(namespacedSocket), false, "managed Mind published a namespaced socket");
			assert.equal(existsSync(legacySocket + ".info"), false, "managed Mind published legacy info");
			assert.equal(existsSync(namespacedSocket + ".info"), false, "managed Mind published namespaced info");
			const infosForCwd = existsSync(SOCKETS_DIR)
				? readdirSync(SOCKETS_DIR).filter((name) => name.endsWith(".info")).filter((name) => {
					try { return JSON.parse(readFileSync(join(SOCKETS_DIR, name), "utf8")).cwd === fixture.cwd; }
					catch { return false; }
				})
				: [];
			assert.deepEqual(infosForCwd, [], "managed Mind advertised itself for discovery");
			assert.deepEqual(sent, [], "no user message may be submitted for a Go-managed Mind");

			await assert.rejects(
				request(legacySocket, { type: "prompt", message: "please run the tests" }),
				/ENOENT|ECONNREFUSED/,
				"there must be no direct managed prompt path",
			);
			await assert.rejects(request(legacySocket, { type: "ping" }), /ENOENT|ECONNREFUSED/);

			const after = existsSync(LATEST_LINK) ? readlinkSync(LATEST_LINK) : null;
			assert.equal(after, before, "the shared latest pointer is untouched");
		} finally {
			await handlers.get("session_shutdown")();
			for (const key of MINDMUX_KEYS) delete process.env[key];
			delete process.env.PI_MIND_WORKER_INSTANCE;
		}
	});
});

test("outside managed mode standalone Pi keeps its socket, info, latest, and followUp prompt", { timeout: 20000 }, async () => {
	await withFixture({}, async (fixture) => {
		for (const key of MINDMUX_KEYS) delete process.env[key];
		delete process.env.PI_MIND_WORKER_INSTANCE;
		const before = existsSync(LATEST_LINK) ? readlinkSync(LATEST_LINK) : null;
		const socketPath = nvimSocketPath(fixture.cwd, null);
		const { pi, handlers, sent } = fakePi();
		const module = await import(NVIM_EXTENSION + "?standalone=1");
		module.default(pi);
		try {
			await handlers.get("session_start")({}, { mode: "tui", cwd: fixture.cwd, ui: { notify() {} } });
			await waitUntil(() => existsSync(socketPath), { timeout: 5000, label: "legacy pi-nvim socket" });
			await waitUntil(() => existsSync(socketPath + ".info"), { timeout: 5000, label: "legacy pi-nvim info" });

			const info = JSON.parse(readFileSync(socketPath + ".info", "utf8"));
			assert.equal(info.cwd, fixture.cwd, "standalone info advertises its cwd");
			assert.equal(info.pid, process.pid, "standalone info advertises its pid");
			assert.equal(readlinkSync(LATEST_LINK), socketPath, "standalone updates latest");

			assert.deepEqual(await request(socketPath, { type: "prompt", message: "hello" }), { ok: true });
			assert.deepEqual(sent, [["hello", { deliverAs: "followUp" }]], "the legacy path still submits as a follow-up");
		} finally {
			await handlers.get("session_shutdown")();
			if (existsSync(socketPath)) unlinkSync(socketPath);
			// Restore the shared pointer this legacy run moved.
			try {
				if (before && existsSync(before)) {
					if (existsSync(LATEST_LINK)) unlinkSync(LATEST_LINK);
					symlinkSync(before, LATEST_LINK);
				} else if (existsSync(LATEST_LINK)) {
					unlinkSync(LATEST_LINK);
				}
			} catch { /* best effort: never leave the pointer broken */ }
		}
	});
});
