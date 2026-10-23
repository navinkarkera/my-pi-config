// Shared harness for the worker-session-reset suites.
//
// Real extension module + real Unix sockets + a fake Pi API. The fake Pi
// reproduces the documented contracts that matter here (verified against the
// installed 1.4.0 sources):
//   - sendUserMessage() expands prompt templates only when
//     { expandPromptTemplates: true }; command dispatch happens before the
//     streaming guard and the input hook (dist/core/agent-session.js
//     prompt()/_tryExecuteExtensionCommand, around lines 1636-1640 and 1933).
//   - session replacement order is session_before_switch -> session.abort() ->
//     session_shutdown -> new runtime -> session_start -> withSession
//     (dist/core/agent-session-runtime.js newSession/teardownCurrent).
//   - session_start handlers are awaited before newSession() resolves
//     (finishSessionReplacement -> rebindSession -> bindExtensions, and
//     dist/core/agent-session.js bindExtensions).
//   - extensions are loaded once and the runtime is shared, so module state and
//     the Pi API object survive replacement (dist/core/extensions/runner.js,
//     "all extension APIs reference this").
// The real-Pi suite covers the parts this fake cannot prove.

import { createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPiResolver, EXTENSION_URL } from "./pi-resolver.mjs";

const MANAGED_ENV = [
	"HOME",
	"PI_CODING_AGENT_DIR",
	"PI_PACKAGE_DIR",
	"PI_MIND_WORKER_ROLE",
	"PI_MIND_WORKER_ID",
	"PI_MIND_WORKER_TIER",
	"PI_MIND_WORKER_GENERATION",
	"PI_MIND_WORKER_SESSION_DIR",
	"PI_MIND_WORKER_INSTANCE",
	"PI_MIND_WORKER_LAUNCHER_PID",
	"PI_MIND_WORKER_LAUNCHER_TOKEN",
];

let instanceCounter = 0;

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject instead of hanging a test when a promise never settles. */
export async function withTimeout(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error((label || "operation") + " did not settle within " + ms + "ms")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Poll until fn() returns truthy or the deadline passes. */
export async function waitUntil(fn, options) {
	const timeout = options?.timeout ?? 3000;
	const interval = options?.interval ?? 10;
	const label = options?.label ?? "condition";
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() >= deadline) throw new Error(label + " not met within " + timeout + "ms");
		await sleep(interval);
	}
}

// ── Socket clients ───────────────────────────────────────────────────────────

function makeClient(socket) {
	const client = {
		socket,
		frames: [],
		closed: false,
		waiters: new Set(),
	};
	const claimed = new WeakSet();

	socket.setEncoding("utf8");
	socket.on("error", () => { /* tests assert frames, not socket errors */ });
	socket.on("close", () => {
		client.closed = true;
		for (const waiter of [...client.waiters]) waiter();
	});

	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			client.frames.push(frame);
			for (const waiter of [...client.waiters]) waiter();
		}
	});

	client.send = (message) => {
		if (socket.destroyed) return;
		socket.write(JSON.stringify(message) + "\n");
	};
	client.close = () => {
		if (!socket.destroyed) socket.destroy();
	};
	client.find = (predicate) => client.frames.find((frame) => !claimed.has(frame) && predicate(frame)) ?? null;
	client.seen = (predicate) => client.frames.filter(predicate);
	client.waitFor = (predicate, options) => {
		const timeout = options?.timeout ?? 3000;
		const label = options?.label ?? "frame";
		return new Promise((resolve, reject) => {
			const settle = () => {
				const match = client.find(predicate);
				if (!match) return false;
				claimed.add(match);
				cleanup();
				resolve(match);
				return true;
			};
			const timer = setTimeout(() => {
				cleanup();
				const frames = client.frames.map((f) => JSON.stringify(f)).join("\n  ") || "(none)";
				reject(new Error("Timed out after " + timeout + "ms waiting for " + label + ". Received frames:\n  " + frames));
			}, timeout);
			const cleanup = () => {
				clearTimeout(timer);
				client.waiters.delete(settle);
			};
			client.waiters.add(settle);
			if (settle()) return;
		});
	};
	client.waitForClose = (options) => {
		const timeout = options?.timeout ?? 3000;
		return new Promise((resolve, reject) => {
			if (client.closed) return resolve();
			const settle = () => {
				if (!client.closed) return false;
				cleanup();
				resolve();
				return true;
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("Timed out after " + timeout + "ms waiting for the socket to close"));
			}, timeout);
			const cleanup = () => {
				clearTimeout(timer);
				client.waiters.delete(settle);
			};
			client.waiters.add(settle);
			if (settle()) return;
		});
	};
	return client;
}

