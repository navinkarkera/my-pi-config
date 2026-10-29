// pi-nvim mode gating. All net/fs calls are mocked; nothing under /tmp/pi-nvim* is
// created.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs"; // real bindings, bound BEFORE mock.module
import { tmpdir } from "node:os";
import { join } from "node:path";

let h; // fresh per-test harness: recorded calls, fake server, fake connection

mock.module("node:net", {
	exports: {
		createServer(onConnection) {
			h.onConnection = onConnection;
			h.calls.push(["createServer"]);
			return h.server;
		},
	},
});
mock.module("node:fs", {
	exports: {
		mkdirSync: (...a) => h.calls.push(["mkdirSync", ...a]),
		unlinkSync: (...a) => h.calls.push(["unlinkSync", ...a]),
		symlinkSync: (...a) => h.calls.push(["symlinkSync", ...a]),
		writeFileSync: (...a) => h.calls.push(["writeFileSync", ...a]),
		// MUST record: cleanup asserts on it, and the returned target decides the latest-link unlink.
		readlinkSync: (...a) => {
			h.calls.push(["readlinkSync", ...a]);
			return h.readlink;
		},
	},
});

const dir = mkdtempSync(join(tmpdir(), "pi-nvim-mode-")); // real fs: test setup only
after(() => rmSync(dir, { recursive: true, force: true }));
const factory = (await import("../../../extensions/pi-nvim.ts")).default; // after the mocks

function load(t) {
	h = {
		calls: [],
		sends: [],
		readlink: "",
		onConnection: undefined,
		server: {
			on() {},
			listen(p, cb) {
				h.calls.push(["listen", p]);
				cb?.();
			},
			close() {
				h.calls.push(["close"]);
			},
		},
		conn: {
			write: (c) => h.calls.push(["conn.write", c]),
			on(n, fn) {
				if (n === "data") h.conn.onData = fn;
			},
		},
	};
	const handlers = new Map(),
		commands = new Map(),
		before = process.listeners("exit");
	const pi = {
		on: (n, fn) => handlers.set(n, fn),
		registerCommand: (n, o) => commands.set(n, o),
		sendUserMessage: (...a) => h.sends.push(a),
	};
	factory(pi);
	for (const l of process.listeners("exit")) if (!before.includes(l)) t.after(() => process.removeListener("exit", l));
	return { handlers, commands };
}

const ctxFor = (mode) => ({
	mode,
	cwd: dir,
	hasUI: mode === "tui",
	ui: { notify: (...a) => h.calls.push(["notify", ...a]) },
	reload: async () => h.calls.push(["reload"]),
});

test("json and rpc start no socket and no fs work", async (t) => {
	const { handlers } = load(t);
	// Canary: mock.module really intercepts node:fs for the extension.
	assert.equal((await import("node:fs")).readlinkSync("/tmp/pi-nvim-latest.sock"), "");
	assert.deepEqual(h.calls, [["readlinkSync", "/tmp/pi-nvim-latest.sock"]]);
	h.calls.length = 0;
	for (const mode of ["json", "rpc"]) {
		await handlers.get("session_start")({}, ctxFor(mode));
		assert.deepEqual(h.calls, [], `${mode} mode must not start a socket`);
	}
});

test("print mode stays inert", async (t) => {
	const { handlers } = load(t);
	await handlers.get("session_start")({}, ctxFor("print"));
	assert.deepEqual(h.calls, []);
});

test("tui startup creates socket, symlink and manifest", async (t) => {
	const { handlers } = load(t);
	await handlers.get("session_start")({}, ctxFor("tui"));

	const listen = h.calls.find(([name]) => name === "listen");
	assert.ok(listen, "server must listen");
	const socketPath = listen[1];
	assert.match(socketPath, /^\/tmp\/pi-nvim-sockets\/[0-9a-f]{12}-\d+\.sock$/);
	assert.ok(h.calls.some(([name]) => name === "mkdirSync"), "sockets dir created");
	assert.ok(h.calls.some(([name]) => name === "createServer"), "server created");
	assert.ok(
		h.calls.some(([name, target, link]) => name === "symlinkSync" && target === socketPath && link === "/tmp/pi-nvim-latest.sock"),
		"latest symlink points at the socket",
	);
	assert.ok(
		h.calls.some(([name, file]) => name === "writeFileSync" && file === socketPath + ".info"),
		"manifest written",
	);
});

test("tui prompt sends, acks and writes the escape once", async (t) => {
	const { handlers } = load(t);
	await handlers.get("session_start")({}, ctxFor("tui"));
	h.onConnection(h.conn);

	const writes = [];
	const realWrite = process.stdout.write;
	process.stdout.write = (chunk) => {
		writes.push(String(chunk));
		return true;
	};
	try {
		h.conn.onData('{"type":"prompt","message":"hello"}\n');
	} finally {
		process.stdout.write = realWrite;
	}

	assert.deepEqual(h.sends, [["hello", { deliverAs: "followUp" }]]);
	const connWrites = h.calls.filter(([name]) => name === "conn.write");
	assert.deepEqual(connWrites, [["conn.write", '{"ok":true}\n']]);
	assert.deepEqual(writes, ["\x1b[?1049h\x1b[?1049l"]);
});

test("headless restart and shutdown do nothing", async (t) => {
	for (const mode of ["json", "rpc", "print"]) {
		const { handlers, commands } = load(t);
		await commands.get("pi-nvim-restart").handler(undefined, ctxFor(mode));
		await handlers.get("session_shutdown")();
		assert.deepEqual(h.calls, [], `${mode} mode must stay inert`);
	}
});

test("tui shutdown cleans up socket, checks symlink, removes manifest", async (t) => {
	const { handlers } = load(t);
	await handlers.get("session_start")({}, ctxFor("tui"));
	const socketPath = h.calls.find(([name]) => name === "listen")[1];
	h.calls.length = 0;

	await handlers.get("session_shutdown")();

	const unlinks = h.calls.filter(([name]) => name === "unlinkSync").map(([, p]) => p);
	assert.equal(unlinks.filter((p) => p === socketPath).length, 1, "socket removed once");
	assert.equal(unlinks.filter((p) => p === socketPath + ".info").length, 1, "manifest removed once");
	assert.ok(!unlinks.includes("/tmp/pi-nvim-latest.sock"), "latest link untouched when it is not ours");
	assert.deepEqual(
		h.calls.filter(([name]) => name === "readlinkSync"),
		[["readlinkSync", "/tmp/pi-nvim-latest.sock"]],
	);
	assert.ok(h.calls.some(([name]) => name === "close"), "server closed");
});
