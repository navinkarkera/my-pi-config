// mindmux-host.mjs
//
// The thin Pi side of the Go mindmux adapter, which is the only host. It performs
// no routing and no supervision: it speaks the adapter's NDJSON contract (one JSON
// request per line, one JSON reply per line: ready/spawn/retire/list) on the socket
// Go listens on, and serves the insert-only draft socket that mindmux send
// connects to.
//
// Everything here is inert unless MINDMUX_ADAPTER_SOCKET and MINDMUX_MANIFEST are
// both set. The ops and their error codes are defined by the Go adapter.

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";

/** A request that never answers must not wedge a spawn or a retirement sweep. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** One append may be large (a quickfix list); it may not be unbounded. */
const MAX_DRAFT_FRAME_BYTES = 256 * 1024;
const MAX_DRAFT_BUFFER_BYTES = 1024 * 1024;

function cleanText(value) {
	return typeof value === "string" && value.trim() && !/[\0\n\r]/.test(value) ? value.trim() : null;
}

function positiveInt(value) {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * A file-name-safe namespace label. A label that would escape the state dir is
 * refused rather than silently creating a nested path.
 */
function sanitizeLabel(label) {
	const trimmed = typeof label === "string" ? label.trim() : "";
	if (!trimmed) return null;
	if (/^[A-Za-z0-9._-]{1,96}$/.test(trimmed)) return trimmed;
	const replaced = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 96);
	return replaced || null;
}

/**
 * The explicit Go opt-in: an adapter socket and a manifest path, both absolute.
 * Half a pair is not a mode; it is a misconfiguration the caller reports.
 */
export function readMindmuxEnv(env = process.env) {
	const adapterSocket = cleanText(env.MINDMUX_ADAPTER_SOCKET);
	const manifestPath = cleanText(env.MINDMUX_MANIFEST);
	if (!adapterSocket || !manifestPath) return null;
	if (!adapterSocket.startsWith("/") || !manifestPath.startsWith("/")) return null;
	return {
		adapterSocket,
		manifestPath,
		controlFile: cleanText(env.MINDMUX_CONTROL_FILE),
		draftSocket: cleanText(env.MINDMUX_DRAFT_SOCKET),
		generation: positiveInt(env.MINDMUX_GENERATION ?? env.PI_MIND_WORKER_GENERATION) ?? 0,
		sessionId: cleanText(env.MINDMUX_SESSION_ID),
		instance: sanitizeLabel(cleanText(env.PI_MIND_WORKER_INSTANCE) ?? cleanText(env.MINDMUX_SESSION_KEY) ?? ""),
	};
}

/** True when only one half of the pair is set: the caller warns instead of guessing. */
export function mindmuxEnvProblem(env = process.env) {
	const adapter = cleanText(env.MINDMUX_ADAPTER_SOCKET);
	const manifest = cleanText(env.MINDMUX_MANIFEST);
	if (!adapter && !manifest) return null;
	if (adapter && manifest) return null;
	return "MINDMUX_ADAPTER_SOCKET and MINDMUX_MANIFEST must both be set; ignoring a half-set mindmux env";
}

/**
 * The shared namespace label: Mind and every worker must derive the same one, or
 * a worker cannot find its Mind socket. The launcher --instance flag is the legacy
 * carrier; Go passes the same value to both sides. Without any label the legacy
 * plain cwd hash is kept, so no old path moves.
 */
export function instanceLabel(env = process.env) {
	const explicit = sanitizeLabel(cleanText(env.PI_MIND_WORKER_INSTANCE) ?? cleanText(env.MINDMUX_SESSION_KEY) ?? "");
	if (explicit) return explicit;
	const mx = readMindmuxEnv(env);
	// Generation is unique per start, so it isolates sessions sharing a cwd and it
	// fences a force-orphan of an older generation. See the contract note: Go must
	// pass the same label to every worker, otherwise only Mind is namespaced.
	if (mx && mx.generation > 0) return "mx-g" + mx.generation;
	return null;
}

/** One rule for every derived path: label-cwdHash, or the legacy plain cwd hash. */
export function scopedTaskId(cwd, env = process.env) {
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const label = instanceLabel(env);
	return label ? label + "-" + hash : hash;
}

/** Go error code, mapped once into the vocabulary the retirement driver reads. */
export function kindForCode(code) {
	switch (code) {
		case "not_owned":
		case "not_found":
		case "pane_not_owned":
		case "pane_missing":
			return "not_owned";
		case "stale_generation":
		case "generation_mismatch":
		case "stale":
		case "replaced":
			return "core_mismatch";
		default:
			return "unavailable";
	}
}

export class MindmuxError extends Error {
	constructor(message, options = {}) {
		super(message);
		this.name = "MindmuxError";
		this.code = options.code ?? "unavailable";
		this.kind = kindForCode(this.code);
		/** The request may have reached Go: a spawn must be reconciled, not retried. */
		if (options.spawnUnconfirmed) this.spawnPending = true;
	}
}

