// mindmux-host.test.mjs
//
// The Go adapter seam on its own: the namespace rule that keeps two sessions in
// one cwd apart, the NDJSON client (one request, one reply, bounded), and the
// insert-only draft socket. Nothing here touches tmux, hc, a Go binary or a model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendEditorDraft,
	createMindmuxClient,
	instanceLabel,
	kindForCode,
	MindmuxError,
	mindmuxEnvProblem,
	readMindmuxEnv,
	scopedTaskId,
	startDraftSocket,
} from "../mindmux-host.mjs";

const GO_ENV = (overrides = {}) => ({
	MINDMUX_ADAPTER_SOCKET: "/run/mindmux/k/adapter.sock",
	MINDMUX_MANIFEST: "/state/mindmux/sessions/k.json",
	MINDMUX_CONTROL_FILE: "/run/mindmux/k/control.json",
	MINDMUX_DRAFT_SOCKET: "/run/mindmux/k/draft.sock",
	MINDMUX_GENERATION: "42",
	MINDMUX_SESSION_ID: "$3",
	...overrides,
});

function tempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** One connection, one line out, one reply line back. */
function sendLine(socketPath, payload) {
	return new Promise((resolve, reject) => {
		const conn = createConnection(socketPath);
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("error", reject);
		conn.on("connect", () => conn.write(payload + "\n"));
		conn.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			conn.destroy();
			resolve(JSON.parse(buffer.slice(0, newline)));
		});
	});
}

test("the adapter mode is only the explicit pair, and half a pair is reported", () => {
	assert.equal(readMindmuxEnv({}), null);
	assert.equal(readMindmuxEnv({ MINDMUX_ADAPTER_SOCKET: "/a.sock" }), null);
	assert.equal(readMindmuxEnv({ MINDMUX_ADAPTER_SOCKET: "/a.sock", MINDMUX_MANIFEST: "relative.json" }), null);
	assert.match(mindmuxEnvProblem({ MINDMUX_ADAPTER_SOCKET: "/a.sock" }), /must both be set/);
	assert.equal(mindmuxEnvProblem({}), null);
	assert.equal(mindmuxEnvProblem(GO_ENV()), null);
	const env = readMindmuxEnv(GO_ENV());
	assert.equal(env.generation, 42);
	assert.equal(env.sessionId, "$3");
	assert.equal(env.draftSocket, "/run/mindmux/k/draft.sock");
});

test("two sessions in one cwd derive different task ids; the legacy path is unchanged", () => {
	const cwd = "/home/navin/project";
	// No opt-in and no label: the legacy cwd hash, byte for byte.
	assert.equal(scopedTaskId(cwd, {}), scopedTaskId(cwd, { OTHER: "x" }));
	assert.match(scopedTaskId(cwd, {}), /^[0-9a-f]{16}$/);
	const genA = scopedTaskId(cwd, GO_ENV({ MINDMUX_GENERATION: "1" }));
	const genB = scopedTaskId(cwd, GO_ENV({ MINDMUX_GENERATION: "2" }));
	assert.notEqual(genA, genB, "same cwd, different session/generation must not share a path");
	assert.match(genA, /^mx-g1-[0-9a-f]{16}$/);
	// An explicit shared label wins, and an unsanitary label cannot escape the state dir.
	assert.equal(instanceLabel({ PI_MIND_WORKER_INSTANCE: "s1-g7" }), "s1-g7");
	assert.equal(instanceLabel({ PI_MIND_WORKER_INSTANCE: "../../etc" }), ".._.._etc");
	assert.match(scopedTaskId(cwd, { MINDMUX_SESSION_KEY: "s9-g3" }), /^s9-g3-[0-9a-f]{16}$/);
});