async function listen(server, path) {
	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(path);
	});
}

// ── Fixture ──────────────────────────────────────────────────────────────────

/**
 * Create an isolated fixture. Always call cleanup() (see withFixture).
 * Every writable location the extension uses (config, state dir, socket,
 * control file, manifest, session dirs, logs) is derived from
 * PI_CODING_AGENT_DIR and the cwd, so both are redirected before any import.
 */
export async function createFixture(options = {}) {
	installPiResolver();

	const savedEnv = new Map();
	for (const key of MANAGED_ENV) savedEnv.set(key, process.env[key]);
	const savedCwd = process.cwd();

	const root = mkdtempSync(join(tmpdir(), "mind-worker-reset-"));
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	for (const key of MANAGED_ENV) delete process.env[key];
	process.env.HOME = homeDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (options.packageDir) process.env.PI_PACKAGE_DIR = options.packageDir;
	process.chdir(cwd);

	const generation = options.generation ?? 1;
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const stateDir = join(agentDir, "mindworker");
	mkdirSync(stateDir, { recursive: true });

	const workerCount = options.workerCount ?? 1;
	const config = {
		mindModel: "stub/model",
		workerModel: "stub/model",
		timeout: options.taskTimeout ?? 30,
		statusStream: false,
		autoSpawnWorker: false,
		notifyOnMindIdle: false,
		resetTimeout: options.resetTimeout ?? 2,
		kittyEnabled: false,
		workerCount,
		...(options.workerModels ? { workerModels: options.workerModels } : {}),
		dashboardEnabled: false,
		dashboardRetention: 10,
		dashboardHeartbeatMs: 60000,
		dashboardStaleMs: 60000,
		dashboardLogResponses: false,
		burstFlash: {
			enabled: false,
			model: "stub/model",
			maxBurst: 0,
			idleTtlMs: 60000,
			maxTasksPerWorker: 3,
			launchMode: "headless",
			queuePressureThreshold: 1,
			spawnWaitMs: 50,
			killTimeoutMs: 1000,
			logDetail: "compact",
			...(options.burstFlash ?? {}),
		},
	};
	writeFileSync(join(agentDir, "mind-worker.json"), JSON.stringify(config, null, 2));
	writeFileSync(
		join(stateDir, hash + "-manifest.json"),
		JSON.stringify({ cwd, hash, generation, state: "running", lastUpdated: Date.now() }, null, 2),
	);

	const fixture = {
		root,
		cwd,
		homeDir,
		agentDir,
		stateDir,
		hash,
		generation,
		workerCount,
		socketPath: join(stateDir, hash + ".sock"),
		controlPath: join(stateDir, hash + "-mind-control.json"),
		logPath: join(stateDir, "mind-worker-ext.log"),
		instances: [],
		clients: [],
		servers: [],
		idle: true,
		cleanedUp: false,
	};

	fixture.readLog = () => {
		try {
			return readFileSync(fixture.logPath, "utf8");
		} catch {
			return "";
		}
	};

	fixture.readControl = () => {
		try {
			return JSON.parse(readFileSync(fixture.controlPath, "utf8"));
		} catch {
			return null;
		}
	};

	/**
	 * Load a fresh module instance for one role. Env role/identity is set before
	 * the dynamic import because the extension reads it at module scope.
	 */
	fixture.load = async (role, loadOptions = {}) => {
		process.env.PI_MIND_WORKER_ROLE = role;
		if (role === "worker") {
			process.env.PI_MIND_WORKER_ID = loadOptions.workerId ?? "worker-0";
			process.env.PI_MIND_WORKER_TIER = loadOptions.tier ?? "flash";
			process.env.PI_MIND_WORKER_GENERATION = String(loadOptions.generation ?? generation);
		}
		const tag = "reset-" + (++instanceCounter);
		const module = await import(EXTENSION_URL + "?" + role + "=" + tag);
		const instance = createInstance(fixture, role, module, loadOptions);
		module.default(instance.pi);
		fixture.instances.push(instance);
		return instance;
	};

	/** Activate the Mind role and wait for its socket to accept connections. */
	fixture.startMind = async () => {
		const instance = await fixture.load("mind", options.mind ?? {});
		await instance.sessionStart();
		await waitUntil(
			async () => {
				try {
					const socket = createConnection(fixture.socketPath);
					await new Promise((resolve, reject) => {
						socket.once("connect", resolve);
						socket.once("error", reject);
					});
					socket.destroy();
					return true;
				} catch {
					return false;
				}
			},
			{ timeout: 5000, label: "mind socket" },
		);
		return instance;
	};

	/** Act as a worker connecting to the Mind socket. */
	fixture.connectWorker = async (connectOptions = {}) => {
		const workerId = connectOptions.workerId ?? "worker-0";
		const tier = connectOptions.tier ?? "flash";
		const gen = connectOptions.generation ?? generation;
		const socket = createConnection(fixture.socketPath);
		await new Promise((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const client = makeClient(socket);
		fixture.clients.push(client);
		if (connectOptions.handshake !== false) {
			client.send({
				type: "handshake",
				role: "worker",
				generation: gen,
				workerId,
				tier,
				...(connectOptions.resetId ? { resetId: connectOptions.resetId } : {}),
			});
		}
		return client;
	};

	/** Start a fake Mind socket for worker-role tests. */
	fixture.startFakeMind = async () => {
		if (existsSync(fixture.socketPath)) rmSync(fixture.socketPath, { force: true });
		const state = { connections: [], consumed: 0 };
		const server = createServer((socket) => {
			const client = makeClient(socket);
			fixture.clients.push(client);
			state.connections.push(client);
		});
		await listen(server, fixture.socketPath);
		fixture.servers.push(server);
		return {
			server,
			connections: state.connections,
			next: async (nextOptions = {}) => {
				await waitUntil(() => state.connections.length > state.consumed, {
					timeout: nextOptions.timeout ?? 5000,
					label: "worker connection",
				});
				return state.connections[state.consumed++];
			},
		};
	};

	fixture.shutdown = async () => {
		for (const instance of [...fixture.instances].reverse()) {
			try {
				await instance.sessionShutdown("quit");
			} catch { /* best effort */ }
		}
		for (const client of fixture.clients) client.close();
		for (const server of fixture.servers) {
			await new Promise((resolve) => server.close(resolve));
		}
	};

	fixture.cleanup = async () => {
		if (fixture.cleanedUp) return;
		fixture.cleanedUp = true;
		await fixture.shutdown();
		process.chdir(savedCwd);
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	};

	return fixture;
}

/** Create, run, always clean up. */
export async function withFixture(options, fn) {
	const fixture = await createFixture(options);
	try {
		return await fn(fixture);
	} finally {
		await fixture.cleanup();
	}
}

// ── Fake Pi instance ─────────────────────────────────────────────────────────

function createInstance(fixture, role, module, loadOptions) {
	const instance = {
		role,
		module,
		handlers: new Map(),
		commands: new Map(),
		tools: new Map(),
		userMessages: [],
		messages: [],
		commandPromises: [],
		errors: [],
		newSessionCount: 0,
		newSessionGate: null,
		cancelNextNewSession: false,
	};

	const ui = {
		notify() {},
		setStatus() {},
		setWidget() {},
		setEditorComponent() {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setTitle() {},
		setFooter() {},
		setHeader() {},
		getEditorText() { return ""; },
		setEditorText() {},
		pasteToEditor() {},
		addAutocompleteProvider() {},
		get theme() { return {}; },
		getAllThemes() { return []; },
		getTheme() {},
		setTheme() {},
		getToolsExpanded() { return false; },
		setToolsExpanded() {},
	};

	const ctx = {
		cwd: fixture.cwd,
		mode: "tui",
		hasUI: true,
		ui,
		modelRegistry: { find: () => undefined },
		sessionManager: { getEntries: () => [] },
		isIdle: () => fixture.idle !== false,
		isProjectTrusted: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd: fixture.cwd }),
		compact() {},
		abort() {},
		shutdown() {},
		signal: undefined,
		waitForIdle: async () => {},
		newSession: async () => instance.replaceSession(),
		fork: async () => ({ cancelled: true }),
		navigateTree: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {},
		sendMessage: (message, messageOptions) => instance.pi.sendMessage(message, messageOptions),
		sendUserMessage: (content, messageOptions) => instance.pi.sendUserMessage(content, messageOptions),
	};
	instance.ctx = ctx;

	const pi = {
		on(event, handler) {
			const list = instance.handlers.get(event) ?? [];
			list.push(handler);
			instance.handlers.set(event, list);
			return () => {};
		},
		registerCommand(name, commandOptions) {
			instance.commands.set(name, commandOptions);
		},
		registerTool(tool) {
			instance.tools.set(tool.name, tool);
		},
		registerFlag() {},
		getFlag() { return undefined; },
		sendMessage(message, messageOptions) {
			instance.messages.push({ message, options: messageOptions });
		},
		sendUserMessage(content, messageOptions) {
			instance.userMessages.push({ content, options: messageOptions });
			if (messageOptions?.expandPromptTemplates !== true) return;
			const text = typeof content === "string" ? content : "";
			if (!text.startsWith("/")) return;
			const space = text.indexOf(" ");
			const name = space === -1 ? text.slice(1) : text.slice(1, space);
			const args = space === -1 ? "" : text.slice(space + 1);
			const command = instance.commands.get(name);
			if (!command) return;
			// Pi awaits the handler inside prompt(); invoke it on a microtask so the
			// caller sees the same ordering without re-entering the socket handler.
			const pending = Promise.resolve().then(() => command.handler(args, ctx));
			instance.commandPromises.push(pending);
			pending.catch((error) => instance.errors.push(error));
		},
		appendEntry() {},
		setSessionName() {},
		getSessionName() { return undefined; },
		setLabel() {},
		getActiveTools() { return ["read", "bash"]; },
		setActiveTools() {},
		getAllTools() { return []; },
		getSettings() { return {}; },
		getCommands() { return []; },
		setModel: async () => true,
		getThinkingLevel: () => "max",
		setThinkingLevel() {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	};
	instance.pi = pi;

	instance.call = async (event, payload) => {
		for (const handler of instance.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	};
	instance.sessionStart = () => instance.call("session_start", { type: "session_start", reason: "startup" });
	instance.sessionShutdown = (reason = "quit") =>
		instance.call("session_shutdown", { type: "session_shutdown", reason });
	instance.replaceSession = async () => {
		instance.newSessionCount += 1;
		if (instance.newSessionGate) await instance.newSessionGate;
		if (instance.cancelNextNewSession) {
			instance.cancelNextNewSession = false;
			return { cancelled: true };
		}
		// Replacement order verified in agent-session-runtime.js: shutdown on the
		// old runner first, session_start on the new one, all before newSession()
		// resolves (session_start is awaited by bindExtensions).
		await instance.sessionShutdown("new");
		await instance.call("session_start", { type: "session_start", reason: "new" });
		return { cancelled: false };
	};
	instance.settleCommands = async () => {
		for (const pending of instance.commandPromises) {
			try {
				await withTimeout(pending, 5000, "command handler");
			} catch (error) {
				instance.errors.push(error);
			}
		}
	};
	instance.runTool = (name, params, toolOptions = {}) => {
		const tool = instance.tools.get(name);
		if (!tool) throw new Error("Tool " + name + " is not registered (registered: " + [...instance.tools.keys()].join(", ") + ")");
		return tool.execute("test-call", params, toolOptions.signal, toolOptions.onUpdate, ctx);
	};
	return instance;
}