/** One request per line, one reply per line, one connection per request. */
function mindmuxRequest(socketPath, request, timeoutMs) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let buffer = "";
		let wrote = false;
		const timer = setTimeout(() => {
			finish(reject, new MindmuxError("adapter request timed out after " + timeoutMs + "ms", {
				code: "unavailable",
				spawnUnconfirmed: request.op === "spawn" && wrote,
			}));
		}, timeoutMs);
		timer.unref?.();
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket.destroy(); } catch { /* ignore */ }
			fn(value);
		};

		socket.setEncoding("utf8");
		socket.on("error", (err) => {
			finish(reject, new MindmuxError("adapter socket error: " + err.message, {
				code: "unavailable",
				spawnUnconfirmed: request.op === "spawn" && wrote,
			}));
		});
		socket.on("close", () => {
			finish(reject, new MindmuxError("adapter closed before replying", {
				code: "unavailable",
				spawnUnconfirmed: request.op === "spawn" && wrote,
			}));
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) {
				if (buffer.length > MAX_DRAFT_BUFFER_BYTES) {
					finish(reject, new MindmuxError("adapter reply is unbounded", { code: "unavailable" }));
				}
				return;
			}
			const line = buffer.slice(0, newline).trim();
			let reply;
			try {
				reply = JSON.parse(line);
			} catch {
				finish(reject, new MindmuxError("adapter reply is not JSON", { code: "unavailable" }));
				return;
			}
			if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
				finish(reject, new MindmuxError("adapter reply is not an object", { code: "unavailable" }));
				return;
			}
			if (reply.ok !== true) {
				const code = typeof reply.code === "string" && reply.code ? reply.code : "unavailable";
				finish(reject, new MindmuxError(
					typeof reply.error === "string" && reply.error ? reply.error : "adapter refused " + request.op,
					{ code },
				));
				return;
			}
			finish(resolve, reply);
		});
		socket.on("connect", () => {
			wrote = true;
			socket.write(JSON.stringify(request) + "\n");
		});
	});
}

/**
 * The adapter client. One client captures one adapter env/socket snapshot, so a
 * reload or an env swap can never redirect it: create a fresh client for a new
 * runtime.
 */
export function createMindmuxClient(env = process.env, options = {}) {
	const mx = readMindmuxEnv(env);
	if (!mx) throw new MindmuxError("mindmux adapter env is not set", { code: "unavailable" });
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const call = (request) => mindmuxRequest(mx.adapterSocket, request, timeoutMs);
	return {
		env: mx,
		generation: mx.generation,
		/** Registers readiness with Go. Only call this once the draft socket listens. */
		ready: (draftSocket) => call({ op: "ready", draft_socket: draftSocket }),
		spawn: (spec) => call({
			op: "spawn",
			worker_id: spec.workerId,
			tier: spec.tier,
			model: spec.model,
			thinking: spec.thinking,
			session_dir: spec.sessionDir,
		}),
		retire: (pane) => call({ op: "retire", pane }),
		list: () => call({ op: "list" }),
	};
}

/**
 * Append, never replace: the existing draft and the new text are separated by one
 * blank line, and the exact multiline text is preserved. No submit, no focus, no
 * cursor arithmetic, no terminal escape.
 */
export function appendEditorDraft(ui, text) {
	if (typeof text !== "string" || !text) throw new Error("draft append needs non-empty text");
	// No "" fallback: writing over a draft we could not read would destroy the user's prompt.
	if (typeof ui?.getEditorText !== "function") throw new Error("draft append needs ui.getEditorText");
	const current = ui.getEditorText();
	if (typeof current !== "string") throw new Error("draft append needs a string draft");
	// Byte-for-byte: an existing draft is never trimmed, and the new text is never reshaped.
	const next = current ? current + "\n\n" + text : text;
	ui.setEditorText(next);
	return next;
}

function reply(conn, payload) {
	try {
		conn.write(JSON.stringify(payload) + "\n");
	} catch { /* the sender went away: nothing to acknowledge */ }
}

function draftError(conn, message) {
	reply(conn, { ok: false, error: message });
}

/**
 * The private draft socket: mindmux send connects, sends
 * {"op":"append","text":"..."} and gets {"ok":true} ONLY after the editor holds
 * the text. append may be async; a rejection is answered as an error.
 */
export async function startDraftSocket({ socketPath, append, onError, mode = 0o600 }) {
	if (typeof socketPath !== "string" || !socketPath.startsWith("/")) {
		throw new Error("draft socket path must be absolute");
	}
	if (typeof append !== "function") throw new Error("draft socket needs an append function");
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	try { unlinkSync(socketPath); } catch { /* no stale socket */ }

	const chain = { tail: Promise.resolve() };
	const handleLine = async (conn, line) => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			draftError(conn, "malformed JSON frame");
			return;
		}
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
			draftError(conn, "frame must be an object");
			return;
		}
		if (msg.op !== "append") {
			draftError(conn, "unsupported op: " + String(msg.op));
			return;
		}
		if (typeof msg.text !== "string" || !msg.text) {
			draftError(conn, "append needs non-empty text");
			return;
		}
		// One append at a time: two editor writes must not interleave their read-modify-write.
		const run = chain.tail.then(async () => {
			try {
				await append(msg.text);
				// The ACK means the draft holds the text. Nothing is sent or submitted.
				reply(conn, { ok: true });
			} catch (err) {
				draftError(conn, err instanceof Error ? err.message : String(err));
			}
		});
		chain.tail = run.catch(() => {});
		await run;
	};

	const server = createServer((conn) => {
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("error", () => { /* sender aborted: no retry, no state */ });
		conn.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.length > MAX_DRAFT_BUFFER_BYTES) {
				draftError(conn, "frame is unbounded");
				conn.destroy();
				return;
			}
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				if (line.length > MAX_DRAFT_FRAME_BYTES) {
					draftError(conn, "frame is too large");
					continue;
				}
				void handleLine(conn, line);
			}
		});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.once("listening", resolve);
		server.listen(socketPath);
	});
	try { chmodSync(socketPath, mode); } catch { /* best effort: the runtime dir carries the mode */ }
	if (typeof onError === "function") server.on("error", onError);

	let closed = false;
	return {
		path: socketPath,
		close() {
			if (closed) return;
			closed = true;
			try { server.close(); } catch { /* ignore */ }
			try { unlinkSync(socketPath); } catch { /* ignore */ }
		},
	};
}