test("declared Go codes map to the retirement vocabulary, unknown stays unavailable", () => {
	assert.equal(kindForCode("not_owned"), "not_owned");
	assert.equal(kindForCode("not_found"), "not_owned");
	assert.equal(kindForCode("stale_generation"), "core_mismatch");
	assert.equal(kindForCode("generation_mismatch"), "core_mismatch");
	assert.equal(kindForCode("whatever"), "unavailable");
	const err = new MindmuxError("x", { code: "not_found" });
	assert.equal(err.kind, "not_owned");
	assert.equal(err.spawnPending, undefined);
	assert.equal(new MindmuxError("x", { code: "boom", spawnUnconfirmed: true }).spawnPending, true);
});

test("the client speaks ready/spawn/retire/list on the adapter socket", async () => {
	const dir = tempDir("mindmux-client-");
	const socketPath = join(dir, "adapter.sock");
	const seen = [];
	const server = createServer((conn) => {
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const request = JSON.parse(buffer.slice(0, newline));
			seen.push(request);
			const reply = request.op === "list"
				? { ok: true, workers: [{ pane: "%7", worker_id: "burst-flash-1" }] }
				: request.op === "spawn" ? { ok: true, pane: "%7" } : { ok: true };
			conn.write(JSON.stringify(reply) + "\n");
		});
	});
	await new Promise((resolve) => server.listen(socketPath, resolve));
	try {
		const client = createMindmuxClient({
			MINDMUX_ADAPTER_SOCKET: socketPath,
			MINDMUX_MANIFEST: join(dir, "s.json"),
			MINDMUX_GENERATION: "5",
		});
		assert.deepEqual(await client.ready("/run/k/draft.sock"), { ok: true });
		assert.deepEqual(
			await client.spawn({ workerId: "burst-flash-1", tier: "flash", model: "vendor/model", thinking: "max", sessionDir: "/tmp/sd" }),
			{ ok: true, pane: "%7" },
		);
		assert.deepEqual(await client.list(), { ok: true, workers: [{ pane: "%7", worker_id: "burst-flash-1" }] });
		assert.deepEqual(await client.retire("%7"), { ok: true });
		assert.deepEqual(seen, [
			{ op: "ready", draft_socket: "/run/k/draft.sock" },
			{ op: "spawn", worker_id: "burst-flash-1", tier: "flash", model: "vendor/model", thinking: "max", session_dir: "/tmp/sd" },
			{ op: "list" },
			{ op: "retire", pane: "%7" },
		]);
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Go error reply is an error with its code, never a success", async () => {
	const dir = tempDir("mindmux-err-");
	const socketPath = join(dir, "adapter.sock");
	const server = createServer((conn) => {
		conn.on("data", () => conn.write(JSON.stringify({ ok: false, error: "pane belongs to another pool", code: "not_owned" }) + "\n"));
	});
	await new Promise((resolve) => server.listen(socketPath, resolve));
	try {
		const client = createMindmuxClient({ MINDMUX_ADAPTER_SOCKET: socketPath, MINDMUX_MANIFEST: join(dir, "s.json") });
		await assert.rejects(client.retire("%7"), (err) => {
			assert.equal(err.code, "not_owned");
			assert.equal(err.kind, "not_owned");
			assert.match(err.message, /another pool/);
			return true;
		});
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unreachable adapter is unavailable; a spawn whose reply is lost is unconfirmed", async () => {
	// No socket at all: nothing was written, so nothing can have been created.
	const gone = createMindmuxClient(
		{ MINDMUX_ADAPTER_SOCKET: "/nonexistent/dir/adapter.sock", MINDMUX_MANIFEST: "/nonexistent/dir/s.json" },
		{ timeoutMs: 500 },
	);
	await assert.rejects(gone.list(), (err) => {
		assert.equal(err.kind, "unavailable");
		assert.equal(err.spawnPending, undefined);
		return true;
	});

	// A socket that dies after the request was written: the worker may exist.
	const dir = tempDir("mindmux-died-");
	const socketPath = join(dir, "adapter.sock");
	const server = createServer((conn) => {
		conn.on("data", () => conn.destroy());
	});
	await new Promise((resolve) => server.listen(socketPath, resolve));
	try {
		const dying = createMindmuxClient(
			{ MINDMUX_ADAPTER_SOCKET: socketPath, MINDMUX_MANIFEST: join(dir, "s.json") },
			{ timeoutMs: 500 },
		);
		await assert.rejects(
			dying.spawn({ workerId: "w", tier: "flash", model: "m", thinking: "max", sessionDir: "/tmp" }),
			(err) => {
				assert.equal(err.spawnPending, true);
				assert.equal(err.kind, "unavailable");
				return true;
			},
		);
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the draft socket appends with a blank line, acks after the update and never submits", async () => {
	const dir = tempDir("mindmux-draft-");
	const socketPath = join(dir, "runtime", "draft.sock");
	let editor = "";
	const updates = [];
	const ui = {
		getEditorText: () => editor,
		setEditorText: (text) => { editor = text; updates.push(text); },
	};
	const draft = await startDraftSocket({ socketPath, append: (text) => appendEditorDraft(ui, text) });
	try {
		// Private by construction: the socket is 0600 and its directory is created 0700.
		assert.equal(statSync(socketPath).mode & 0o777, 0o600);
		assert.equal(statSync(join(dir, "runtime")).mode & 0o777, 0o700);

		assert.deepEqual(
			await sendLine(socketPath, JSON.stringify({ op: "append", text: "src/a.ts:1-3\nexact\nlines" })),
			{ ok: true },
		);
		assert.equal(editor, "src/a.ts:1-3\nexact\nlines", "the first append fills an empty draft");
		assert.deepEqual(await sendLine(socketPath, JSON.stringify({ op: "append", text: "second" })), { ok: true });
		assert.equal(editor, "src/a.ts:1-3\nexact\nlines\n\nsecond", "a later append is separated by one blank line");
		assert.equal(updates.length, 2);

		assert.deepEqual(await sendLine(socketPath, "not json at all"), { ok: false, error: "malformed JSON frame" });
		assert.deepEqual(await sendLine(socketPath, JSON.stringify({ op: "submit", text: "x" })), {
			ok: false,
			error: "unsupported op: submit",
		});
		assert.deepEqual(await sendLine(socketPath, JSON.stringify({ op: "append", text: "" })), {
			ok: false,
			error: "append needs non-empty text",
		});
		// Text is verbatim, so a payload that happens to carry an escape is not rewritten.
		assert.deepEqual(await sendLine(socketPath, JSON.stringify({ op: "append", text: "\u001b[31mred" })), { ok: true });
	} finally {
		draft.close();
		assert.equal(existsSync(socketPath), false, "close removes its own socket");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an existing draft and the new text are kept byte-for-byte, never trimmed", () => {
	const cases = [
		["", "first", "first"],
		["   ", "first", "   \n\nfirst"],
		["\n\n", "first", "\n\n\n\nfirst"],
		["keep  \t", "first", "keep  \t\n\nfirst"],
		["keep\n\n", "first", "keep\n\n\n\nfirst"],
		["keep\r\n", "first", "keep\r\n\n\nfirst"],
		["draft one\nline two", "second\n\nblock\n", "draft one\nline two\n\nsecond\n\nblock\n"],
	];
	for (const [before, text, expected] of cases) {
		let editor = before;
		const writes = [];
		const ui = {
			getEditorText: () => editor,
			setEditorText: (next) => { editor = next; writes.push(next); },
		};
		assert.equal(appendEditorDraft(ui, text), expected, JSON.stringify({ before, text }));
		assert.equal(editor, expected, "the editor holds the append result verbatim");
		assert.equal(writes.length, 1, "one write, no submit");
	}
});

test("a second append preserves the first payload exactly", () => {
	const first = "src/a.ts:1-3\nexact lines  \n";
	const second = "  second\n\tblock\r\n";
	let editor = "";
	const ui = {
		getEditorText: () => editor,
		setEditorText: (next) => { editor = next; },
	};
	appendEditorDraft(ui, first);
	assert.equal(editor, first, "the first payload is exact");
	appendEditorDraft(ui, second);
	assert.equal(editor, first + "\n\n" + second, "the first payload is untouched, the second is exact");
});

test("a missing editor getter is an error, never a replaced draft", () => {
	const writes = [];
	const setEditorText = (next) => writes.push(next);
	assert.throws(() => appendEditorDraft({ setEditorText }, "x"), /getEditorText/);
	assert.throws(() => appendEditorDraft({ getEditorText: "nope", setEditorText }, "x"), /getEditorText/);
	assert.throws(() => appendEditorDraft({ getEditorText: () => 7, setEditorText }, "x"), /string draft/);
	assert.deepEqual(writes, [], "nothing was written over an unknown draft");
});

test("a failing append is answered as an error, so the sender keeps the selection", async () => {
	const dir = tempDir("mindmux-draft-fail-");
	const socketPath = join(dir, "draft.sock");
	let attempts = 0;
	const draft = await startDraftSocket({
		socketPath,
		append: () => {
			attempts += 1;
			throw new Error("editor is not accepting text");
		},
	});
	try {
		assert.deepEqual(await sendLine(socketPath, JSON.stringify({ op: "append", text: "x" })), {
			ok: false,
			error: "editor is not accepting text",
		});
		assert.equal(attempts, 1, "no automatic retry");
	} finally {
		draft.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unbounded frame is refused instead of buffered forever", async () => {
	const dir = tempDir("mindmux-draft-big-");
	const socketPath = join(dir, "draft.sock");
	let appended = 0;
	const draft = await startDraftSocket({ socketPath, append: () => { appended += 1; } });
	try {
		const oversized = JSON.stringify({ op: "append", text: "a".repeat(300 * 1024) });
		const reply = await sendLine(socketPath, oversized);
		assert.deepEqual(reply, { ok: false, error: "frame is too large" });
		assert.equal(appended, 0, "an oversized append never reaches the editor");
	} finally {
		draft.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two appends on one connection are applied in order", async () => {
	const dir = tempDir("mindmux-draft-order-");
	const socketPath = join(dir, "draft.sock");
	let editor = "";
	const draft = await startDraftSocket({
		socketPath,
		append: async (text) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			editor = editor ? editor + "\n\n" + text : text;
		},
	});
	try {
		const replies = await new Promise((resolve, reject) => {
			const conn = createConnection(socketPath);
			let buffer = "";
			const seen = [];
			conn.setEncoding("utf8");
			conn.on("error", reject);
			conn.on("connect", () => {
				conn.write(JSON.stringify({ op: "append", text: "one" }) + "\n");
				conn.write(JSON.stringify({ op: "append", text: "two" }) + "\n");
			});
			conn.on("data", (chunk) => {
				buffer += chunk;
				let newline;
				while ((newline = buffer.indexOf("\n")) !== -1) {
					seen.push(JSON.parse(buffer.slice(0, newline)));
					buffer = buffer.slice(newline + 1);
				}
				if (seen.length === 2) {
					conn.destroy();
					resolve(seen);
				}
			});
		});
		assert.deepEqual(replies, [{ ok: true }, { ok: true }]);
		assert.equal(editor, "one\n\ntwo");
	} finally {
		draft.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stale file at the draft path does not stop the listener", async () => {
	const dir = tempDir("mindmux-draft-stale-");
	const socketPath = join(dir, "draft.sock");
	writeFileSync(socketPath, "");
	const draft = await startDraftSocket({ socketPath, append: () => {} });
	try {
		assert.deepEqual(await sendLine(socketPath, JSON.stringify({ op: "append", text: "ok" })), { ok: true });
	} finally {
		draft.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
