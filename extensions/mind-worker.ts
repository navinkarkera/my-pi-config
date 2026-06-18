import { exec, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync, createWriteStream } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** Resolved path to the pi CLI binary via the installed package. */
const PI_CLI = join(getPackageDir(), "dist", "cli.js");

type Role = "none" | "mind" | "worker";

interface WorkerConnection {
	socket: Socket;
	busy: boolean;
	taskId: string | null;
	workerId: string;
	connectedAt: number;
	tier: string;
}

interface WorkerModelEntry {
	model: string;
	tier: string;
}

interface MindWorkerConfig {
	mindModel: string;
	workerModel: string;
	timeout: number;
	statusStream: boolean;
	autoSpawnWorker: boolean;
	notifyOnMindIdle: boolean;
	ntfyTopic: string;
	ntfyServer: string;
	resetTimeout: number;
	kittyEnabled: boolean;
	workerCount: number;
	workerModels?: Array<{ model: string; count: number; tier?: string }>;
	dashboardEnabled: boolean;
	dashboardRetention: number;
	dashboardHeartbeatMs: number;
	dashboardStaleMs: number;
	dashboardLogResponses: boolean;
	burstFlash: BurstFlashConfig;
}

interface BurstFlashConfig {
	enabled: boolean;
	model: string;
	maxBurst: number;
	idleTtlMs: number;
	maxTasksPerWorker: number;
	launchMode: "headless" | "kitty";
	queuePressureThreshold: number;
	spawnWaitMs: number;
	killTimeoutMs: number;
	logDetail: "compact" | "full";
}

interface SocketMsg {
	type: "task" | "result" | "error" | "status" | "abort" | "ping" | "pong" | "handshake" | "subdelegate-request" | "subdelegate-response";
	id?: string;
	task?: string;
	step?: number;
	plan?: string;
	context?: string;
	reset?: boolean;
	role?: string;
	generation?: number;
	workerId?: string;
	tier?: string;
	explanation?: string;
	diff?: string;
	filesChanged?: string[];
	bashResults?: Array<{ cmd: string; exitCode: number; output: string }>;
	code?: string;
	message?: string;
	phase?: string;
	detail?: string;
	requesterWorkerId?: string;
	requesterTaskId?: string;
	error?: string;
}

const DEFAULT_BURST_FLASH_CONFIG: BurstFlashConfig = {
	enabled: true,
	model: "opencode-go/deepseek-v4-flash",
	maxBurst: 2,
	idleTtlMs: 180000,
	maxTasksPerWorker: 3,
	launchMode: "headless",
	queuePressureThreshold: 1,
	spawnWaitMs: 1000,
	killTimeoutMs: 2000,
	logDetail: "compact",
};

const DEFAULT_CONFIG: MindWorkerConfig = {
	mindModel: "anthropic/claude-opus-4-5",
	workerModel: "anthropic/claude-sonnet-4",
	timeout: 120,
	statusStream: true,
	autoSpawnWorker: true,
	notifyOnMindIdle: false,
	ntfyTopic: "",
	ntfyServer: "https://ntfy.sh",
	resetTimeout: 5,
	kittyEnabled: true,
	workerCount: 3,
	workerModels: undefined,
	dashboardEnabled: true,
	dashboardRetention: 200,
	dashboardHeartbeatMs: 10000,
	dashboardStaleMs: 30000,
	dashboardLogResponses: true,
	burstFlash: { ...DEFAULT_BURST_FLASH_CONFIG },
};

const MIND_ALLOWED_TOOLS = ["delegate", "read", "git", "ripgrep"];
const WORKER_THINKING_LEVEL = "xhigh";

/** Parsed from env var PI_MIND_WORKER_ROLE (launcher path) or --mind-worker-role CLI flag (legacy). null = legacy path. */
const LAUNCHER_ROLE_FLAG: Role | null = parseEnvRole() ?? parseRoleFlag(process.argv);

/** Parsed from env var PI_MIND_WORKER_GENERATION (launcher path). null = not set. */
const LAUNCHER_GENERATION: number | null = parseEnvGeneration();

/** Parsed from env var PI_MIND_WORKER_ID (launcher path). null = not set. */
const LAUNCHER_WORKER_ID: string | null = parseEnvWorkerId();

/** Parsed from env var PI_MIND_WORKER_TIER (launcher path). null = not set. */
const LAUNCHER_WORKER_TIER: string | null = parseEnvWorkerTier();

/** Mutable boot-time hint cleared after role activation. Prevents stale-flag bugs on role changes. */
let launcherBootHint: Role | null = LAUNCHER_ROLE_FLAG;

function parseEnvRole(): Role | null {
	const val = process.env.PI_MIND_WORKER_ROLE;
	if (val === "mind" || val === "worker") return val;
	return null;
}

function parseEnvGeneration(): number | null {
	const val = process.env.PI_MIND_WORKER_GENERATION;
	if (val) {
		const n = parseInt(val, 10);
		return isNaN(n) ? null : n;
	}
	return null;
}

function parseEnvWorkerId(): string | null {
	const val = process.env.PI_MIND_WORKER_ID;
	return val?.trim() || null;
}

function parseEnvWorkerTier(): string | null {
	const val = process.env.PI_MIND_WORKER_TIER;
	return val?.trim() || null;
}

function parseRoleFlag(argv: string[]): Role | null {
	for (const arg of argv) {
		const m = arg.match(/^--mind-worker-role=(mind|worker)$/);
		if (m) return m[1] as Role;
	}
	const idx = argv.indexOf("--mind-worker-role");
	if (idx >= 0 && idx + 1 < argv.length) {
		const val = argv[idx + 1];
		if (val === "mind" || val === "worker") return val;
	}
	return null;
}

let currentRole: Role = "none";
let defaultTools: string[] | null = null;

let mindServer: Server | null = null;
let workerSocket: Socket | null = null;
const workerPool = new Map<string, WorkerConnection>();
let maxWorkers = 3;
const taskWorkerMap = new Map<string, string>();

let workerBusy = false;
let workerTaskId: string | null = null;

/** Launcher-path worker keepalive — prevents Node event-loop exit in headless/noninteractive mode. */
let workerKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
const WORKER_KEEPALIVE_MS = 60_000;

function startWorkerKeepalive(): void {
	if (workerKeepaliveTimer) return;
	workerKeepaliveTimer = setInterval(() => { /* noop keepalive — keeps event loop alive */ }, WORKER_KEEPALIVE_MS);
}

function stopWorkerKeepalive(): void {
	if (workerKeepaliveTimer) {
		clearInterval(workerKeepaliveTimer);
		workerKeepaliveTimer = null;
	}
}

/** Worker-side: pending subdelegate resolvers (strong worker waiting for flash result via mind). */
interface SubdelegateWaiter {
	resolve: (result: any) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}
const subdelegateWaiters = new Map<string, SubdelegateWaiter>();

/** Mind-side: track which flash-worker tasks are subdelegations from strong workers. Maps flashTaskId → requester info. */
interface SubdelegateTracker {
	requesterWorkerId: string;
	requesterSocket: Socket;
	subdelegateId: string;
}
const subdelegateTrackers = new Map<string, SubdelegateTracker>();
/** Reverse map: subdelegateId → flashTaskId (for abort handling). */
const subdelegateReverseMap = new Map<string, string>();

/** Remove a queued subdelegate by subdelegateId. Returns true if found and removed. */
function removeQueuedSubdelegate(subdelegateId: string): boolean {
	const flashTaskId = subdelegateReverseMap.get(subdelegateId);
	if (!flashTaskId) return false;
	const idx = pendingQueue.findIndex(e => e.id === flashTaskId);
	if (idx >= 0) {
		pendingQueue.splice(idx, 1);
		subdelegateTrackers.delete(flashTaskId);
		subdelegateReverseMap.delete(subdelegateId);
		return true;
	}
	return false;
}

/** Remove all queued subdelegates initiated by a specific worker. */
function removeQueuedSubdelegatesByRequester(requesterWorkerId: string): void {
	for (let i = pendingQueue.length - 1; i >= 0; i--) {
		const entry = pendingQueue[i];
		const tracker = subdelegateTrackers.get(entry.id);
		if (tracker && tracker.requesterWorkerId === requesterWorkerId) {
			pendingQueue.splice(i, 1);
			subdelegateReverseMap.delete(tracker.subdelegateId);
			subdelegateTrackers.delete(entry.id);
		}
	}
}

const pendingResolvers = new Map<string, (msg: SocketMsg) => void>();
const pendingUpdates = new Map<string, (update: any) => void>();

interface QueuedTask {
	id: string;
	task: string;
	step?: number;
	plan?: string;
	context?: string;
	reset?: boolean;
	tier?: string;
	ctx: ExtensionContext;
	resolve: (result: any) => void;
	signal?: AbortSignal;
	onUpdate?: (update: any) => void;
	cwd: string;
	queuedAt: number;
}
const pendingQueue: QueuedTask[] = [];
let maxQueueSize = 6; // 2x default maxWorkers; updated on config load

let lastNotificationFingerprint = "";
let lastNotificationTime = 0;
const NOTIFICATION_COOLDOWN_MS = 10_000;

// ── Dashboard support ────────────────────────────────────────────────────────

interface TaskMetadata {
	startedAt: number;
	description: string;
	tier: string;
	workerId: string;
	cwd: string;
}
const taskMetadataMap = new Map<string, TaskMetadata>();

let dashboardHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastDashboardStatus = "";
let lastDashboardCwd = "";

// ── Burst flash workers ──────────────────────────────────────────────────────

interface BurstWorkerState {
	workerId: string;
	pid: number;
	spawnedAt: number;
	lastTaskAt: number;
	taskCount: number;
	sessionDir: string;
	logPath: string;
	process: import("node:child_process").ChildProcess | null;
	connectedAt: number;
	lastEvent: string;
	lastEventAt: number;
	launchMode: "headless" | "kitty";
	paneTitle: string | null;
	kittyWindowId: number | null;
}

const burstWorkers = new Map<string, BurstWorkerState>();
let burstCounter = 0;
let burstIdleCheckTimer: ReturnType<typeof setInterval> | null = null;

// ── Burst flash helpers ──────────────────────────────────────────────────────

async function findKittyPanePid(title: string): Promise<{ pid: number; windowId: number } | null> {
	return new Promise((resolve) => {
		let child: import("node:child_process").ChildProcess;
		try {
			child = spawn("kitty", ["@", "ls"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
		} catch {
			resolve(null);
			return;
		}
		let stdout = "";
		child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
		child.on("close", (code) => {
			if (code !== 0) { resolve(null); return; }
			try {
				const osWindows = JSON.parse(stdout);
				for (const osWin of osWindows) {
					for (const tab of osWin.tabs || []) {
						for (const w of tab.windows || []) {
							if (w.title === title) {
								resolve({ pid: w.pid, windowId: w.id });
								return;
							}
						}
					}
				}
			} catch { /* parse error */ }
			resolve(null);
		});
		child.on("error", () => resolve(null));
	});
}

async function closeKittyPaneByTitle(title: string): Promise<void> {
	return new Promise((resolve) => {
		try {
			const child = spawn("kitty", ["@", "close-window", "--match", `title:${title}`], { stdio: "ignore", timeout: 5000 });
			child.on("close", () => resolve());
			child.on("error", () => resolve());
		} catch {
			resolve();
		}
	});
}

async function discoverBurstKittyPane(title: string, retries = 10, intervalMs = 500): Promise<{ pid: number; windowId: number } | null> {
	for (let i = 0; i < retries; i++) {
		const result = await findKittyPanePid(title);
		if (result) return result;
		await new Promise(r => setTimeout(r, intervalMs));
	}
	return null;
}

function getBurstFlashLogPath(cwd: string, n: number): string {
	return join(getStateDir(), `${getCwdHash(cwd)}-burst-flash-${n}.log`);
}

function getBurstFlashSessionDir(cwd: string, n: number): string {
	return join(getAgentDir(), "sessions", `burst-flash-${getCwdHash(cwd)}-${n}`);
}

function logBurstEvent(cwd: string, workerId: string, event: string, detail?: string): void {
	const state = [...burstWorkers.values()].find(b => b.workerId === workerId);
	if (!state) return;
	state.lastEvent = detail ? `${event}: ${detail}` : event;
	state.lastEventAt = Date.now();
	const ts = new Date().toISOString();
	const line = detail ? `[${ts}] ${event}: ${detail}\n` : `[${ts}] ${event}\n`;
	try {
		const { config } = loadConfig();
		if (config.burstFlash.logDetail === "compact" || config.burstFlash.logDetail === "full") {
			const fd = require("node:fs").openSync(state.logPath, "a");
			require("node:fs").writeSync(fd, line);
			require("node:fs").closeSync(fd);
		}
	} catch { /* ignore log write errors */ }
}

function isBurstWorker(workerId: string): boolean {
	return workerId.startsWith("burst-flash-");
}

function countBurstWorkers(): number {
	return burstWorkers.size;
}

function countIdleFlashWorkers(): number {
	let count = 0;
	for (const [wid, conn] of workerPool) {
		if (conn.tier === "flash" && !conn.busy && !conn.socket.destroyed) {
			// Skip stale burst workers whose state has been cleaned up
			if (isBurstWorker(wid) && !burstWorkers.has(wid)) continue;
			count++;
		}
	}
	return count;
}

function getOldestFlashQueueWait(cwd: string): number {
	// Returns ms since oldest flash-eligible queued task was enqueued, or 0 if none
	for (const entry of pendingQueue) {
		if (entry.cwd === cwd && (!entry.tier || entry.tier === "flash" || entry.tier === "default")) {
			return Date.now() - (entry as any).queuedAt || 0;
		}
	}
	return 0;
}

function countFlashEligibleQueued(cwd: string): number {
	return pendingQueue.filter(e => e.cwd === cwd && (!e.tier || e.tier === "flash" || e.tier === "default")).length;
}

function trySpawnBurstFlash(cwd: string, ctx: ExtensionContext): void {
	const { config } = loadConfig();
	if (!config.burstFlash.enabled) return;
	if (currentRole !== "mind") return;
	if (countBurstWorkers() >= config.burstFlash.maxBurst) return;
	if (countIdleFlashWorkers() > 0) return;
	const flashQueued = countFlashEligibleQueued(cwd);
	if (flashQueued === 0) return;
	// Check trigger conditions
	const pressureMet = flashQueued >= config.burstFlash.queuePressureThreshold;
	const waitMet = getOldestFlashQueueWait(cwd) >= config.burstFlash.spawnWaitMs;
	if (!pressureMet && !waitMet) return;
	// Spawn
	const n = ++burstCounter;
	const workerId = `burst-flash-${n}`;
	const sessionDir = getBurstFlashSessionDir(cwd, n);
	const logPath = getBurstFlashLogPath(cwd, n);
	const manifest = readManifest(cwd);
	const generation = manifest?.generation ?? 0;
	// Ensure dirs
	try { mkdirSync(sessionDir, { recursive: true }); } catch { /* may exist */ }
	try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* may exist */ }
	// Build env: inherit but override mind-worker identity vars
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !k.startsWith("PI_MIND_WORKER_")) {
			env[k] = v;
		}
	}
	env.PI_MIND_WORKER_ROLE = "worker";
	env.PI_MIND_WORKER_TIER = "flash";
	env.PI_MIND_WORKER_ID = workerId;
	env.PI_MIND_WORKER_GENERATION = String(generation);
	env.PI_MIND_WORKER_SESSION_DIR = sessionDir;
	const model = config.burstFlash.model;
	const hash = getCwdHash(cwd);
	const paneTitle = `burst-flash-${hash}-${n}`;
	// Decide: kitty or headless?
	if (config.burstFlash.launchMode !== "kitty") {
		spawnBurstHeadless({ n, workerId, cwd, sessionDir, logPath, model, generation, env });
		return;
	}
	// ── Kitty launch path ──
	let fellBack = false;
	const fallbackToHeadless = (reason: string) => {
		if (fellBack) return;
		fellBack = true;
		console.error(`[burst-flash] ${workerId}: ${reason}, falling back to headless`);
		burstWorkers.delete(workerId);
		spawnBurstHeadless({ n, workerId, cwd, sessionDir, logPath, model, generation, env });
	};
	const kittyArgs = [
		"@", "launch",
		"--location", "hsplit",
		"--title", paneTitle,
		"--cwd", cwd,
		"--env", `PI_MIND_WORKER_ROLE=worker`,
		"--env", `PI_MIND_WORKER_TIER=flash`,
		"--env", `PI_MIND_WORKER_ID=${workerId}`,
		"--env", `PI_MIND_WORKER_GENERATION=${String(generation)}`,
		"--env", `PI_MIND_WORKER_SESSION_DIR=${sessionDir}`,
		"--env", `PATH=${process.env.PATH || ""}`,
		PI_CLI, "--mode", "rpc", "--model", model, "--session-dir", sessionDir,
	];
	// Best-effort focus mind window before launching split
	const mindTitle = `mind-${hash}`;
	try {
		const focusChild = spawn("kitty", ["@", "focus-window", "--match", `title:${mindTitle}`], { stdio: "ignore", timeout: 3000 });
		focusChild.on("error", () => { /* best-effort */ });
	} catch { /* best-effort */ }
	let child: import("node:child_process").ChildProcess;
	try {
		child = spawn("kitty", kittyArgs, { stdio: "ignore", timeout: 10000 });
	} catch (err: any) {
		fallbackToHeadless(`kitty spawn threw synchronously: ${err.message}`);
		return;
	}
	// Insert state first so workers list is accurate
	const state: BurstWorkerState = {
		workerId,
		pid: 0,
		spawnedAt: Date.now(),
		lastTaskAt: Date.now(),
		taskCount: 0,
		sessionDir,
		logPath,
		process: null,
		connectedAt: 0,
		lastEvent: "spawned (kitty)",
		lastEventAt: Date.now(),
		launchMode: "kitty",
		paneTitle,
		kittyWindowId: null,
	};
	burstWorkers.set(workerId, state);
	logBurstEvent(cwd, workerId, "spawned", `mode=kitty title=${paneTitle} model=${model}`);
	console.error(`[burst-flash] spawned ${workerId} in kitty pane ${paneTitle}`);
	child.on("error", (err) => fallbackToHeadless(`kitty spawn error: ${err.message}`));
	child.on("close", (code) => {
		if (code !== 0) fallbackToHeadless(`kitty @ launch exit code ${code}`);
	});
	// Discover PID asynchronously (abort if fell back or state no longer kitty)
	discoverBurstKittyPane(paneTitle, 10, 500).then((result) => {
		if (fellBack) return;
		if (!burstWorkers.has(workerId)) return;
		const s = burstWorkers.get(workerId)!;
		if (s.launchMode !== "kitty") return;
		if (result) {
			s.pid = result.pid;
			s.kittyWindowId = result.windowId;
			s.lastEvent = `pid discovered: ${result.pid}`;
			s.lastEventAt = Date.now();
			logBurstEvent(cwd, workerId, "pid-discovered", `pid=${result.pid} windowId=${result.windowId}`);
			console.error(`[burst-flash] ${workerId} pid=${result.pid} windowId=${result.windowId}`);
		} else {
			s.lastEvent = "pid discovery failed";
			s.lastEventAt = Date.now();
			logBurstEvent(cwd, workerId, "pid-discovery-failed", "tracking by title only");
			console.warn(`[burst-flash] ${workerId} PID discovery failed, tracking by title only`);
		}
	}).catch((err) => {
		console.warn(`[burst-flash] ${workerId} PID discovery error: ${err?.message ?? err}`);
	});
	if (!burstIdleCheckTimer) {
		burstIdleCheckTimer = setInterval(() => checkBurstIdleTtl(cwd), 5000);
	}
}

function checkBurstIdleTtl(cwd: string): void {
	const { config } = loadConfig();
	const now = Date.now();
	for (const [workerId, state] of burstWorkers) {
		const conn = workerPool.get(workerId);
		if (!conn || conn.socket.destroyed) {
			// Worker disconnected, cleanup
			burstWorkers.delete(workerId);
			continue;
		}
		if (conn.busy) {
			state.lastTaskAt = now;
			continue;
		}
		// Check idle TTL
		const idleMs = now - state.lastTaskAt;
		if (idleMs >= config.burstFlash.idleTtlMs) {
			retireBurstFlash(workerId, "idle-ttl");
			continue;
		}
		// Check max tasks
		if (state.taskCount >= config.burstFlash.maxTasksPerWorker) {
			retireBurstFlash(workerId, "max-tasks");
			continue;
		}
	}
	// Stop timer if no burst workers remain
	if (burstWorkers.size === 0 && burstIdleCheckTimer) {
		clearInterval(burstIdleCheckTimer);
		burstIdleCheckTimer = null;
	}
}

function retireBurstFlash(workerId: string, reason: string): void {
	const state = burstWorkers.get(workerId);
	if (!state) return;
	state.lastEvent = `retire: ${reason}`;
	state.lastEventAt = Date.now();
	console.error(`[burst-flash] retiring ${workerId} reason=${reason} tasks=${state.taskCount}`);
	logBurstEvent("", workerId, "retire", reason);
	// Stop sequence: socket shutdown -> (kitty close if kitty mode) -> SIGTERM -> SIGKILL
	const conn = workerPool.get(workerId);
	if (conn && !conn.socket.destroyed) {
		try { conn.socket.end(); } catch { /* ignore */ }
	}
	const { config } = loadConfig();
	if (state.launchMode === "kitty" && state.paneTitle) {
		// Kitty mode: close pane, then kill PID if known
		closeKittyPaneByTitle(state.paneTitle).catch(() => {});
		setTimeout(() => {
			if (state.pid > 0) {
				try { process.kill(state.pid, "SIGTERM"); } catch { /* ignore */ }
				setTimeout(() => {
					try { process.kill(state.pid, "SIGKILL"); } catch { /* ignore */ }
				}, config.burstFlash.killTimeoutMs);
			}
		}, 500);
	} else {
		// Headless mode: existing logic
		setTimeout(() => {
			if (state.process && !state.process.killed) {
				try { state.process.kill("SIGTERM"); } catch { /* ignore */ }
			}
			setTimeout(() => {
				if (state.process && !state.process.killed) {
					try { state.process.kill("SIGKILL"); } catch { /* ignore */ }
				}
			}, config.burstFlash.killTimeoutMs);
		}, 500); // Give socket close a moment
	}
	burstWorkers.delete(workerId);
	// Cleanup session dir best-effort
	try { require("node:fs").rmSync(state.sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function retireAllBurstFlash(reason: string): void {
	for (const workerId of [...burstWorkers.keys()]) {
		retireBurstFlash(workerId, reason);
	}
}

interface SpawnHeadlessParams {
	n: number;
	workerId: string;
	cwd: string;
	sessionDir: string;
	logPath: string;
	model: string;
	generation: number;
	env: Record<string, string>;
}

function spawnBurstHeadless(p: SpawnHeadlessParams): void {
	const { n, workerId, cwd, sessionDir, logPath, model, generation, env } = p;
	let child: import("node:child_process").ChildProcess;
	try {
		child = spawn(PI_CLI, ["--mode", "rpc", "--model", model, "--session-dir", sessionDir], {
			env,
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
		});
	} catch (err: any) {
		const syncErrMsg = `[burst-flash] ${workerId}: headless spawn threw synchronously: ${err.message}`;
		console.error(syncErrMsg);
		appendFileSync(logPath, syncErrMsg + "\n");
		burstWorkers.delete(workerId);
		return;
	}
	child.on("error", (err) => {
		const errMsg = `[burst-flash] ${workerId}: headless spawn error: ${err.message}`;
		console.error(errMsg);
		appendFileSync(logPath, errMsg + "\n");
		burstWorkers.delete(workerId);
		try { require("node:fs").rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});
	if (!child.pid) {
		console.error(`[burst-flash] spawn failed: no pid for ${workerId}`);
		return;
	}
	const state: BurstWorkerState = {
		workerId,
		pid: child.pid,
		spawnedAt: Date.now(),
		lastTaskAt: Date.now(),
		taskCount: 0,
		sessionDir,
		logPath,
		process: child,
		connectedAt: 0,
		lastEvent: "spawned",
		lastEventAt: Date.now(),
		launchMode: "headless",
		paneTitle: null,
		kittyWindowId: null,
	};
	burstWorkers.set(workerId, state);
	const logStream = createWriteStream(logPath, { flags: "a" });
	logStream.on("error", (err) => console.warn(`[burst-flash] ${workerId}: log stream error: ${err.message}`));
	if (child.stdout) child.stdout.pipe(logStream, { end: false });
	if (child.stderr) child.stderr.pipe(logStream, { end: false });
	child.on("exit", (code, signal) => {
		const reason = signal ? `signal=${signal}` : `code=${code}`;
		state.lastEvent = `exited ${reason}`;
		state.lastEventAt = Date.now();
		console.error(`[burst-flash] ${workerId} exited code=${code} signal=${signal}`);
		logStream.end();
		burstWorkers.delete(workerId);
		try { require("node:fs").rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});
	logBurstEvent(cwd, workerId, "spawned", `pid=${child.pid} model=${model}`);
	console.error(`[burst-flash] spawned ${workerId} pid=${child.pid}`);
	if (!burstIdleCheckTimer) {
		burstIdleCheckTimer = setInterval(() => checkBurstIdleTtl(cwd), 5000);
	}
}

function onBurstWorkerConnected(workerId: string): void {
	const state = burstWorkers.get(workerId);
	if (state) {
		state.connectedAt = Date.now();
		state.lastEvent = "connected";
		state.lastEventAt = Date.now();
	}
}

function onBurstWorkerTaskStart(workerId: string): void {
	const state = burstWorkers.get(workerId);
	if (state) {
		state.taskCount++;
		state.lastTaskAt = Date.now();
		state.lastEvent = `task-start (#${state.taskCount})`;
		state.lastEventAt = Date.now();
	}
}

const burstRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Clear all pending burst-retry timers. Call on mind shutdown. */
function clearBurstRetryTimers(): void {
	for (const timer of burstRetryTimers.values()) clearTimeout(timer);
	burstRetryTimers.clear();
}

/** Attempt burst spawn immediately, then retry after spawnWaitMs. Delayed callback
 *  spawns min(queued - reserved, available slots) where reserved = pending or idle
 *  burst workers. Deduplicates retries per cwd. */
function trySpawnBurstFlashWithRetry(cwd: string, ctx: ExtensionContext): void {
	trySpawnBurstFlash(cwd, ctx);
	// Schedule delayed retry that can spawn multiple burst workers
	const { config } = loadConfig();
	if (!config.burstFlash.enabled) return;
	const key = cwd;
	// Don't postpone an existing timer — let it fire at its original time
	if (burstRetryTimers.has(key)) return;
	const timer = setTimeout(() => {
		burstRetryTimers.delete(key);
		const { config: cfg } = loadConfig();
		const queued = countFlashEligibleQueued(cwd);
		// Reserved = burst workers pending connection or connected idle (not busy)
		let reserved = 0;
		for (const workerId of burstWorkers.keys()) {
			const conn = workerPool.get(workerId);
			if (!conn || !conn.busy) reserved++;
		}
		const available = cfg.burstFlash.maxBurst - countBurstWorkers();
		const attempts = Math.max(0, Math.min(queued - reserved, available));
		for (let i = 0; i < attempts; i++) {
			const before = countBurstWorkers();
			trySpawnBurstFlash(cwd, ctx);
			if (countBurstWorkers() === before) break;
		}
	}, config.burstFlash.spawnWaitMs);
	burstRetryTimers.set(key, timer);
}

function getResultsLogPath(cwd: string): string {
	return join(getStateDir(), `${getCwdHash(cwd)}-results.jsonl`);
}

function getResponsesLogPath(cwd: string): string {
	return join(getStateDir(), `${getCwdHash(cwd)}-responses.jsonl`);
}

/** Track task metadata for dashboard result logging. Call when dispatching a task. */
function trackTaskStart(taskId: string, workerId: string, tier: string, description: string, cwd: string): void {
	taskMetadataMap.set(taskId, { startedAt: Date.now(), description, tier, workerId, cwd });
}

/** Log delegate result to *-results.jsonl. Call when a task resolves. Returns void. */
function logDelegateResult(
	taskId: string, 
	status: string, 
	summary: string,
	details?: {
		filesChanged?: string[];
		diffLength?: number;
		bashExitCodes?: number[];
		bashCount?: number;
	}
): void {
	const meta = taskMetadataMap.get(taskId);
	if (!meta) return;
	taskMetadataMap.delete(taskId);
	try {
		const { config } = loadConfig();
		if (!config.dashboardEnabled || !config.dashboardLogResponses) return;
		const entry: Record<string, unknown> = {
			timestamp: Date.now(),
			taskId,
			workerId: meta.workerId,
			tier: meta.tier,
			durationMs: Date.now() - meta.startedAt,
			status,
			summary: summary.slice(0, 4096),
		};
		if (details?.filesChanged) entry.filesChanged = details.filesChanged;
		if (details?.diffLength !== undefined) entry.diffLength = details.diffLength;
		if (details?.bashExitCodes) entry.bashExitCodes = details.bashExitCodes;
		if (details?.bashCount !== undefined) entry.bashCount = details.bashCount;
		appendJsonlEntry(getResultsLogPath(meta.cwd), entry, config.dashboardRetention);
	} catch {
		// Best-effort
	}
}

/** Log mind response to *-responses.jsonl at agent_end. Caps text at ~4KB. */
function logMindResponse(cwd: string, text: string): void {
	try {
		const { config } = loadConfig();
		if (!config.dashboardEnabled || !config.dashboardLogResponses) return;
		const capped = text.slice(0, 4096);
		const entry = {
			timestamp: Date.now(),
			textLength: text.length,
			text: capped,
			truncated: text.length > 4096,
		};
		appendJsonlEntry(getResponsesLogPath(cwd), entry, config.dashboardRetention);
	} catch {
		// Best-effort
	}
}

/** Append a JSON entry to a JSONL file and trim to maxEntries. */
function appendJsonlEntry(filePath: string, entry: Record<string, unknown>, maxEntries: number): void {
	ensureDir(dirname(filePath));
	try {
		let lines: string[] = [];
		try {
			const existing = readFileSync(filePath, "utf-8");
			lines = existing.split("\n").filter(l => l.trim());
		} catch {
			/* file may not exist */
		}
		lines.push(JSON.stringify(entry));
		// Trim to maxEntries (retain last N)
		if (lines.length > maxEntries) {
			lines = lines.slice(lines.length - maxEntries);
		}
		const tmpPath = filePath + ".tmp";
		writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
		renameSync(tmpPath, filePath);
	} catch {
		// Best-effort
	}
}

/** Start dashboard heartbeat timer. Writes control file status periodically. */
function startDashboardHeartbeat(cwd: string): void {
	stopDashboardHeartbeat();
	const { config } = loadConfig();
	if (!config.dashboardEnabled) return;
	lastDashboardCwd = cwd;
	dashboardHeartbeatTimer = setInterval(() => {
		// Re-write current status to update lastHeartbeat
		if (lastDashboardStatus && lastDashboardCwd === cwd) {
			writeControlFileStatus(cwd, lastDashboardStatus);
		}
	}, config.dashboardHeartbeatMs);
}

/** Stop dashboard heartbeat timer. */
function stopDashboardHeartbeat(): void {
	if (dashboardHeartbeatTimer) {
		clearInterval(dashboardHeartbeatTimer);
		dashboardHeartbeatTimer = null;
	}
	lastDashboardStatus = "";
	lastDashboardCwd = "";
}

function getCwdHash(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function ensureDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function getStateDir(): string {
	return join(getAgentDir(), "mindworker");
}

function getSocketPath(cwd: string): string {
	return join(getStateDir(), `${getCwdHash(cwd)}.sock`);
}

function getPlanPath(cwd: string): string {
	return join(getStateDir(), `${getCwdHash(cwd)}-plan.md`);
}

function getControlFilePath(cwd: string): string {
	return join(getStateDir(), `${getCwdHash(cwd)}-mind-control.json`);
}

/** Check if supervisor is in stop phase — extension must not write control file during stop. */
function isStopPhase(cwd: string): boolean {
	const manifest = readManifest(cwd);
	const generation = manifest?.generation ?? 0;
	const controlPath = getControlFilePath(cwd);
	try {
		const ctrl = JSON.parse(readFileSync(controlPath, "utf-8"));
		return ctrl.command === "stop" && ctrl.generation === generation;
	} catch {
		return false;
	}
}

/** Atomic control-file write with stop-phase guard. Skips write if stop in progress.
 *  Preserves existing command/message fields to avoid erasing a pending stop command.
 *  Legacy path (no launcher role) skips all control-file status writes.
 *  Optional `message` param written to control file (e.g. error detail). */
function writeControlFileStatus(cwd: string, status: string, message?: string): void {
	// Legacy path: no launcher, no control file writes
	if (LAUNCHER_ROLE_FLAG !== "mind") return;
	// Stop phase: supervisor owns status, extension must not write
	if (isStopPhase(cwd)) return;

	// Track last status for heartbeat writes
	lastDashboardStatus = status;

	const controlPath = getControlFilePath(cwd);
	const manifest = readManifest(cwd);
	const generation = manifest?.generation ?? 0;
	ensureDir(dirname(controlPath));
	try {
		// Read existing to preserve command/message fields (e.g. pending stop)
		let existing: Record<string, unknown> = {};
		try {
			existing = JSON.parse(readFileSync(controlPath, "utf-8"));
		} catch {
			/* file may not exist yet */
		}

		const data: Record<string, unknown> = {
			status,
			generation,
			lastUpdated: Date.now(),
		};

		// Add worker connection counts for launcher visibility
		const activeWorkers = [...workerPool.values()].filter(w => !w.socket.destroyed).length;
		if (activeWorkers > 0) {
			data.connectedWorkers = activeWorkers;
		}
		data.expectedWorkers = maxWorkers;

		// Dashboard extension: add schema v2 fields when dashboardEnabled
		try {
			const { config } = loadConfig();
			if (config.dashboardEnabled) {
				data.schemaVersion = 2;
				data.lastHeartbeat = Date.now();
				
				// activeTasks: currently executing tasks
				const activeTasks: Array<{ taskId: string; workerId: string; tier: string; startedAt?: number; description?: string }> = [];
				for (const [taskId, workerId] of taskWorkerMap.entries()) {
					const conn = workerPool.get(workerId);
					if (conn && !conn.socket.destroyed) {
						const meta = taskMetadataMap.get(taskId);
						activeTasks.push({
							taskId,
							workerId,
							tier: conn.tier,
							startedAt: meta?.startedAt,
							description: meta?.description?.slice(0, 100),
						});
					}
				}
				data.activeTasks = activeTasks;
				
				// queuedTasks: pending tasks in queue
				data.queuedTasks = pendingQueue.map(q => ({
					id: q.id,
					tier: q.tier || "any",
					description: q.task.slice(0, 100),
				}));
				
				// workers: all connected workers with status
				data.workers = [...workerPool.values()]
					.filter(w => !w.socket.destroyed)
					.map(w => {
						const base: Record<string, unknown> = {
							workerId: w.workerId,
							tier: w.tier,
							busy: w.busy,
							taskId: w.taskId,
							connectedAt: w.connectedAt,
						};
						if (isBurstWorker(w.workerId)) {
							const state = burstWorkers.get(w.workerId);
							if (state) {
								base.burst = true;
								base.pid = state.pid;
								base.sessionDir = state.sessionDir;
								base.logPath = state.logPath;
								base.taskCount = state.taskCount;
								base.lastEvent = state.lastEvent;
								base.lastEventAt = state.lastEventAt;
								base.launchMode = state.launchMode;
								base.paneTitle = state.paneTitle;
								base.kittyWindowId = state.kittyWindowId;
							}
						}
						return base;
					});

				// burstFlash: top-level summary
				{
					const connectedBurst = [...workerPool.values()].filter(w => isBurstWorker(w.workerId) && !w.socket.destroyed).length;
					const totalBurst = burstWorkers.size;
					const maxBurst = config.burstFlash?.maxBurst ?? 0;
					const activeBurst = [...workerPool.values()].filter(w => isBurstWorker(w.workerId) && w.busy && !w.socket.destroyed).length;
					const idleBurst = connectedBurst - activeBurst;
					data.burstFlash = { connected: connectedBurst, total: totalBurst, max: maxBurst, active: activeBurst, idle: idleBurst };
				}
			}
		} catch {
			// Best-effort: if config load fails, skip dashboard fields
		}

		// If caller explicitly passed a message, use it (overrides existing)
		if (message !== undefined) {
			data.message = message;
		} else if (existing.generation === generation && existing.message) {
			// Otherwise carry forward existing message from same generation
			data.message = existing.message;
		}

		// Carry forward command only from same generation (stale otherwise)
		if (existing.generation === generation && existing.command) {
			data.command = existing.command;
		}

		const tmpPath = controlPath + ".tmp";
		writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
		renameSync(tmpPath, controlPath);
	} catch {
		// Best-effort
	}
}

/** Best-effort control file write for launcher path. Includes generation from manifest. */
function writeControlFileReady(cwd: string): void {
	writeControlFileStatus(cwd, "ready");
}

function getManifestPath(cwd: string): string {
	return join(getStateDir(), `${getCwdHash(cwd)}-manifest.json`);
}

function readManifest(cwd: string): Record<string, unknown> | null {
	const path = getManifestPath(cwd);
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

const STATE_TRANSITIONS: Record<string, string[]> = {
	starting: ["running", "stopped"],
	running: ["stopped"],
	stopped: [],
};

function validateStateTransition(current: string, next: string): boolean {
	return STATE_TRANSITIONS[current]?.includes(next) ?? false;
}

/** Write manifest state to "running" with generation confirmation. */
function writeManifestRunning(cwd: string): void {
	const manifestPath = getManifestPath(cwd);
	try {
		const manifest = readManifest(cwd);
		if (!manifest) return; // no manifest → legacy path, skip
		if (manifest.state === "running") return;
		if (!validateStateTransition(manifest.state as string, "running")) {
			console.error(`[mind-worker] Invalid manifest transition: ${manifest.state} → running`);
			return;
		}
		manifest.state = "running";
		manifest.lastUpdated = Date.now();
		const tmpPath = manifestPath + ".tmp";
		writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf-8");
		renameSync(tmpPath, manifestPath);
	} catch {
		// Best-effort
	}
}

/** Write "busy" status (delegate in progress). */
function writeControlFileBusy(cwd: string): void {
	writeControlFileStatus(cwd, "busy");
}

/** Restore idle status — "worker-connected" if any worker active, else "ready". */
function writeControlFileIdle(cwd: string): void {
	if (hasPendingWork()) {
		writeControlFileStatus(cwd, "busy");
		return;
	}
	const anyAlive = [...workerPool.values()].some(w => !w.socket.destroyed);
	writeControlFileStatus(cwd, anyAlive ? "worker-connected" : "ready");
}

/** Write "worker-connected" status with current connection count. */
function writeControlFileWorkerConnected(cwd: string): void {
	const activeCount = [...workerPool.values()].filter(w => !w.socket.destroyed).length;
	writeControlFileStatus(cwd, activeCount > 0 ? "worker-connected" : "ready");
}

function getConfigPath(): string {
	return join(getAgentDir(), "mind-worker.json");
}

function resolveWorkerModels(config: MindWorkerConfig): WorkerModelEntry[] {
	const resolved: WorkerModelEntry[] = [];
	if (Array.isArray(config.workerModels) && config.workerModels.length > 0) {
		let valid = true;
		for (const entry of config.workerModels) {
			if (typeof entry.model !== "string" || !entry.model.trim()) { valid = false; break; }
			if (typeof entry.count !== "number" || entry.count < 1 || entry.count > 10) { valid = false; break; }
			const tier = entry.tier || "flash";
			if (tier !== "flash" && tier !== "strong") { valid = false; break; }
		}
		if (valid) {
			const total = config.workerModels.reduce((sum: number, e) => sum + e.count, 0);
			if (total >= 1 && total <= 10) {
				for (const entry of config.workerModels) {
					const tier = entry.tier || "flash";
					for (let i = 0; i < entry.count; i++) {
						resolved.push({ model: entry.model.trim(), tier });
					}
				}
			}
		}
		if (resolved.length === 0) {
			console.warn("[mind-worker] workerModels validation failed — falling back to legacy config");
		}
	}
	if (resolved.length === 0) {
		// Fallback: workerModel x workerCount, all flash
		for (let i = 0; i < config.workerCount; i++) {
			resolved.push({ model: config.workerModel, tier: "flash" });
		}
	}
	return resolved;
}

function loadConfig(): { config: MindWorkerConfig; created: boolean; resolvedWorkers: WorkerModelEntry[] } {
	const path = getConfigPath();
	if (!existsSync(path)) {
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
		const resolved = resolveWorkerModels(DEFAULT_CONFIG);
		return { config: DEFAULT_CONFIG, created: true, resolvedWorkers: resolved };
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<MindWorkerConfig>;

		// Type validation warnings for new fields
		if (parsed.resetTimeout !== undefined && (typeof parsed.resetTimeout !== "number" || parsed.resetTimeout <= 0)) {
			console.warn("[mind-worker] resetTimeout must be a positive number — using default 5");
		}
		if (parsed.kittyEnabled !== undefined && typeof parsed.kittyEnabled !== "boolean") {
			console.warn("[mind-worker] kittyEnabled must be a boolean — using default true");
		}
		if (parsed.workerCount !== undefined && (typeof parsed.workerCount !== "number" || parsed.workerCount < 1 || parsed.workerCount > 10)) {
			console.warn("[mind-worker] workerCount must be 1-10 — using default 3");
		}
		if (parsed.dashboardRetention !== undefined && (typeof parsed.dashboardRetention !== "number" || parsed.dashboardRetention < 1)) {
			console.warn("[mind-worker] dashboardRetention must be a positive number — using default 200");
		}
		if (parsed.dashboardHeartbeatMs !== undefined && (typeof parsed.dashboardHeartbeatMs !== "number" || parsed.dashboardHeartbeatMs < 1000)) {
			console.warn("[mind-worker] dashboardHeartbeatMs must be >= 1000 — using default 10000");
		}
		if (parsed.dashboardStaleMs !== undefined && (typeof parsed.dashboardStaleMs !== "number" || parsed.dashboardStaleMs < 3000)) {
			console.warn("[mind-worker] dashboardStaleMs must be >= 3000 — using default 30000");
		}

		// Parse burstFlash config block
		const rawBurst = parsed.burstFlash || {};
		const burstFlash: BurstFlashConfig = {
			enabled: typeof rawBurst.enabled === "boolean" ? rawBurst.enabled : DEFAULT_BURST_FLASH_CONFIG.enabled,
			model: typeof rawBurst.model === "string" && rawBurst.model.trim() ? rawBurst.model.trim() : DEFAULT_BURST_FLASH_CONFIG.model,
			maxBurst: typeof rawBurst.maxBurst === "number" && rawBurst.maxBurst >= 0 && rawBurst.maxBurst <= 10
				? rawBurst.maxBurst : DEFAULT_BURST_FLASH_CONFIG.maxBurst,
			idleTtlMs: typeof rawBurst.idleTtlMs === "number" && rawBurst.idleTtlMs >= 10000
				? rawBurst.idleTtlMs : DEFAULT_BURST_FLASH_CONFIG.idleTtlMs,
			maxTasksPerWorker: typeof rawBurst.maxTasksPerWorker === "number" && rawBurst.maxTasksPerWorker >= 1 && rawBurst.maxTasksPerWorker <= 100
				? rawBurst.maxTasksPerWorker : DEFAULT_BURST_FLASH_CONFIG.maxTasksPerWorker,
			launchMode: (rawBurst.launchMode === "kitty" ? "kitty" : "headless") as "headless" | "kitty",
			queuePressureThreshold: typeof rawBurst.queuePressureThreshold === "number" && rawBurst.queuePressureThreshold >= 1
				? rawBurst.queuePressureThreshold : DEFAULT_BURST_FLASH_CONFIG.queuePressureThreshold,
			spawnWaitMs: typeof rawBurst.spawnWaitMs === "number" && rawBurst.spawnWaitMs >= 500
				? rawBurst.spawnWaitMs : DEFAULT_BURST_FLASH_CONFIG.spawnWaitMs,
			killTimeoutMs: typeof rawBurst.killTimeoutMs === "number" && rawBurst.killTimeoutMs >= 500
				? rawBurst.killTimeoutMs : DEFAULT_BURST_FLASH_CONFIG.killTimeoutMs,
			logDetail: (rawBurst.logDetail === "full" ? "full" : "compact") as "compact" | "full",
		};
		if (burstFlash.enabled && burstFlash.maxBurst === 0) {
			console.warn("[mind-worker] burstFlash.maxBurst=0 effectively disables burst spawning");
		}

		const wc = typeof parsed.workerCount === "number" && parsed.workerCount >= 1 && parsed.workerCount <= 10
			? parsed.workerCount : DEFAULT_CONFIG.workerCount;

		const config: MindWorkerConfig = {
			mindModel: parsed.mindModel || DEFAULT_CONFIG.mindModel,
			workerModel: parsed.workerModel || DEFAULT_CONFIG.workerModel,
			timeout: typeof parsed.timeout === "number" ? parsed.timeout : DEFAULT_CONFIG.timeout,
			statusStream: parsed.statusStream !== false,
			autoSpawnWorker: parsed.autoSpawnWorker !== false,
			notifyOnMindIdle: parsed.notifyOnMindIdle === true,
			ntfyTopic: parsed.ntfyTopic || DEFAULT_CONFIG.ntfyTopic,
			ntfyServer: parsed.ntfyServer || DEFAULT_CONFIG.ntfyServer,
			resetTimeout: typeof parsed.resetTimeout === "number" && parsed.resetTimeout > 0
				? parsed.resetTimeout : DEFAULT_CONFIG.resetTimeout,
			kittyEnabled: typeof parsed.kittyEnabled === "boolean"
				? parsed.kittyEnabled : DEFAULT_CONFIG.kittyEnabled,
			workerCount: wc,
			workerModels: parsed.workerModels,
			dashboardEnabled: parsed.dashboardEnabled !== false,
			dashboardRetention: typeof parsed.dashboardRetention === "number" && parsed.dashboardRetention >= 1
				? parsed.dashboardRetention : DEFAULT_CONFIG.dashboardRetention,
			dashboardHeartbeatMs: typeof parsed.dashboardHeartbeatMs === "number" && parsed.dashboardHeartbeatMs >= 1000
				? parsed.dashboardHeartbeatMs : DEFAULT_CONFIG.dashboardHeartbeatMs,
			dashboardStaleMs: typeof parsed.dashboardStaleMs === "number" && parsed.dashboardStaleMs >= 3000
				? parsed.dashboardStaleMs : DEFAULT_CONFIG.dashboardStaleMs,
			dashboardLogResponses: parsed.dashboardLogResponses !== false,
			burstFlash,
		};
		const resolved = resolveWorkerModels(config);
		return { config, created: false, resolvedWorkers: resolved };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[mind-worker] Failed to parse ${path}: ${msg}. Falling back to DEFAULT_CONFIG.`);
		const resolved = resolveWorkerModels(DEFAULT_CONFIG);
		return { config: DEFAULT_CONFIG, created: false, resolvedWorkers: resolved };
	}
}

function parseLines(onLine: (line: string) => void) {
	let buffer = "";
	return (chunk: Buffer) => {
		buffer += chunk.toString("utf-8");
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			onLine(line);
		}
	};
}

function sendJson(socket: Socket, msg: SocketMsg): boolean {
	if (socket.destroyed) return false;
	return socket.write(`${JSON.stringify(msg)}\n`);
}

async function setModelFromId(pi: ExtensionAPI, ctx: ExtensionContext, modelId: string): Promise<void> {
	const [provider, id] = modelId.split("/");
	if (!provider || !id) return;
	const model = ctx.modelRegistry?.find(provider, id);
	if (!model) return;
	await pi.setModel(model);
}

async function getProjectSnapshot(cwd: string): Promise<string> {
	const chunks: string[] = ["# Project Snapshot"];
	try {
		const { stdout } = await execAsync(
			"tree -L 2 --dirsfirst 2>/dev/null || find . -maxdepth 2 -not -path '*/\\.*' | sort | head -80",
			{ cwd },
		);
		chunks.push(`\n## File Tree\n\`\`\`\n${stdout.slice(0, 4000)}\n\`\`\``);
	} catch {
		chunks.push("\n## File Tree\n(unavailable)");
	}

	try {
		const { stdout } = await execAsync("git status --short 2>/dev/null || echo '(not a git repo)'", { cwd });
		chunks.push(`\n## Git Status\n\`\`\`\n${stdout.slice(0, 2000)}\n\`\`\``);
	} catch {
		/* ignore */
	}

	try {
		const { stdout } = await execAsync("git log --oneline -5 2>/dev/null || echo '(no git history)'", { cwd });
		chunks.push(`\n## Recent Commits\n\`\`\`\n${stdout.slice(0, 1000)}\n\`\`\``);
	} catch {
		/* ignore */
	}

	return chunks.join("\n");
}

async function getGitDiff(cwd: string): Promise<{ diff: string; filesChanged: string[] }> {
	try {
		const { stdout } = await execAsync("git diff --no-color 2>/dev/null || true", { cwd });
		const files = new Set<string>();
		for (const line of stdout.split("\n")) {
			const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
			if (m) files.add(m[1]);
		}
		return { diff: stdout.slice(0, 50000), filesChanged: [...files] };
	} catch {
		return { diff: "", filesChanged: [] };
	}
}

function extractLastAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = Array.isArray(msg.content)
			? msg.content.find((c: any) => c.type === "text")?.text
			: "";
		if (text) return text;
	}
	return "";
}

async function sendMindIdleNotification(config: MindWorkerConfig, ctx: ExtensionContext, summary?: string): Promise<void> {
	if (!config.notifyOnMindIdle) return;
	if (currentRole !== "mind") return;

	const cwd = ctx.cwd || process.cwd();
	const shortHash = getCwdHash(cwd);
	const instanceLabel = cwd.split("/").filter(Boolean).pop() || cwd;
	const title = `🧠 Mind Idle — [${shortHash}] ${instanceLabel}`;
	const body = summary
		? `🧠 Mind done — waiting for user\nInstance: ${instanceLabel} (${shortHash})\nCWD: ${cwd}\nSummary: ${summary.slice(0, 200)}`
		: `🧠 Mind done — waiting for user\nInstance: ${instanceLabel} (${shortHash})\nCWD: ${cwd}`;

	const fingerprint = createHash("sha256").update(body + title).digest("hex");
	const now = Date.now();
	if (fingerprint === lastNotificationFingerprint && now - lastNotificationTime < NOTIFICATION_COOLDOWN_MS) {
		return;
	}
	lastNotificationFingerprint = fingerprint;
	lastNotificationTime = now;

	// Desktop notification via notify-send
	try {
		await execFileAsync("notify-send", [title, body]);
	} catch {
		// Swallow notify-send errors
	}

	// ntfy push (only when topic configured)
	if (!config.ntfyTopic) return;
	try {
		const url = `${config.ntfyServer.replace(/\/+$/, "")}/${config.ntfyTopic}`;
		await execFileAsync("curl", [
			"-X", "POST",
			"-d", body,
			"-H", `Title: ${title}`,
			"--connect-timeout", "5",
			"--max-time", "10",
			url,
		]);
	} catch {
		// Swallow ntfy errors
	}
}

function failPendingTasks(message: string, code = "DISCONNECT"): void {
	// Fail queued tasks
	for (const entry of pendingQueue) {
		entry.resolve({
			content: [{ type: "text", text: message }],
			isError: true,
			details: { code },
		});
	}
	pendingQueue.length = 0;
	// Fail in-flight tasks
	for (const [id, resolve] of pendingResolvers) {
		resolve({ type: "error", id, code, message });
	}
	pendingResolvers.clear();
	pendingUpdates.clear();
	taskWorkerMap.clear();
	// Clear subdelegate state
	subdelegateTrackers.clear();
	subdelegateReverseMap.clear();
	subdelegateWaiters.clear();
}

function failPendingTasksForWorker(workerId: string, message: string, code = "DISCONNECT"): void {
	const failedIds: string[] = [];
	for (const [taskId, wid] of taskWorkerMap) {
		if (wid === workerId) {
			failedIds.push(taskId);
		}
	}
	for (const id of failedIds) {
		taskWorkerMap.delete(id);
		pendingUpdates.delete(id);
		const resolve = pendingResolvers.get(id);
		if (resolve) {
			pendingResolvers.delete(id);
			resolve({ type: "error", id, code, message });
		}
	}
}

/** Find first idle (non-busy, connected) worker from the pool. Optionally filter by tier. */
function findIdleWorker(tier?: string): { workerId: string; connection: WorkerConnection } | null {
	for (const [wid, conn] of workerPool) {
		if (!conn.busy && !conn.socket.destroyed) {
			if (tier && conn.tier !== tier) continue;
			// Skip stale burst workers whose state has been cleaned up
			if (isBurstWorker(wid) && !burstWorkers.has(wid)) continue;
			return { workerId: wid, connection: conn };
		}
	}
	return null;
}

/** Find all idle workers, optionally filtered by tier. */
function findAllIdleWorkers(tier?: string): Array<{ workerId: string; connection: WorkerConnection }> {
	const idle: Array<{ workerId: string; connection: WorkerConnection }> = [];
	for (const [wid, conn] of workerPool) {
		if (!conn.busy && !conn.socket.destroyed) {
			if (tier && conn.tier !== tier) continue;
			// Skip stale burst workers whose state has been cleaned up
			if (isBurstWorker(wid) && !burstWorkers.has(wid)) continue;
			idle.push({ workerId: wid, connection: conn });
		}
	}
	return idle;
}

/** Count busy workers in the pool. */
function countBusyWorkers(): number {
	let busy = 0;
	for (const [, conn] of workerPool) {
		if (conn.busy && !conn.socket.destroyed) busy++;
	}
	return busy;
}

/** Pop next queued task (matching worker tier) and dispatch to given idle worker. Returns true if dispatched. */
function dispatchNextQueued(workerId: string, connection: WorkerConnection, ctx: ExtensionContext): boolean {
	if (connection.busy) return false;
	if (pendingQueue.length === 0) return false;
	if (connection.socket.destroyed) return false;
	// Skip retired/stale burst workers whose state has been cleaned up
	if (isBurstWorker(workerId) && !burstWorkers.has(workerId)) return false;

	// Scan queue for first entry matching this worker's tier (or any if entry has no tier preference)
	let matchIdx = -1;
	for (let i = 0; i < pendingQueue.length; i++) {
		const e = pendingQueue[i];
		if (!e.tier || e.tier === connection.tier) {
			matchIdx = i;
			break;
		}
	}
	if (matchIdx === -1) return false;
	const entry = pendingQueue.splice(matchIdx, 1)[0];

	const { config } = loadConfig();
	const id = entry.id;

	// Mark worker busy
	connection.busy = true;
	connection.taskId = id;
	taskWorkerMap.set(id, workerId);
	trackTaskStart(id, workerId, connection.tier, entry.task.slice(0, 100), entry.cwd);
	// Track burst worker task start
	if (isBurstWorker(workerId)) {
		onBurstWorkerTaskStart(workerId);
		logBurstEvent(entry.cwd, workerId, "task-start", id);
	}

	if (entry.onUpdate) pendingUpdates.set(id, entry.onUpdate);

	if (entry.plan) {
		const planPath = getPlanPath(entry.cwd);
		ensureDir(dirname(planPath));
		writeFileSync(planPath, entry.plan, "utf-8");
	}

	writeControlFileBusy(entry.cwd);

	const timeoutId = setTimeout(() => {
		pendingResolvers.delete(id);
		pendingUpdates.delete(id);
		taskWorkerMap.delete(id);
		if (workerPool.has(workerId)) {
			const conn = workerPool.get(workerId)!;
			conn.busy = false;
			conn.taskId = null;
		}
		if (!connection.socket.destroyed) {
			sendJson(connection.socket, { type: "abort", id });
		}
		// Dispatch next queued task now that worker is idle
		if (workerPool.has(workerId)) {
			const conn = workerPool.get(workerId)!;
			dispatchNextQueued(workerId, conn, ctx);
		}
		writeControlFileIdle(entry.cwd);
		logDelegateResult(id, "timeout", `Worker "${workerId}" timeout after ${config.timeout}s`);
		entry.resolve({
			content: [{ type: "text", text: `Worker "${workerId}" timeout after ${config.timeout}s` }],
			isError: true,
			details: { code: "TIMEOUT" },
		});
	}, Math.max(1, config.timeout) * 1000);

	pendingResolvers.set(id, (msg) => {
		clearTimeout(timeoutId);
		pendingResolvers.delete(id);
		pendingUpdates.delete(id);
		taskWorkerMap.delete(id);
		writeControlFileIdle(entry.cwd);
		const status = msg.type === "result" ? "completed" : "error";
		const summary = msg.explanation || msg.message || "(no result)";
		const details = {
			filesChanged: msg.filesChanged,
			diffLength: msg.diff?.length,
			bashExitCodes: msg.bashResults?.map(r => r.exitCode),
			bashCount: msg.bashResults?.length,
		};
		logDelegateResult(id, status, summary, details);
		if (msg.type === "result") {
			entry.resolve({
				content: [{ type: "text", text: msg.explanation || "(no explanation)" }],
				details: {
					diff: msg.diff || "",
					filesChanged: msg.filesChanged || [],
					bashResults: msg.bashResults || [],
				},
			});
		} else {
			entry.resolve({
				content: [{ type: "text", text: msg.message || "Worker error" }],
				isError: true,
				details: { code: msg.code || "ERROR" },
			});
		}
	});

	sendJson(connection.socket, {
		type: "task",
		id,
		task: entry.task,
		step: entry.step,
		plan: entry.plan,
		context: entry.context,
		reset: entry.reset,
	});

	if (entry.signal) {
		const onAbort = () => {
			clearTimeout(timeoutId);
			pendingResolvers.delete(id);
			pendingUpdates.delete(id);
			taskWorkerMap.delete(id);
			if (workerPool.has(workerId)) {
				const conn = workerPool.get(workerId)!;
				conn.busy = false;
				conn.taskId = null;
			}
			if (!connection.socket.destroyed) {
				sendJson(connection.socket, { type: "abort", id });
			}
			// Dispatch next queued task now that worker is idle
			if (workerPool.has(workerId)) {
				const conn = workerPool.get(workerId)!;
				dispatchNextQueued(workerId, conn, ctx);
			}
			writeControlFileIdle(entry.cwd);
			logDelegateResult(id, "aborted", "Task aborted");
			entry.resolve({ content: [{ type: "text", text: "Task aborted" }], isError: true });
		};
		if (entry.signal.aborted) onAbort();
		else entry.signal.addEventListener("abort", onAbort, { once: true });
	}

	return true;
}

/** Returns true if any work is pending (busy workers or queued tasks). */
function hasPendingWork(): boolean {
	if (pendingQueue.length > 0) return true;
	for (const [, conn] of workerPool) {
		if (conn.busy && !conn.socket.destroyed) return true;
	}
	return false;
}

function startMindServer(cwd: string, ctx: ExtensionContext): void {
	const socketPath = getSocketPath(cwd);
	ensureDir(dirname(socketPath));

	if (mindServer) {
		try { mindServer.close(); } catch { /* ignore */ }
		mindServer = null;
	}
	// Destroy all existing worker connections
	for (const [, conn] of workerPool) {
		try { conn.socket.destroy(); } catch { /* ignore */ }
	}
	workerPool.clear();
	taskWorkerMap.clear();
	if (existsSync(socketPath)) {
		try { unlinkSync(socketPath); } catch { /* ignore */ }
	}

	mindServer = createServer((socket) => {
		let handshakeDone = false;
		let assignedWorkerId: string | null = null;

		socket.on(
			"data",
			parseLines((line) => {
				let msg: SocketMsg;
				try { msg = JSON.parse(line); } catch { return; }

				// ── Handshake phase ──────────────────────────────────
				if (!handshakeDone) {
					if (msg.type === "handshake") {
						const workerTier = (msg.tier || "flash") as string;

						// Tier-aware pool capacity guard (fallback to total maxWorkers if tier unknown)
						const { config: cfg, resolvedWorkers } = loadConfig();
						const isBurst = (msg.workerId || "").startsWith("burst-flash-");
						if (isBurst) {
							// Burst workers: enforce flash tier + respect burstFlash.maxBurst cap
							if (!cfg.burstFlash.enabled) {
								sendJson(socket, { type: "error", code: "POOL_FULL", message: "Burst flash disabled" });
								socket.destroy();
								return;
							}
							if (workerTier !== "flash") {
								sendJson(socket, { type: "error", code: "TIER_MISMATCH", message: "Burst workers must be flash tier" });
								socket.destroy();
								return;
							}
							// Allow known spawned burst workers even if cap reached
							if (!burstWorkers.has(msg.workerId)) {
								const connectedBurst = [...workerPool.values()].filter(w => isBurstWorker(w.workerId) && !w.socket.destroyed).length;
								if (connectedBurst >= cfg.burstFlash.maxBurst) {
									sendJson(socket, { type: "error", code: "POOL_FULL", message: `Max ${cfg.burstFlash.maxBurst} burst workers already connected` });
									socket.destroy();
									return;
								}
							}
						} else {
							const tierWorkers = resolvedWorkers.filter(w => w.tier === workerTier).length;
							const tierConnected = [...workerPool.values()].filter(w => w.tier === workerTier && !w.socket.destroyed).length;
							if (tierWorkers === 0) {
								// Tier not in resolved config (defensive) — use total pool limit
								if (workerPool.size >= maxWorkers) {
									sendJson(socket, { type: "error", code: "POOL_FULL", message: `Max ${maxWorkers} workers already connected` });
									socket.destroy();
									return;
								}
							} else if (tierConnected >= tierWorkers) {
								sendJson(socket, { type: "error", code: "POOL_FULL", message: `Max ${tierWorkers} ${workerTier} workers already connected` });
								socket.destroy();
								return;
							}
						}

					// Launcher-path worker: validate generation
						const manifest = readManifest(cwd);
						const manifestGen = (manifest?.generation as number) ?? 0;
						if (!msg.generation || !manifestGen || msg.generation !== manifestGen) {
							const errMsg = `Generation mismatch: worker=${msg.generation || "none"}, mind=${manifestGen}. Reconnecting.`;
							console.error(`[mind-worker] HANDSHAKE REJECT: ${errMsg}`);
							sendJson(socket, { type: "error", code: "GENERATION_MISMATCH", message: errMsg });
							if (LAUNCHER_ROLE_FLAG === "mind") {
								writeControlFileStatus(cwd, "error", errMsg);
							}
							socket.end();
							return;
						}

						// Determine workerId from handshake or auto-assign
						const candidateId = msg.workerId || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
						if (workerPool.has(candidateId)) {
							const errMsg = `Worker ${candidateId} already connected`;
							sendJson(socket, { type: "error", code: "DUPLICATE_ID", message: errMsg });
							socket.end();
							return;
						}

						// Accept into pool
						handshakeDone = true;
						assignedWorkerId = candidateId;
						workerPool.set(assignedWorkerId, {
							socket, busy: false, taskId: null,
							workerId: assignedWorkerId, connectedAt: Date.now(),
							tier: workerTier,
						});
						// Mark burst worker as connected
						if (isBurst) {
							onBurstWorkerConnected(assignedWorkerId);
							console.error(`[burst-flash] ${assignedWorkerId} connected to socket`);
						}
						// Dispatch any queued tasks to this new worker
						if (pendingQueue.length > 0) {
							dispatchNextQueued(assignedWorkerId, workerPool.get(assignedWorkerId)!, ctx);
						}
						console.error(`[mind-worker] Handshake OK, worker=${assignedWorkerId}, tier=${workerTier}, gen=${msg.generation}`);
						ctx.ui.notify(`Worker ${assignedWorkerId} [${workerTier}] connected (${workerPool.size}/${maxWorkers})`, "success");
						ctx.ui.setStatus("mind-worker", `🔵 mind (${workerPool.size}/${maxWorkers})`);
						if (LAUNCHER_ROLE_FLAG === "mind") {
							writeControlFileWorkerConnected(cwd);
						}
						return;
					}
					// Launcher path: hard-require handshake as first message
					if (LAUNCHER_ROLE_FLAG === "mind") {
						const errMsg = "First message must be handshake.";
						sendJson(socket, { type: "error", code: "HANDSHAKE_REQUIRED", message: errMsg });
						writeControlFileStatus(cwd, "error", errMsg);
						socket.end();
						return;
					}
					// Legacy path (no handshake) — accept immediately with total pool guard
					if (workerPool.size >= maxWorkers) {
						sendJson(socket, { type: "error", code: "POOL_FULL", message: `Max ${maxWorkers} workers already connected` });
						socket.destroy();
						return;
					}
					handshakeDone = true;
					assignedWorkerId = `legacy-${Date.now()}`;
					workerPool.set(assignedWorkerId, {
						socket, busy: false, taskId: null,
						workerId: assignedWorkerId, connectedAt: Date.now(),
						tier: "flash",
					});
					// Dispatch any queued tasks to this new worker
					if (pendingQueue.length > 0) {
						dispatchNextQueued(assignedWorkerId, workerPool.get(assignedWorkerId)!, ctx);
					}
					ctx.ui.notify("Worker connected", "success");
					ctx.ui.setStatus("mind-worker", `🔵 mind (${workerPool.size})`);
					// Fall through to process this first message normally
				}

				// ── Subdelegate request from strong worker ─────────────
				if (msg.type === "subdelegate-request" && msg.id) {
					const requesterId = assignedWorkerId;
					if (!requesterId || !workerPool.has(requesterId)) {
						sendJson(socket, { type: "subdelegate-response", id: msg.id, error: "Unknown requester worker", code: "UNKNOWN_REQUESTER" });
						return;
					}
					const requester = workerPool.get(requesterId)!;
					if (requester.tier !== "strong") {
						sendJson(socket, { type: "subdelegate-response", id: msg.id, error: "Only strong-tier workers may subdelegate. Flash workers cannot delegate.", code: "TIER_BLOCKED" });
						return;
					}
					if (!msg.task?.trim()) {
						sendJson(socket, { type: "subdelegate-response", id: msg.id, error: "task is required", code: "INVALID_PARAMS" });
						return;
					}
					// Generate task ID for flash worker
					const flashTaskId = `subdel-flash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					// Track this subdelegation (both forward and reverse maps)
					subdelegateTrackers.set(flashTaskId, {
						requesterWorkerId: requesterId,
						requesterSocket: socket,
						subdelegateId: msg.id,
					});
					subdelegateReverseMap.set(msg.id, flashTaskId);
					// Find idle flash worker or queue
					const idle = findIdleWorker("flash");
					if (!idle) {
						const flashConnected = [...workerPool.values()].filter(w => w.tier === "flash" && !w.socket.destroyed).length;
						if (flashConnected === 0) {
							// Check burst flash as fallback instead of immediate reject
							const { config: subCfg } = loadConfig();
							if (!subCfg.burstFlash.enabled || subCfg.burstFlash.maxBurst === 0) {
								subdelegateTrackers.delete(flashTaskId);
								subdelegateReverseMap.delete(msg.id);
								sendJson(socket, { type: "subdelegate-response", id: msg.id, error: "No flash workers connected. Workers start automatically — retry shortly.", code: "NO_FLASH_WORKERS" });
								return;
							}
							// Burst available — enqueue, but reject if queue full and burst cap reached
							if (pendingQueue.length >= maxQueueSize) {
								const connectedBurst = [...workerPool.values()].filter(w => isBurstWorker(w.workerId) && !w.socket.destroyed).length;
								if (connectedBurst >= subCfg.burstFlash.maxBurst) {
									subdelegateTrackers.delete(flashTaskId);
									subdelegateReverseMap.delete(msg.id);
									sendJson(socket, { type: "subdelegate-response", id: msg.id, error: `All flash workers busy and queue full (${pendingQueue.length}/${maxQueueSize}). Retry later.`, code: "QUEUE_FULL" });
									return;
								}
							}
						} else {
							// Flash workers exist but all busy — queue if space
							if (pendingQueue.length >= maxQueueSize) {
								subdelegateTrackers.delete(flashTaskId);
								subdelegateReverseMap.delete(msg.id);
								sendJson(socket, { type: "subdelegate-response", id: msg.id, error: `All flash workers busy and queue full (${pendingQueue.length}/${maxQueueSize}). Retry later.`, code: "QUEUE_FULL" });
								return;
							}
						}
						// Enqueue for flash tier
						pendingQueue.push({
							id: flashTaskId,
							task: msg.task,
							step: msg.step,
							plan: msg.plan,
							context: msg.context,
							tier: "flash",
							ctx,
							queuedAt: Date.now(),
							resolve: (result) => {
								const tracker = subdelegateTrackers.get(flashTaskId);
								subdelegateTrackers.delete(flashTaskId);
								subdelegateReverseMap.delete(msg.id);
								pendingUpdates.delete(flashTaskId);
								taskWorkerMap.delete(flashTaskId);
								if (tracker && !tracker.requesterSocket.destroyed) {
									const response: SocketMsg = {
										type: "subdelegate-response",
										id: tracker.subdelegateId,
									};
									if (result.isError) {
										response.error = result.content?.[0]?.text || "Unknown error";
										response.code = result.details?.code || "ERROR";
									} else {
										response.explanation = result.content?.[0]?.text || "(no explanation)";
										response.diff = result.details?.diff || "";
										response.filesChanged = result.details?.filesChanged || [];
										response.bashResults = result.details?.bashResults || [];
									}
									sendJson(tracker.requesterSocket, response);
								}
							},
							signal: undefined,
							cwd,
						});
						writeControlFileBusy(cwd);
						// Try burst flash spawn (immediate + delayed retry) for queued subdelegate
						trySpawnBurstFlashWithRetry(cwd, ctx);
						return;
					}
					// Dispatch to idle flash worker
					const flashWorkerId = idle.workerId;
					const flashConn = idle.connection;
					flashConn.busy = true;
					flashConn.taskId = flashTaskId;
					taskWorkerMap.set(flashTaskId, flashWorkerId);
					writeControlFileBusy(cwd);
					const { config } = loadConfig();
					if (msg.plan) {
						const planPath = getPlanPath(cwd);
						ensureDir(dirname(planPath));
						writeFileSync(planPath, msg.plan, "utf-8");
					}
					const timeoutId = setTimeout(() => {
						const tracker = subdelegateTrackers.get(flashTaskId);
						subdelegateTrackers.delete(flashTaskId);
						if (tracker) subdelegateReverseMap.delete(tracker.subdelegateId);
						pendingResolvers.delete(flashTaskId);
						pendingUpdates.delete(flashTaskId);
						taskWorkerMap.delete(flashTaskId);
						if (workerPool.has(flashWorkerId)) {
							const conn = workerPool.get(flashWorkerId)!;
							conn.busy = false;
							conn.taskId = null;
							dispatchNextQueued(flashWorkerId, conn, ctx);
						}
						writeControlFileIdle(cwd);
						if (tracker && !tracker.requesterSocket.destroyed) {
							sendJson(tracker.requesterSocket, {
								type: "subdelegate-response",
								id: tracker.subdelegateId,
								error: `Subdelegate timeout after ${config.timeout}s`,
								code: "TIMEOUT",
							});
						}
						if (!flashConn.socket.destroyed) {
							sendJson(flashConn.socket, { type: "abort", id: flashTaskId });
						}
					}, Math.max(1, config.timeout) * 1000);
					pendingResolvers.set(flashTaskId, (resultMsg) => {
						clearTimeout(timeoutId);
						const tracker = subdelegateTrackers.get(flashTaskId);
						subdelegateTrackers.delete(flashTaskId);
						if (tracker) subdelegateReverseMap.delete(tracker.subdelegateId);
						pendingUpdates.delete(flashTaskId);
						taskWorkerMap.delete(flashTaskId);
						if (tracker && !tracker.requesterSocket.destroyed) {
							if (resultMsg.type === "error") {
								sendJson(tracker.requesterSocket, {
									type: "subdelegate-response",
									id: tracker.subdelegateId,
									error: resultMsg.message || "Worker error",
									code: resultMsg.code || "ERROR",
								});
							} else {
								sendJson(tracker.requesterSocket, {
									type: "subdelegate-response",
									id: tracker.subdelegateId,
									explanation: resultMsg.explanation || "(no explanation)",
									diff: resultMsg.diff || "",
									filesChanged: resultMsg.filesChanged || [],
									bashResults: resultMsg.bashResults || [],
								});
							}
						}
					});
					sendJson(flashConn.socket, {
						type: "task",
						id: flashTaskId,
						task: msg.task,
						step: msg.step,
						plan: msg.plan,
						context: msg.context,
					});
					return;
				}
				// ── Abort pending subdelegate (from strong worker) ─────────
				if (msg.type === "abort" && msg.id && subdelegateReverseMap.has(msg.id)) {
					// First check if it's still in the queue (not yet dispatched)
					if (removeQueuedSubdelegate(msg.id)) {
						// Was queued, no flash worker to abort
						writeControlFileIdle(cwd);
						return;
					}
					// Already dispatched, abort the flash worker
					const flashTaskId = subdelegateReverseMap.get(msg.id)!;
					const tracker = subdelegateTrackers.get(flashTaskId);
					const flashWorkerId = taskWorkerMap.get(flashTaskId);
					subdelegateTrackers.delete(flashTaskId);
					subdelegateReverseMap.delete(msg.id);
					pendingResolvers.delete(flashTaskId);
					pendingUpdates.delete(flashTaskId);
					taskWorkerMap.delete(flashTaskId);
					// Abort the flash worker
					if (flashWorkerId && workerPool.has(flashWorkerId)) {
						const conn = workerPool.get(flashWorkerId)!;
						conn.busy = false;
						conn.taskId = null;
						if (!conn.socket.destroyed) {
							sendJson(conn.socket, { type: "abort", id: flashTaskId });
						}
						dispatchNextQueued(flashWorkerId, conn, ctx);
					}
					writeControlFileIdle(cwd);
					// Notify strong worker that subdelegate was aborted
					if (tracker && !tracker.requesterSocket.destroyed) {
						sendJson(tracker.requesterSocket, {
							type: "subdelegate-response",
							id: tracker.subdelegateId,
							error: "Subdelegate aborted by requester",
							code: "ABORTED",
						});
					}
					return;
				}
				// ── Result / Error messages ─────────────────────────
				if ((msg.type === "result" || msg.type === "error") && msg.id) {
					const resolve = pendingResolvers.get(msg.id);
					if (resolve) {
						pendingResolvers.delete(msg.id);
						pendingUpdates.delete(msg.id);
						taskWorkerMap.delete(msg.id);
						// Burst: log task-done before resolving
						if (assignedWorkerId && isBurstWorker(assignedWorkerId)) {
							logBurstEvent(cwd, assignedWorkerId, "task-done", `${msg.id} ${msg.type}`);
						}
						// Mark this worker idle, then conditionally dispatch next queued task
						if (assignedWorkerId && workerPool.has(assignedWorkerId)) {
							const conn = workerPool.get(assignedWorkerId)!;
							conn.busy = false;
							conn.taskId = null;
							if (isBurstWorker(assignedWorkerId)) {
								const state = burstWorkers.get(assignedWorkerId);
								if (state && state.taskCount >= loadConfig().config.burstFlash.maxTasksPerWorker) {
									retireBurstFlash(assignedWorkerId, "max-tasks");
									// Spawn replacement burst if more flash-eligible work queued
									if (pendingQueue.some(e => !e.tier || e.tier === "flash" || e.tier === "default")) {
										trySpawnBurstFlash(cwd, ctx);
									}
								} else {
									dispatchNextQueued(assignedWorkerId, conn, ctx);
								}
							} else {
								dispatchNextQueued(assignedWorkerId, conn, ctx);
							}
						}
						writeControlFileIdle(cwd);
						resolve(msg);
					}
					return;
				}

				if (msg.type === "status" && msg.id) {
					const onUpdate = pendingUpdates.get(msg.id);
					if (onUpdate) {
						const label = assignedWorkerId ? `Worker ${assignedWorkerId}` : "Worker";
						onUpdate({
							content: [{ type: "text", text: `[${label}] ${msg.phase || "status"}${msg.detail ? `: ${msg.detail}` : ""}` }],
							details: {},
						});
					}
					// Burst: log compact status with phase/detail
					if (assignedWorkerId && isBurstWorker(assignedWorkerId)) {
						const detail = msg.detail ? ` ${msg.detail}` : "";
						logBurstEvent(cwd, assignedWorkerId, "status", `${msg.phase || "?"}${detail}`);
					}
				}
			}),
		);

		socket.on("close", () => {
			if (assignedWorkerId && workerPool.has(assignedWorkerId)) {
				const tier = workerPool.get(assignedWorkerId)!.tier;
				// Remove any queued subdelegates initiated by this worker (if strong)
				removeQueuedSubdelegatesByRequester(assignedWorkerId);
				// Clean up any subdelegates initiated by this worker (if strong)
				for (const [flashTaskId, tracker] of subdelegateTrackers) {
					if (tracker.requesterWorkerId === assignedWorkerId) {
						subdelegateTrackers.delete(flashTaskId);
						subdelegateReverseMap.delete(tracker.subdelegateId);
						pendingResolvers.delete(flashTaskId);
						pendingUpdates.delete(flashTaskId);
						const flashWorkerId = taskWorkerMap.get(flashTaskId);
						taskWorkerMap.delete(flashTaskId);
						if (flashWorkerId && workerPool.has(flashWorkerId)) {
							const conn = workerPool.get(flashWorkerId)!;
							conn.busy = false;
							conn.taskId = null;
							if (!conn.socket.destroyed) {
								sendJson(conn.socket, { type: "abort", id: flashTaskId });
							}
							dispatchNextQueued(flashWorkerId, conn, ctx);
						}
					}
				}
				workerPool.delete(assignedWorkerId);
				ctx.ui.notify(`Worker ${assignedWorkerId} [${tier}] disconnected (${workerPool.size}/${maxWorkers})`, "warning");
				ctx.ui.setStatus(
					"mind-worker",
					workerPool.size > 0 ? `🔵 mind (${workerPool.size}/${maxWorkers})` : "🔵 mind (no workers)",
				);
				failPendingTasksForWorker(assignedWorkerId, "Worker disconnected", "DISCONNECT");
				// If no workers remain but tasks are queued, fail them
				if (workerPool.size === 0 && pendingQueue.length > 0) {
					for (const entry of pendingQueue) {
						entry.resolve({
							content: [{ type: "text", text: "All workers disconnected. Queued task failed." }],
							isError: true,
							details: { code: "NO_WORKERS" },
						});
					}
					pendingQueue.length = 0;
				}
			}
			if (LAUNCHER_ROLE_FLAG === "mind" && assignedWorkerId) {
				writeControlFileWorkerConnected(cwd);
			}
		});

		socket.on("error", () => {
			if (assignedWorkerId && workerPool.has(assignedWorkerId)) {
				workerPool.delete(assignedWorkerId);
				failPendingTasksForWorker(assignedWorkerId, "Socket error", "SOCKET_ERROR");
				ctx.ui.setStatus(
					"mind-worker",
					workerPool.size > 0 ? `🔵 mind (${workerPool.size}/${maxWorkers})` : "🔵 mind (no workers)",
				);
				// If no workers remain but tasks are queued, fail them
				if (workerPool.size === 0 && pendingQueue.length > 0) {
					for (const entry of pendingQueue) {
						entry.resolve({
							content: [{ type: "text", text: "All workers disconnected. Queued task failed." }],
							isError: true,
							details: { code: "NO_WORKERS" },
						});
					}
					pendingQueue.length = 0;
				}
			}
			if (LAUNCHER_ROLE_FLAG === "mind" && assignedWorkerId) {
				writeControlFileWorkerConnected(cwd);
			}
		});
	});

	mindServer.listen(socketPath, () => {
		ctx.ui.setStatus("mind-worker", `🔵 mind (0/${maxWorkers})`);
		if (LAUNCHER_ROLE_FLAG === "mind") {
			writeControlFileReady(cwd);
			writeManifestRunning(cwd);
		}
	});

	mindServer.on("error", (err) => {
		ctx.ui.notify(`Mind server error: ${err.message}`, "error");
	});
}

function stopMindServer(cwd: string, ctx: ExtensionContext): void {
	stopDashboardHeartbeat();
	clearBurstRetryTimers();
	// Retire all burst flash workers before stopping
	retireAllBurstFlash("mind-stopped");
	// Fail queued tasks first
	failPendingTasks("Mind stopped", "STOP");
	// Destroy all worker connections
	for (const [, conn] of workerPool) {
		try { conn.socket.destroy(); } catch { /* ignore */ }
	}
	workerPool.clear();
	taskWorkerMap.clear();
	if (mindServer) {
		try { mindServer.close(); } catch { /* ignore */ }
		mindServer = null;
	}
	try { unlinkSync(getSocketPath(cwd)); } catch { /* ignore */ }
	ctx.ui.setStatus("mind-worker", undefined);
}

async function spawnWorkerInKitty(cwd: string): Promise<void> {
	if (!process.env.KITTY_LISTEN_ON) return;
	const { resolvedWorkers } = loadConfig();
	const errors: string[] = [];
	for (let i = 0; i < resolvedWorkers.length; i++) {
		const entry = resolvedWorkers[i];
		try {
			await new Promise<void>((resolve, reject) => {
				const title = `Pi Worker ${i} [${entry.tier}]`;
				const child = spawn("kitty", ["@", "launch", "--cwd", cwd, "--title", title, "--env", `PI_MIND_WORKER_ID=worker-${i}`, "--env", `PI_MIND_WORKER_TIER=${entry.tier}`, "pi", "--model", entry.model, "/be-worker"], {
					stdio: "ignore",
					timeout: 10000,
				});
				child.on("error", reject);
				child.on("close", (code) => {
					if (code === 0) resolve();
					else reject(new Error(`kitty exited ${code} for worker ${i}`));
				});
			});
		} catch (err: any) {
			errors.push(err.message);
		}
	}
	if (errors.length > 0) {
		console.error(`[spawnWorkerInKitty] ${errors.length}/${resolvedWorkers.length} workers failed: ${errors.join("; ")}`);
	}
}

/** Safe ctx.ui wrappers — swallow stale-context errors so socket handlers don't crash workers. */
function safeUiNotify(ctx: ExtensionContext, msg: string, level?: "info" | "warning" | "error" | "success"): void {
	try { ctx.ui.notify(msg, level); } catch { /* stale ctx — ignore */ }
}
function safeUiStatus(ctx: ExtensionContext, key: string, value?: string): void {
	try { ctx.ui.setStatus(key, value); } catch { /* stale ctx — ignore */ }
}

async function connectWorker(
	cwd: string,
	ctx: ExtensionContext,
	handler: (msg: SocketMsg, socket: Socket, ctx: ExtensionContext) => Promise<void>,
): Promise<boolean> {
	const socketPath = getSocketPath(cwd);
	const isLauncherPath = LAUNCHER_ROLE_FLAG === "worker";

	// Launcher path: read generation from manifest before connecting
	let generation = 0;
	if (isLauncherPath) {
		const manifest = readManifest(cwd);
		generation = (manifest?.generation as number) ?? 0;
	}

	if (isLauncherPath) {
		// Pre-connect generation check: compare env expectation vs manifest
		const expectedGen = LAUNCHER_GENERATION;
		if (expectedGen !== null && generation !== 0 && generation !== expectedGen) {
			safeUiNotify(ctx,
				`Generation mismatch: manifest=${generation}, expected=${expectedGen}. Stale worker from prior reset.`,
				"error",
			);
			process.exit(1);
		}

		// Launcher path: single attempt, no retry loop.
		// Exit immediately on disconnect/error.
		return new Promise((resolve) => {
			const socket = createConnection(socketPath);
			let connected = false;

			socket.on("connect", () => {
				connected = true;
				workerSocket = socket;
				safeUiStatus(ctx, "mind-worker", "🟢 worker");
				safeUiNotify(ctx, "Connected to mind", "success");

				// Send generation handshake with workerId and tier
				const workerTier = LAUNCHER_WORKER_TIER || "flash";
				console.error(`[worker] Connected, sending handshake gen=${generation} workerId=${LAUNCHER_WORKER_ID} tier=${workerTier}`);
				sendJson(socket, {
					type: "handshake",
					role: "worker",
					generation,
					workerId: LAUNCHER_WORKER_ID || undefined,
					tier: workerTier,
				});

				resolve(true);
			});

			socket.on(
				"data",
				parseLines((line) => {
					let msg: SocketMsg;
					try { msg = JSON.parse(line); } catch { return; }

					// Intercept generation mismatch error from mind
					if (msg.type === "error" && msg.code === "GENERATION_MISMATCH") {
						safeUiNotify(ctx, `Mind rejected: ${msg.message}`, "error");
						process.exit(1);
						return;
					}

					handler(msg, socket, ctx).catch(() => {});
				}),
			);

			socket.on("close", () => {
				workerSocket = null;
				safeUiStatus(ctx, "mind-worker", undefined);
				if (currentRole === "worker") {
					// Launcher-path worker exits immediately on disconnect
					process.exit(0);
				}
			});

			socket.on("error", (err: any) => {
				socket.destroy();
				if (!connected) {
					// Launcher path: do NOT unlink socket — launcher owns lifecycle
					safeUiNotify(ctx, `Socket error: ${err.message}`, "error");
					// Connection failed — worker exits
					process.exit(1);
				}
			});
		});
	}

	// Legacy path: retry loop (unchanged behavior)
	const maxAttempts = 60;
	let attempt = 0;

	return new Promise((resolve) => {
		const tryConnect = () => {
			if (currentRole !== "worker") {
				resolve(false);
				return;
			}

			const socket = createConnection(socketPath);
			let connected = false;

			socket.on("connect", () => {
				connected = true;
				workerSocket = socket;
				safeUiStatus(ctx, "mind-worker", "🟢 worker");
				safeUiNotify(ctx, "Connected to mind", "success");
				resolve(true);
			});

			socket.on(
				"data",
				parseLines((line) => {
					let msg: SocketMsg;
					try { msg = JSON.parse(line); } catch { return; }
					handler(msg, socket, ctx).catch(() => {});
				}),
			);

			socket.on("close", () => {
				workerSocket = null;
				safeUiStatus(ctx, "mind-worker", undefined);
				if (currentRole === "worker") {
					safeUiNotify(ctx, "Mind disconnected. Waiting...", "warning");
					setTimeout(tryConnect, 500);
				}
			});

			socket.on("error", (err: any) => {
				socket.destroy();
				if (!connected) {
					if (attempt === 0 && existsSync(socketPath) && (err.code === "ECONNREFUSED" || err.code === "ENOENT")) {
						try { unlinkSync(socketPath); } catch { /* ignore */ }
					}
					attempt += 1;
					if (attempt >= maxAttempts) {
						safeUiNotify(ctx, "Failed to connect. Run /be-mind first.", "error");
						resolve(false);
						return;
					}
					setTimeout(tryConnect, 500);
				}
			});
		};
		tryConnect();
	});
}

function disconnectWorker(ctx: ExtensionContext): void {
	stopWorkerKeepalive();
	// Fail any pending subdelegate responses
	for (const [subdelegateId, waiter] of subdelegateWaiters) {
		clearTimeout(waiter.timeoutId);
		waiter.resolve({
			content: [{ type: "text", text: "Worker stopped, subdelegate aborted" }],
			isError: true,
			details: { code: "WORKER_STOPPED" },
		});
	}
	subdelegateWaiters.clear();
	if (workerSocket) {
		try { workerSocket.destroy(); } catch { /* ignore */ }
		workerSocket = null;
	}
	workerBusy = false;
	workerTaskId = null;
	safeUiStatus(ctx, "mind-worker", undefined);
}

function buildWorkerPrompt(task: string, step?: number, plan?: string, context?: string): string {
	const parts = ["[Mind Task]"];
	if (typeof step === "number") parts.push(`Step: ${step}`);
	if (context) parts.push(`\n[Context]\n${context}`);
	if (plan) parts.push(`\n[Plan]\n${plan}`);
	parts.push(`\n[Task]\n${task}`);
	parts.push("\nExecute task. If blocked, explain blocker clearly.");
	return parts.join("\n");
}

function createWorkerHandler(pi: ExtensionAPI) {
	return async (msg: SocketMsg, socket: Socket, ctx: ExtensionContext): Promise<void> => {
		// ── Worker-side: handle subdelegate-response from mind ──
		if (msg.type === "subdelegate-response") {
			const waiter = subdelegateWaiters.get(msg.id);
			if (!waiter) return; // timeout or already resolved
			clearTimeout(waiter.timeoutId);
			subdelegateWaiters.delete(msg.id);
			if (msg.error) {
				waiter.resolve({
					content: [{ type: "text", text: msg.error }],
					isError: true,
					details: { code: msg.code || "SUBDELEGATE_ERROR" },
				});
			} else {
				waiter.resolve({
					content: [{ type: "text", text: msg.explanation || "(no explanation)" }],
					details: {
						diff: msg.diff || "",
						filesChanged: msg.filesChanged || [],
						bashResults: msg.bashResults || [],
					},
				});
			}
			return;
		}
		if (msg.type === "abort") {
			// Abort any pending subdelegates
			for (const [subdelId, waiter] of subdelegateWaiters) {
				clearTimeout(waiter.timeoutId);
				waiter.resolve({
					content: [{ type: "text", text: "Parent task aborted, subdelegate aborted" }],
					isError: true,
					details: { code: "ABORTED" },
				});
				if (workerSocket && !workerSocket.destroyed) {
					sendJson(workerSocket, { type: "abort", id: subdelId });
				}
			}
			subdelegateWaiters.clear();
			if (workerBusy) {
				ctx.abort();
				workerBusy = false;
				const id = workerTaskId;
				workerTaskId = null;
				sendJson(socket, { type: "error", id: id || msg.id, code: "ABORTED", message: "Task aborted" });
			}
			return;
		}

		if (msg.type !== "task" || !msg.id || !msg.task) return;

		if (workerBusy) {
			sendJson(socket, { type: "error", id: msg.id, code: "BUSY", message: "Worker busy" });
			return;
		}

		workerBusy = true;
		workerTaskId = msg.id;

		try {
			if (msg.plan) {
				const planPath = getPlanPath(ctx.cwd);
				ensureDir(dirname(planPath));
				writeFileSync(planPath, msg.plan, "utf-8");
			}

			sendJson(socket, { type: "status", id: msg.id, phase: "start", detail: "received" });
			const taskPrompt = buildWorkerPrompt(msg.task, msg.step, msg.plan, msg.context);
			pi.sendUserMessage(taskPrompt);
		} catch (err: any) {
			workerBusy = false;
			workerTaskId = null;
			sendJson(socket, { type: "error", id: msg.id, code: "CRASH", message: err?.message || "Worker crash" });
		}
	};
}

async function extractWorkerResult(ctx: ExtensionContext, messages: any[]): Promise<SocketMsg> {
	let explanation = "(no explanation)";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = Array.isArray(msg.content)
			? msg.content.find((c: any) => c.type === "text")?.text
			: "";
		if (text) {
			explanation = text;
			break;
		}
	}

	const { diff, filesChanged } = await getGitDiff(ctx.cwd);

	const bashResults: Array<{ cmd: string; exitCode: number; output: string }> = [];
	for (const msg of messages) {
		if (msg.role === "toolResult" && msg.toolName === "bash") {
			const output = Array.isArray(msg.content)
				? msg.content.find((c: any) => c.type === "text")?.text || ""
				: "";
			const cmd = (msg as any).toolCall?.arguments?.command || "bash";
			bashResults.push({ cmd, exitCode: msg.isError ? 1 : 0, output });
		}
	}

	return {
		type: "result",
		id: workerTaskId || "",
		explanation,
		diff,
		filesChanged,
		bashResults,
	};
}

function isSafeGitSubcommand(command: string): boolean {
	if (!command.trim()) return false;
	if (/[;&|><`$]/.test(command)) return false;
	return /^(status|diff\b|log\b|show\b|branch\b|rev-parse\b|ls-files\b|blame\b|grep\b|name-rev\b|remote\b|tag\b)/.test(
		command.trim(),
	);
}

async function activateMindRole(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	if (currentRole === "mind") {
		ctx.ui.notify("Already in mind role", "warning");
		return;
	}
	if (currentRole === "worker") {
		ctx.ui.notify("Stop worker first with /stop-worker", "error");
		return;
	}

	const { config, created, resolvedWorkers } = loadConfig();
	if (created) {
		ctx.ui.notify(`Created config: ${getConfigPath()}`, "info");
		ctx.ui.notify("Tip: enable notifyOnMindIdle in mind-worker.json for desktop notify-send + optional ntfy phone push", "info");
	}

	// Set max workers and queue size from resolved worker list
	maxWorkers = resolvedWorkers.length;
	maxQueueSize = resolvedWorkers.length * 2;

	if (!defaultTools) defaultTools = pi.getActiveTools();
	pi.setActiveTools(MIND_ALLOWED_TOOLS);
	currentRole = "mind";
	startMindServer(ctx.cwd, ctx);
	startDashboardHeartbeat(ctx.cwd);
	await setModelFromId(pi, ctx, config.mindModel);

	try {
		const snapshot = await getProjectSnapshot(ctx.cwd);
		void pi.sendMessage({ customType: "mind-worker-context", content: snapshot, display: false }, { triggerTurn: false });
	} catch {
		/* ignore */
	}

	// Launcher path: launcher spawns worker directly, skip auto-spawn
	if (!LAUNCHER_ROLE_FLAG && config.autoSpawnWorker) {
		void spawnWorkerInKitty(ctx.cwd).catch(() => {});
	}

	// Launcher path: fresh boot, never write restore metadata
	if (!LAUNCHER_ROLE_FLAG) {
		pi.appendEntry("mind-worker-role", { role: "mind", cwd: ctx.cwd });
	}

	// Boot hint consumed — clear so before_agent_start no longer treats CLi flag as current role
	launcherBootHint = null;

	ctx.ui.notify(`Mind mode active. Waiting for workers (0/${maxWorkers})...`, "success");
}

async function activateWorkerRole(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	if (currentRole === "worker") {
		ctx.ui.notify("Already in worker role", "warning");
		return;
	}
	if (currentRole === "mind") {
		ctx.ui.notify("Stop mind first with /stop-mind", "error");
		return;
	}

	const { config, resolvedWorkers } = loadConfig();
	if (!defaultTools) defaultTools = pi.getActiveTools();
	if (defaultTools) pi.setActiveTools(defaultTools);

	currentRole = "worker";
	// Pick model by worker index (worker-N) from resolved list, fallback to tier match, then config.workerModel
	let workerModel = config.workerModel;
	const workerIdxMatch = LAUNCHER_WORKER_ID?.match(/^worker-(\d+)$/);
	if (workerIdxMatch) {
		const idx = parseInt(workerIdxMatch[1], 10);
		if (idx >= 0 && idx < resolvedWorkers.length) {
			workerModel = resolvedWorkers[idx].model;
		}
	} else {
		const tier = LAUNCHER_WORKER_TIER;
		if (tier) {
			const tierEntry = resolvedWorkers.find(w => w.tier === tier);
			if (tierEntry) workerModel = tierEntry.model;
		}
	}
	await setModelFromId(pi, ctx, workerModel);
	pi.setThinkingLevel(WORKER_THINKING_LEVEL);
	// Launcher-path workers in headless mode need a keepalive to prevent event-loop exit
	if (LAUNCHER_ROLE_FLAG === "worker") startWorkerKeepalive();

	// Launcher-path worker: hide prompt/editor since worker communicates via mind socket
	if (LAUNCHER_ROLE_FLAG === "worker") {
		ctx.ui.setEditorComponent((_tui, theme, keybindings) =>
			new (class extends CustomEditor {
				render(width: number) { return []; }
				handleInput(data: string) {
					if (data.length === 1 && data >= " ") return;
					super.handleInput(data);
				}
			})(_tui, theme, keybindings)
		);
	}

	const connected = await connectWorker(ctx.cwd, ctx, createWorkerHandler(pi));
	if (!connected) {
		stopWorkerKeepalive();
		currentRole = "none";
		return;
	}

	// Launcher path: fresh boot, never write restore metadata
	if (!LAUNCHER_ROLE_FLAG) {
		pi.appendEntry("mind-worker-role", { role: "worker", cwd: ctx.cwd });
	}

	// Boot hint consumed — clear so before_agent_start no longer treats CLi flag as current role
	launcherBootHint = null;

	// Startup notification suppressed: "Worker mode active"
}

export default function mindWorkerExtension(pi: ExtensionAPI) {
	pi.registerCommand("be-mind", {
		description: "Activate mind role",
		handler: async (_args, ctx) => {
			await activateMindRole(ctx, pi);
		},
	});

	pi.registerCommand("be-worker", {
		description: "Activate worker role",
		handler: async (_args, ctx) => {
			await activateWorkerRole(ctx, pi);
		},
	});

	pi.registerCommand("stop-mind", {
		description: "Deactivate mind role",
		handler: async (_args, ctx) => {
			if (currentRole !== "mind") {
				ctx.ui.notify("Not in mind role", "warning");
				return;
			}
			stopMindServer(ctx.cwd, ctx);
			if (defaultTools) pi.setActiveTools(defaultTools);
			currentRole = "none";
			pi.appendEntry("mind-worker-role", { role: "none", cwd: ctx.cwd });
			ctx.ui.notify("Mind mode stopped", "info");
		},
	});

	pi.registerCommand("stop-worker", {
		description: "Deactivate worker role",
		handler: async (_args, ctx) => {
			if (currentRole !== "worker") {
				ctx.ui.notify("Not in worker role", "warning");
				return;
			}
			disconnectWorker(ctx);
			ctx.ui.setEditorComponent(undefined);
			if (defaultTools) pi.setActiveTools(defaultTools);
			currentRole = "none";
			pi.appendEntry("mind-worker-role", { role: "none", cwd: ctx.cwd });
			ctx.ui.notify("Worker mode stopped", "info");
		},
	});

	pi.registerCommand("mind-reset", {
		description: "Hard reset mind-worker pair (stop → cleanup → spawn)",
		handler: async (args, ctx) => {
			if (currentRole !== "mind") {
				ctx.ui.notify("Reset only available in mind role", "warning");
				return;
			}
			if (!LAUNCHER_ROLE_FLAG) {
				ctx.ui.notify("Reset requires launcher path (--mind-worker-role)", "warning");
				return;
			}

			// Check busy status from control file — any worker busy counts
			const controlPath = getControlFilePath(ctx.cwd);
			try {
				const ctrl = JSON.parse(readFileSync(controlPath, "utf-8"));
				const force =
				typeof args === "string"
					? args.includes("force") || args.includes("--force")
					: Array.isArray(args)
						? args.includes("force") || args.includes("--force")
						: typeof args === "object" && args !== null
							? args.force === true || args["--force"] === true
							: false;
				if (ctrl.status === "busy" && !force) {
					ctx.ui.notify("Mind is busy. Use /mind-reset force to reset anyway.", "error");
					return;
				}
			} catch { /* control file may not exist yet — proceed */ }

			// Detached spawn of launcher with --reset
			const launcherPath = join(getAgentDir(), "bin", "mind-worker-launcher");
			const child = spawn(launcherPath, ["--reset", "--cwd", ctx.cwd], {
				stdio: "ignore",
				detached: true,
				env: { ...process.env },
			});
			child.unref();

			ctx.ui.notify("Reset initiated — mind and worker will restart.", "info");
		},
	});

// ── Auto Fanout Router Helpers ──────────────────────────────────────────

interface FanoutLane {
	label: string;
	tier?: "flash" | "strong";
	prompt: string;
}

const INTENT_KEYWORDS: Record<string, string[]> = {
	review: ["review", "audit", "inspect", "examine", "assess", "evaluate", "look over", "sanity check"],
	explore: ["explore", "search", "locate", "discover", "map out", "inventory", "understand", "survey"],
	test: ["test", "spec", "verify", "validate", "run test", "coverage", "jest", "mocha", "pytest"],
	debug: ["debug", "investigate", "diagnose", "trace", "root cause", "broken", "failing", "error in"],
	implement: ["implement", "build", "create", "add feature", "refactor", "migrate"],
};

function inferIntent(task: string): string {
	const lower = task.toLowerCase();
	for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
		for (const kw of keywords) {
			if (lower.includes(kw)) return intent;
		}
	}
	return "explore";
}

function generateLanes(intent: string, task: string): FanoutLane[] {
	switch (intent) {
		case "review":
			return [
				{ label: "deep-review", tier: "strong", prompt: `[Deep Review Lane]\nTask: ${task}\n\nSCOPE: Correctness, design, security, edge cases. Use direct tools (read, git, ripgrep) for investigation. Do NOT run or delegate tests, type-check, lint, build, or verification commands.\nDO NOT: Duplicate work from test-evidence or config-risks lanes — those run in parallel.\nReturn structured output:\n- **Findings**: list with severity (critical/high/medium/low), confidence (high/medium/low), evidence (file:line).\n- **Risks/Unknowns**: what could go wrong, what's unclear.\n- **Verification Needed**: exact tests/checks/builds that should be run to validate findings (report to mind; do not delegate or run).` },
				{ label: "test-evidence", tier: "flash", prompt: `[Test & Evidence Lane]\nTask: ${task}\n\nSCOPE: Run tests, check test coverage gaps, verify assertions. Read-only analysis.\nDO NOT: Review design/security, analyze config — other lanes handle those.\nReturn structured output:\n- **Tests/Commands Run**: list with exit codes and key output.\n- **Coverage Risks**: untested paths, missing assertions.` },
				{ label: "config-risks", tier: "flash", prompt: `[Config & Risky Patterns Lane]\nTask: ${task}\n\nSCOPE: Configuration issues, risky patterns (hardcoded secrets, missing validation, unsafe ops). Read-only analysis.\nDO NOT: Review design/security, run tests — other lanes handle those.\nReturn structured output:\n- **Findings**: list with severity, confidence, evidence (file:line).\n- **Risks/Unknowns**: insecure defaults, missing env vars.` },
			];
		case "test":
			return [
				{ label: "test-discovery", tier: "flash", prompt: `[Test Discovery Lane]\nTask: ${task}\n\nSCOPE: Find all test files, test scripts, build/package scripts.\nDO NOT: Run tests, check coverage — other lanes handle those.\nReturn:\n- **Inventory**: list of test files and how to run them.\n- **Build/Package Scripts**: relevant commands from package.json or similar.` },
				{ label: "run-tests", tier: "flash", prompt: `[Run Tests Lane]\nTask: ${task}\n\nSCOPE: Run targeted tests, identify failing tests, capture output.\nDO NOT: Discover test files, check coverage config — other lanes handle those.\nReturn:\n- **Commands Run**: exact commands with exit codes.\n- **Failures**: list of failing tests with error messages.` },
				{ label: "coverage-config", tier: "flash", prompt: `[Coverage & Config Lane]\nTask: ${task}\n\nSCOPE: Check test coverage config, missing test configs, flaky test patterns.\nDO NOT: Run tests, discover test files — other lanes handle those.\nReturn:\n- **Risks/Unknowns**: coverage gaps, config issues, potential flakiness.` },
			];
		case "explore":
			return [
				{ label: "architecture", tier: "flash", prompt: `[Architecture Map Lane]\nTask: ${task}\n\nSCOPE: Map module boundaries, dependencies, entry points.\nDO NOT: Search for specific patterns, find docs/config — other lanes handle those.\nReturn: concise architecture summary with file evidence (file paths).` },
				{ label: "search-evidence", tier: "flash", prompt: `[Search & Evidence Lane]\nTask: ${task}\n\nSCOPE: Search for key patterns, usages, implementations.\nDO NOT: Map architecture, find docs/config — other lanes handle those.\nReturn: findings with file paths and line numbers.` },
				{ label: "docs-config", tier: "flash", prompt: `[Docs & Config Lane]\nTask: ${task}\n\nSCOPE: Find relevant documentation, config files, READMEs.\nDO NOT: Map architecture, search for patterns — other lanes handle those.\nReturn: summary of docs/config found with file paths.` },
			];
		case "debug":
		case "implement":
			return [
				{ label: "deep-analysis", tier: "strong", prompt: `[Deep Analysis Lane — Primary]\nTask: ${task}\n\nSCOPE: Perform the core work. Use direct tools (bash, edit, write) for implementation and analysis. Do NOT run or delegate tests, type-check, lint, build, or verification commands.\nDO NOT: Decompose into many tiny pieces — batch related work. If flash is busy/queue full, list what verification is needed instead of doing it yourself.\nReturn:\n- **Results**: evidence, diff, observations from your own work and any flash delegates.\n- **Files Touched**: list of files created/modified.\n- **Verification Needed**: exact tests/checks/builds that should be run (report to mind; do not delegate or run).` },
				{ label: "evidence-gather", tier: "flash", prompt: `[Evidence Gathering Lane]\nTask: ${task}\n\nSCOPE: Grep for relevant code, read key files, gather context.\nDO NOT: Deep analysis, run tests — other lanes handle those.\nReturn: concise findings with file paths and line numbers.` },
				{ label: "test-validate", tier: "flash", prompt: `[Test & Validate Lane]\nTask: ${task}\n\nSCOPE: Run relevant tests, check current behavior.\nDO NOT: Deep analysis, gather evidence — other lanes handle those.\nReturn:\n- **Commands Run**: exact commands with exit codes.\n- **Observations**: current behavior, regressions.` },
			];
		default:
			return [
				{ label: "primary", prompt: `[Primary Lane]\nTask: ${task}\n\nSCOPE: Primary investigation angle.\nDO NOT: Duplicate work from secondary lane.\nReturn structured findings with evidence.` },
				{ label: "secondary", prompt: `[Secondary Lane]\nTask: ${task}\n\nSCOPE: Secondary investigation angle (different from primary).\nDO NOT: Duplicate work from primary lane.\nReturn structured findings with evidence.` },
			];
	}
}

function assignLanesToWorkers(
	lanes: FanoutLane[],
	idleWorkers: Array<{ workerId: string; connection: WorkerConnection }>
): Array<{ lane: FanoutLane; worker: { workerId: string; connection: WorkerConnection } }> {
	const assignments: Array<{ lane: FanoutLane; worker: { workerId: string; connection: WorkerConnection } }> = [];
	const usedWorkers = new Set<string>();

	// First pass: assign tier-specific lanes to matching workers
	for (const lane of lanes) {
		if (!lane.tier) continue;
		const match = idleWorkers.find(w => !usedWorkers.has(w.workerId) && w.connection.tier === lane.tier);
		if (match) {
			assignments.push({ lane, worker: match });
			usedWorkers.add(match.workerId);
		}
	}

	// Second pass: assign remaining lanes to any idle workers (untiered lanes or tier mismatch fallback)
	for (const lane of lanes) {
		if (assignments.some(a => a.lane === lane)) continue;
		const match = idleWorkers.find(w => !usedWorkers.has(w.workerId));
		if (match) {
			assignments.push({ lane, worker: match });
			usedWorkers.add(match.workerId);
		}
	}

	// Note: extra idle workers beyond lane count remain idle — no duplicate lane saturation.
	return assignments;
}

async function executeFanout(
	task: string,
	intent: string,
	tier: string | undefined,
	plan: string | undefined,
	context: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
	ctx: ExtensionContext
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; details?: any }> {
	const effectiveTier = (tier === "auto" || !tier) ? undefined : tier;
	const idleWorkers = findAllIdleWorkers(effectiveTier);

	if (idleWorkers.length === 0) {
		const connected = [...workerPool.values()].filter(w => !w.socket.destroyed).length;
		const busy = countBusyWorkers();
		return {
			content: [{ type: "text", text: `No idle workers available for auto-fanout. ${connected} connected, ${busy} busy.` }],
			isError: true,
			details: { code: "NO_IDLE_WORKERS" },
		};
	}

	const lanes = generateLanes(intent, task);
	const assignments = assignLanesToWorkers(lanes, idleWorkers);

	if (assignments.length === 0) {
		return {
			content: [{ type: "text", text: `Failed to assign lanes to workers. ${idleWorkers.length} idle but no valid assignments.` }],
			isError: true,
			details: { code: "LANE_ASSIGNMENT_FAILED" },
		};
	}

	// Write plan file if provided
	if (plan) {
		const planPath = getPlanPath(ctx.cwd);
		ensureDir(dirname(planPath));
		writeFileSync(planPath, plan, "utf-8");
	}

	const { config } = loadConfig();
	writeControlFileBusy(ctx.cwd);

	const results = await Promise.all(
		assignments.map(({ lane, worker }) => {
			const taskId = `fanout-${Date.now()}-${lane.label}-${Math.random().toString(36).slice(2, 6)}`;

			// Mark worker busy
			worker.connection.busy = true;
			worker.connection.taskId = taskId;
			taskWorkerMap.set(taskId, worker.workerId);
			trackTaskStart(taskId, worker.workerId, worker.connection.tier, lane.prompt.slice(0, 100), ctx.cwd);

			if (onUpdate) {
				pendingUpdates.set(taskId, onUpdate);
			}

			return new Promise<{ lane: string; workerId: string; tier: string; content: string; isError: boolean }>((resolve) => {
				let settled = false;
				let abortListener: (() => void) | null = null;
				let timeoutId: ReturnType<typeof setTimeout>;

				const resolveOnce = (result: { lane: string; workerId: string; tier: string; content: string; isError: boolean }) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeoutId);
					if (abortListener && signal) {
						signal.removeEventListener("abort", abortListener);
					}
					resolve(result);
				};

				timeoutId = setTimeout(() => {
					// Timeout: clean maps, send abort, mark worker idle, dispatch next, write control file
					pendingResolvers.delete(taskId);
					pendingUpdates.delete(taskId);
					taskWorkerMap.delete(taskId);
					if (!worker.connection.socket.destroyed) {
						sendJson(worker.connection.socket, { type: "abort", id: taskId });
					}
					worker.connection.busy = false;
					worker.connection.taskId = null;
					dispatchNextQueued(worker.workerId, worker.connection, ctx);
					writeControlFileIdle(ctx.cwd);
					logDelegateResult(taskId, "timeout", `Timeout after ${config.timeout}s`);
					resolveOnce({
						lane: lane.label,
						workerId: worker.workerId,
						tier: worker.connection.tier,
						content: `Timeout after ${config.timeout}s`,
						isError: true,
					});
				}, Math.max(1, config.timeout) * 1000);

				pendingResolvers.set(taskId, (msg) => {
					// Normal completion: socket handler already marked worker idle + dispatched next queued
					// Must NOT mark worker idle or dispatch queued here
					const status = msg.type === "error" ? "error" : "completed";
					const summary = msg.explanation || msg.message || "(no result)";
					const details = {
						filesChanged: msg.filesChanged,
						diffLength: msg.diff?.length,
						bashExitCodes: msg.bashResults?.map(r => r.exitCode),
						bashCount: msg.bashResults?.length,
					};
					logDelegateResult(taskId, status, summary, details);
					resolveOnce({
						lane: lane.label,
						workerId: worker.workerId,
						tier: worker.connection.tier,
						content: msg.explanation || msg.message || "(no result)",
						isError: msg.type === "error",
					});
				});

				sendJson(worker.connection.socket, {
					type: "task",
					id: taskId,
					task: lane.prompt,
					step: step,
					plan: plan || undefined,
					context: context || undefined,
				});

				// Declare abortListener in outer promise scope so resolver can remove it
				abortListener = () => {
					// Abort: clean maps, send abort, mark worker idle, dispatch next, write control file
					pendingResolvers.delete(taskId);
					pendingUpdates.delete(taskId);
					taskWorkerMap.delete(taskId);
					worker.connection.busy = false;
					worker.connection.taskId = null;
					if (!worker.connection.socket.destroyed) {
						sendJson(worker.connection.socket, { type: "abort", id: taskId });
					}
					dispatchNextQueued(worker.workerId, worker.connection, ctx);
					writeControlFileIdle(ctx.cwd);
					logDelegateResult(taskId, "aborted", "Task aborted");
					resolveOnce({
						lane: lane.label,
						workerId: worker.workerId,
						tier: worker.connection.tier,
						content: "Task aborted",
						isError: true,
					});
				};

				if (signal) {
					if (signal.aborted) abortListener();
					else signal.addEventListener("abort", abortListener, { once: true });
				}
			});
		})
	);

	writeControlFileIdle(ctx.cwd);

	// Aggregate results
	const errorCount = results.filter(r => r.isError).length;
	const laneSummary = assignments.map(a => a.lane.label).join(", ");
	const mergeGuide = intent === "review"
		? "Cross-reference findings across lanes. Deduplicate overlapping issues. Prioritize by severity (critical > high > medium > low)."
		: intent === "test"
			? "Combine test results. Identify failing tests. Check coverage gaps across all lanes."
			: intent === "explore"
				? "Merge architecture map with search findings and docs. Build complete picture."
				: "Combine analysis from all lanes. Cross-reference findings.";

	const body = results
		.map(r => `## Lane: ${r.lane} (Worker: ${r.workerId}, tier: ${r.tier})\n${r.content}`)
		.join("\n\n---\n\n");

	return {
		content: [{
			type: "text",
			text: `# Auto-Fanout Results\n\n**Intent:** ${intent}\n**Lanes:** ${assignments.length} (${laneSummary})\n**Workers:** ${assignments.length} assigned, ${errorCount} errors\n\n## Merge Guide\n${mergeGuide}\n\n---\n\n${body}`,
		}],
	};
}

// ── End Auto Fanout Router Helpers ──────────────────────────────────────

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "Delegate task to worker pool. Use strategy:'auto' or 'fanout' to auto-decompose across idle workers with intent-specific lanes. intent: 'review'|'explore'|'test'|'debug'|'implement' selects lane type when strategy is fanout/auto (inferred from task keywords if omitted). Use strategy:'single' or omit strategy/intent to delegate one task to one worker. If all workers busy, task queues up to max queue size. Specify workerId to target a specific worker, or tier for a worker type.",
		promptSnippet: "Fan-out tasks to worker pool. strategy:'auto' or 'fanout' auto-decomposes across idle workers. intent selects lane type.",
		parameters: Type.Object({
			task: Type.String({ description: "Task for worker" }),
			step: Type.Optional(Type.Number({ description: "Step number" })),
			plan: Type.Optional(Type.String({ description: "Full plan markdown" })),
			context: Type.Optional(Type.String({ description: "Running summary" })),
			reset: Type.Optional(Type.Boolean({ description: "Reserved" })),
			workerId: Type.Optional(Type.String({ description: "Target specific worker by ID. Omit for auto-routing to first idle worker." })),
			tier: Type.Optional(Type.String({ description: "Worker tier: 'flash' for simple/scoped tasks, 'strong' for complex/deep reasoning. Omit or 'auto' for any idle worker." })),
			strategy: Type.Optional(Type.String({ description: "Routing strategy: 'single' (default, one task to one worker), 'auto' or 'fanout' (auto-decompose and fan out to all idle workers). Intent alone does NOT trigger fanout." })),
			intent: Type.Optional(Type.String({ description: "Task intent: 'review', 'explore', 'test', 'debug', 'implement'. Only selects lane type when strategy is 'auto' or 'fanout'. Does NOT trigger fanout by itself. Inferred from task keywords when fanout is active." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// ── Auto Fanout Router ──
			const rawStrategy = params.strategy;
			const rawIntent = params.intent;
			const strategy = typeof rawStrategy === "string" ? rawStrategy.toLowerCase().trim() : undefined;
			const intentParam = typeof rawIntent === "string" ? rawIntent.toLowerCase().trim() : undefined;
			const ALLOWED_INTENTS = new Set(["review", "explore", "test", "debug", "implement"]);

			// Validate strategy in all roles
			if (strategy !== undefined && strategy !== "single" && strategy !== "auto" && strategy !== "fanout") {
				return { content: [{ type: "text", text: `Invalid strategy "${params.strategy}". Allowed: "single", "auto", "fanout", or omit.` }], isError: true };
			}

			const shouldFanout = strategy === "auto" || strategy === "fanout";

			if (shouldFanout && currentRole === "mind") {
				if (!params.task?.trim()) {
					return { content: [{ type: "text", text: "task is required" }], isError: true };
				}
				// Validate intent for fanout
				if (intentParam !== undefined && !ALLOWED_INTENTS.has(intentParam)) {
					return { content: [{ type: "text", text: `Invalid intent "${params.intent}". Allowed: "review", "explore", "test", "debug", "implement", or omit.` }], isError: true };
				}
				// Validate tier for fanout
				const tier = params.tier?.trim();
				if (tier && tier !== "flash" && tier !== "strong" && tier !== "auto") {
					return { content: [{ type: "text", text: `Invalid tier "${params.tier}" for fanout. Allowed: "flash", "strong", "auto", or omit.` }], isError: true };
				}
				const intent = intentParam && ALLOWED_INTENTS.has(intentParam) ? intentParam : inferIntent(params.task);
				return executeFanout(params.task, intent, params.tier, params.plan, params.context, params.step, signal, onUpdate, ctx);
			}

			// ── Fanout guard for worker role ──
			if (currentRole === "worker" && (strategy === "auto" || strategy === "fanout")) {
				return { content: [{ type: "text", text: "Auto-fanout only available in mind mode. Strong workers can single-delegate to flash workers by omitting strategy and intent." }], isError: true, details: { code: "FANOUT_IN_WORKER" } };
			}

			// ── Worker-side subdelegation (strong worker → mind → flash worker) ──
			if (currentRole === "worker") {
				// Only strong-tier workers may subdelegate
				if (LAUNCHER_WORKER_TIER !== "strong") {
					return { content: [{ type: "text", text: "delegate blocked: only strong-tier workers may delegate. Flash workers cannot delegate." }], isError: true };
				}
				if (!workerSocket || workerSocket.destroyed) {
					return { content: [{ type: "text", text: "delegate blocked: worker not connected to mind. Cannot subdelegate." }], isError: true };
				}
				// Enforce flash-only targeting
				const targetTier = params.tier?.trim();
				if (targetTier && targetTier !== "flash" && targetTier !== "auto") {
					return { content: [{ type: "text", text: `delegate blocked: strong workers can only delegate to flash tier. Got: "${targetTier}". Omit tier or use "flash" or "auto".` }], isError: true };
				}
				if (!params.task?.trim()) {
					return { content: [{ type: "text", text: "task is required" }], isError: true };
				}
				const subdelegateId = `subdel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				const { config } = loadConfig();
				return new Promise((resolve) => {
					const timeoutId = setTimeout(() => {
						subdelegateWaiters.delete(subdelegateId);
						resolve({
							content: [{ type: "text", text: `Subdelegate timeout after ${config.timeout}s` }],
							isError: true,
							details: { code: "TIMEOUT" },
						});
					}, Math.max(1, config.timeout) * 1000);
					subdelegateWaiters.set(subdelegateId, { resolve, timeoutId });
					sendJson(workerSocket!, {
						type: "subdelegate-request",
						id: subdelegateId,
						task: params.task,
						step: params.step,
						plan: params.plan,
						context: params.context,
						tier: "flash",
						requesterWorkerId: LAUNCHER_WORKER_ID || undefined,
						requesterTaskId: workerTaskId || undefined,
					});
					if (signal) {
						const onAbort = () => {
							const waiter = subdelegateWaiters.get(subdelegateId);
							if (waiter) {
								clearTimeout(waiter.timeoutId);
								subdelegateWaiters.delete(subdelegateId);
							}
							if (workerSocket && !workerSocket.destroyed) {
								sendJson(workerSocket, { type: "abort", id: subdelegateId });
							}
							resolve({ content: [{ type: "text", text: "Subdelegate aborted" }], isError: true });
						};
						if (signal.aborted) onAbort();
						else signal.addEventListener("abort", onAbort, { once: true });
					}
				});
			}
			if (currentRole !== "mind") {
				return { content: [{ type: "text", text: "delegate only in mind mode. Run /be-mind first." }], isError: true };
			}
			if (!params.task?.trim()) {
				return { content: [{ type: "text", text: "task is required" }], isError: true };
			}

			// ── Determine target tier ────────────────────────────────
			const targetTier = params.tier?.trim();
			if (targetTier && targetTier !== "flash" && targetTier !== "strong" && targetTier !== "auto") {
				return {
					content: [{ type: "text", text: `Invalid tier "${targetTier}". Use "flash", "strong", "auto", or omit.` }],
					isError: true,
				};
			}
			const effectiveTier = (targetTier === "auto" || !targetTier) ? undefined : targetTier;

			// ── Find target worker ──────────────────────────────────
			let targetWorkerId = params.workerId?.trim() || null;
			let connection: WorkerConnection | undefined;

			if (targetWorkerId) {
				// Explicit workerId targeting
				const conn = workerPool.get(targetWorkerId);
				if (!conn || conn.socket.destroyed) {
					return {
						content: [{ type: "text", text: `Worker "${targetWorkerId}" not connected. Connected: ${[...workerPool.keys()].filter(w => !workerPool.get(w)!.socket.destroyed).join(", ") || "(none)"}` }],
						isError: true,
					};
				}
				if (conn.busy) {
					const idleCount = [...workerPool.values()].filter(w => !w.busy && !w.socket.destroyed).length;
					return {
						content: [{ type: "text", text: `Worker "${targetWorkerId}" is busy. ${idleCount} idle worker(s) available. Omit workerId for auto-routing.` }],
						isError: true,
					};
				}
				connection = conn;
			} else {
				// Auto-select first idle worker of requested tier (or any if no tier)
				const idle = findIdleWorker(effectiveTier);
				if (!idle) {
					const connected = [...workerPool.values()].filter(w => !w.socket.destroyed).length;
					const isFlashTier = !effectiveTier || effectiveTier === "flash" || effectiveTier === "default";
					const { config: bCfg } = loadConfig();
					const canBurst = isFlashTier && bCfg.burstFlash.enabled && bCfg.burstFlash.maxBurst > 0;
					if (connected === 0) {
						if (canBurst) {
							// No workers connected but burst flash available — queue for burst spawn
						} else {
							return {
								content: [{ type: "text", text: "No workers connected. Workers start automatically." }],
								isError: true,
							};
						}
					} else {
						// If tier specified, check if any worker of that tier exists
						if (effectiveTier) {
							const tierCount = [...workerPool.values()].filter(w => w.tier === effectiveTier && !w.socket.destroyed).length;
							const tierBusy = [...workerPool.values()].filter(w => w.tier === effectiveTier && w.busy && !w.socket.destroyed).length;
							if (tierCount === 0) {
								return {
									content: [{ type: "text", text: `No ${effectiveTier} workers connected. Available tiers: ${[...new Set([...workerPool.values()].filter(w => !w.socket.destroyed).map(w => w.tier))].join(", ") || "(none)"}` }],
									isError: true,
								};
							}
							// Tier workers exist but all busy — queue for that tier
							if (tierCount > 0 && tierCount === tierBusy) {
								// Fall through to queue below
							} else {
								return {
									content: [{ type: "text", text: `All ${effectiveTier} worker(s) busy (${tierBusy}/${tierCount}). Use "auto" or omit tier to queue for any available worker.` }],
									isError: true,
								};
							}
						}
					}
					// Queue the task if within limit
					if (pendingQueue.length >= maxQueueSize) {
						const inFlight = countBusyWorkers() + pendingQueue.length;
						return {
							content: [{ type: "text", text: `All ${connected} worker(s) busy and queue full (${pendingQueue.length}/${maxQueueSize}). ${inFlight} total tasks in-flight or queued. Wait for results, then retry or reduce parallel chunk count.` }],
							isError: true,
						};
					}
					// ── Enqueue task ───────────────────────────────────
					const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					// Plan file written at dispatch time, not here
					writeControlFileBusy(ctx.cwd);
					return new Promise((resolve) => {
						pendingQueue.push({
							id,
							task: params.task,
							step: params.step,
							plan: params.plan,
							context: params.context,
							reset: params.reset,
							tier: effectiveTier,
							ctx,
							resolve,
							signal,
							onUpdate,
							cwd: ctx.cwd,
							queuedAt: Date.now(),
						});
						// Trigger burst flash spawn if conditions met (immediate + delayed retry)
						if (!effectiveTier || effectiveTier === "flash" || effectiveTier === "default") {
							trySpawnBurstFlashWithRetry(ctx.cwd, ctx);
						}
						// If signal fires while queued, remove from queue and reject
						if (signal) {
							const onAbort = () => {
								const idx = pendingQueue.findIndex(e => e.id === id);
								if (idx !== -1) {
									pendingQueue.splice(idx, 1);
									if (!hasPendingWork()) writeControlFileIdle(ctx.cwd);
									resolve({ content: [{ type: "text", text: "Task aborted while queued" }], isError: true });
								}
							};
							if (signal.aborted) onAbort();
							else signal.addEventListener("abort", onAbort, { once: true });
						}
					});
				}
				targetWorkerId = idle.workerId;
				connection = idle.connection;
			}

			// ── Send task ───────────────────────────────────────────
			const { config } = loadConfig();
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			if (onUpdate) pendingUpdates.set(id, onUpdate);

			if (params.plan) {
				const planPath = getPlanPath(ctx.cwd);
				ensureDir(dirname(planPath));
				writeFileSync(planPath, params.plan, "utf-8");
			}

			// Mark worker busy and record task-worker mapping
			connection.busy = true;
			connection.taskId = id;
			taskWorkerMap.set(id, targetWorkerId);
			trackTaskStart(id, targetWorkerId, connection.tier, params.task.slice(0, 100), ctx.cwd);
			// Track burst worker task start (direct dispatch path)
			if (isBurstWorker(targetWorkerId)) {
				onBurstWorkerTaskStart(targetWorkerId);
				logBurstEvent(ctx.cwd, targetWorkerId, "task-start", id);
			}
			writeControlFileBusy(ctx.cwd);

			return new Promise((resolve) => {
				const timeoutId = setTimeout(() => {
					pendingResolvers.delete(id);
					pendingUpdates.delete(id);
					taskWorkerMap.delete(id);
					// Mark worker idle on timeout
					if (targetWorkerId && workerPool.has(targetWorkerId)) {
						const conn = workerPool.get(targetWorkerId)!;
						conn.busy = false;
						conn.taskId = null;
					}
					// Abort the worker
					if (connection && !connection.socket.destroyed) {
						sendJson(connection.socket, { type: "abort", id });
					}
					// Dispatch next queued task now that worker is idle
					if (targetWorkerId && workerPool.has(targetWorkerId)) {
						const conn = workerPool.get(targetWorkerId)!;
						dispatchNextQueued(targetWorkerId, conn, ctx);
					}
					writeControlFileIdle(ctx.cwd);
					logDelegateResult(id, "timeout", `Worker "${targetWorkerId}" timeout after ${config.timeout}s`);
					resolve({
						content: [{ type: "text", text: `Worker "${targetWorkerId}" timeout after ${config.timeout}s` }],
						isError: true,
						details: { code: "TIMEOUT" },
					});
				}, Math.max(1, config.timeout) * 1000);

				pendingResolvers.set(id, (msg) => {
					clearTimeout(timeoutId);
					pendingResolvers.delete(id);
					pendingUpdates.delete(id);
					taskWorkerMap.delete(id);
					// Worker already marked idle in socket data handler
					writeControlFileIdle(ctx.cwd);
					const status = msg.type === "result" ? "completed" : "error";
					const summary = msg.explanation || msg.message || "(no result)";
					const details = {
						filesChanged: msg.filesChanged,
						diffLength: msg.diff?.length,
						bashExitCodes: msg.bashResults?.map(r => r.exitCode),
						bashCount: msg.bashResults?.length,
					};
					logDelegateResult(id, status, summary, details);
					if (msg.type === "result") {
						resolve({
							content: [{ type: "text", text: msg.explanation || "(no explanation)" }],
							details: {
								diff: msg.diff || "",
								filesChanged: msg.filesChanged || [],
								bashResults: msg.bashResults || [],
							},
						});
					} else {
						resolve({
							content: [{ type: "text", text: msg.message || "Worker error" }],
							isError: true,
							details: { code: msg.code || "ERROR" },
						});
					}
				});

				sendJson(connection.socket, {
					type: "task",
					id,
					task: params.task,
					step: params.step,
					plan: params.plan,
					context: params.context,
					reset: params.reset,
				});

				if (signal) {
					const onAbort = () => {
						clearTimeout(timeoutId);
						pendingResolvers.delete(id);
						pendingUpdates.delete(id);
						taskWorkerMap.delete(id);
						if (targetWorkerId && workerPool.has(targetWorkerId)) {
							const conn = workerPool.get(targetWorkerId)!;
							conn.busy = false;
							conn.taskId = null;
						}
						if (connection && !connection.socket.destroyed) {
							sendJson(connection.socket, { type: "abort", id });
						}
						// Dispatch next queued task now that worker is idle
						if (targetWorkerId && workerPool.has(targetWorkerId)) {
							const conn = workerPool.get(targetWorkerId)!;
							dispatchNextQueued(targetWorkerId, conn, ctx);
						}
						writeControlFileIdle(ctx.cwd);
						logDelegateResult(id, "aborted", "Task aborted");
						resolve({ content: [{ type: "text", text: "Task aborted" }], isError: true });
					};
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});
		},
	});

	pi.registerTool({
		name: "git",
		label: "Git",
		description: "Run safe git read-only commands for review",
		parameters: Type.Object({
			command: Type.String({ description: "Git subcommand, e.g. 'status -sb' or 'diff -- src/file.ts'" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (currentRole !== "mind" && !(currentRole === "worker" && LAUNCHER_WORKER_TIER === "strong")) {
				return { content: [{ type: "text", text: "git tool only in mind mode or strong-worker mode" }], isError: true };
			}
			const command = params.command?.trim() || "";
			if (!isSafeGitSubcommand(command)) {
				return {
					content: [{ type: "text", text: "Blocked. Allowed read-only git commands: status, diff, log, show, branch, rev-parse, ls-files, blame, grep, name-rev, remote, tag." }],
					isError: true,
				};
			}
			try {
				const { stdout, stderr } = await execAsync(`git ${command}`, { cwd: ctx.cwd });
				return { content: [{ type: "text", text: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || "(no output)" }] };
			} catch (err: any) {
				const out = `${err?.stdout || ""}${err?.stderr || ""}`.trim() || err?.message || "git failed";
				return { content: [{ type: "text", text: out }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ripgrep",
		label: "Ripgrep",
		description: "Code review grep (rg) with line numbers",
		parameters: Type.Object({
			query: Type.String({ description: "Regex or text pattern for ripgrep" }),
			path: Type.Optional(Type.String({ description: "Path to search (default .)" })),
			glob: Type.Optional(Type.String({ description: "Optional include glob, e.g. '*.ts'" })),
			contextLines: Type.Optional(Type.Number({ description: "Context lines around matches" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (currentRole !== "mind" && !(currentRole === "worker" && LAUNCHER_WORKER_TIER === "strong")) {
				return { content: [{ type: "text", text: "ripgrep tool only in mind mode or strong-worker mode" }], isError: true };
			}

			const args = ["--line-number", "--no-heading", "--color", "never"];
			if (typeof params.contextLines === "number" && params.contextLines > 0) {
				args.push("-C", String(Math.min(20, Math.floor(params.contextLines))));
			}
			if (params.glob?.trim()) args.push("-g", params.glob.trim());
			args.push(params.query);
			args.push(params.path?.trim() || ".");

			try {
				const { stdout, stderr } = await execFileAsync("rg", args, { cwd: ctx.cwd, maxBuffer: 1024 * 1024 });
				const text = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || "(no matches)";
				return { content: [{ type: "text", text: text.slice(0, 50000) }] };
			} catch (err: any) {
				const out = `${err?.stdout || ""}${err?.stderr || ""}`.trim();
				if (err?.code === 1) {
					return { content: [{ type: "text", text: "(no matches)" }] };
				}
				return { content: [{ type: "text", text: out || err?.message || "rg failed" }], isError: true };
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		// ── Strong worker: inject subdelegate capability prompt ──
		if ((currentRole === "worker" || launcherBootHint === "worker") && LAUNCHER_WORKER_TIER === "strong") {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\n[STRONG WORKER MODE — Direct Tools + Selective Flash Delegation]\n" +
					"You are a strong-tier worker. You have full access to all tools (bash, edit, write, read, ripgrep, git, delegate).\n" +
					"Key guidelines:\n" +
					"  1. Use direct tools (bash, edit, write, read, ripgrep, git) freely for analysis and implementation. Do NOT run tests, type-check, lint, build, or verification commands yourself.\n" +
					"  2. Delegate to flash ONLY for independent context/evidence gathering subtasks (grep for patterns, read files, explore directories). Do NOT delegate tests, type-check, lint, build, or any verification commands.\n" +
					"  3. Batch related work; do not decompose into many tiny pieces.\n" +
					"  4. Synthesize all results into a single cohesive response.\n" +
					"\n" +
					"Avoid delegate retry loops:\n" +
					"  • If delegate returns an error (queue full, all flash busy, timeout), do NOT immediately retry.\n" +
					"  • Instead, continue with non-verification work (analysis, implementation) and retry delegation on the next turn or when the queue has had time to drain.\n" +
					"  • If a subdelegate times out, do not re-delegate — note the gap in your report.\n" +
					"\n" +
					"Pass shared context to flash via `plan` and `context` params when delegating.\n" +
					"Flash workers cannot delegate further — you are the top of the delegation chain.\n" +
					"Never delegate to 'strong' tier; only flash workers are available for subdelegation.\n" +
					"\n" +
					"Final response must include:\n" +
					"  • **Summary**: what was done.\n" +
					"  • **Files Touched**: list of files created/modified.\n" +
					"  • **Verification Needed**: exact tests, type-check, lint, build commands that should be run (report to mind; do not delegate or run yourself).\n",
			};
		}
		if (currentRole !== "mind" && launcherBootHint !== "mind") return;
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const planPath = getPlanPath(cwd);
		const planSection = existsSync(planPath) ? `\n\n## Current Plan\n${readFileSync(planPath, "utf-8")}` : "";

		const { config, resolvedWorkers } = loadConfig();
		const flashCount = resolvedWorkers.filter(w => w.tier === "flash").length;
		const strongCount = resolvedWorkers.filter(w => w.tier === "strong").length;
		const burstMax = config.burstFlash.enabled ? config.burstFlash.maxBurst : 0;
		const burstDesc = burstMax > 0 ? ` Burst flash: up to ${burstMax} extra flash workers auto-spawn for queued flash-tier tasks when static flash workers are busy.` : "";

		let tierDesc = "";
		if (flashCount > 0 && strongCount > 0) {
			tierDesc = `${flashCount} flash + ${strongCount} strong workers.` + burstDesc;
		} else {
			tierDesc = `${resolvedWorkers.length} workers available.` + burstDesc;
		}

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n[MIND MODE ACTIVE]\n" +
				"You are planner/reviewer Mind. " + tierDesc + "\n" +
				"Allowed tools: delegate, read, git, ripgrep.\n" +
				"Default: parallel-first. Saturate all idle workers whenever tasks are independent.\n" +
				"Preflight rule: before every non-trivial task, decompose it into independent chunks and saturate all idle workers immediately.\n" +
				"Use delegate for implementation, edits, test runs, builds.\n" +
				"Use delegate(tier='flash') for ALL scoped/simple tasks — anything that does not require multi-file architecture, deep debugging, or correctness-sensitive reasoning.\n" +
				"Do not hold back flash delegates because static flash workers are busy — queued flash-tier tasks auto-spawn burst workers up to configured max.\n" +
				"Parallelize/queue independent flash work liberally; burst workers activate from queue pressure.\n" +
				"Mind: planning, final review/verdict, lightweight read/git/ripgrep checks only.\n" +
				"Never use write/edit/bash/grep/find directly in mind mode.\n" +
				"Parallel-by-default: independent tasks (separate files, separate searches, separate assertions) fan out across all idle workers in the same turn. This is the expected default — not a special pattern.\n" +
				"Sequential exception: only dependent or overlapping file edits stay sequential — one delegate call at a time on the same files, waiting for each result before the next.\n" +
				"Results from same-turn parallel delegates return after the full batch completes; merge them together.\n" +
				"If no workerId or tier is given, delegate auto-routes to first idle worker of any tier.\n" +
				`If all workers of the requested tier are busy, delegate queues the task (up to ${maxQueueSize} queued). Tasks dispatch automatically when a matching-tier worker becomes idle. If queue is full, returns error — wait for results then retry or split into fewer parallel chunks.\n` +
				"Use read/git/ripgrep only for one-off, lightweight checks.\n" +
				"Avoid reading large files directly in mind; this pollutes context window.\n" +
				"Prefer delegating file reading/search to worker whenever possible, then consume concise summaries.\n" +
				"If investigation is extensive (many files, repeated searches, or large outputs), delegate to worker and request concise summary with evidence.\n" +
				"If multiple file reads are needed, delegate worker to read files and write concise summary to temporary file, then read that file from mind.\n" +
				"If search scope is large, delegate worker to run ripgrep/searches and write concise findings to temporary file, then read that file from mind.\n" +
				(strongCount > 0
					? "Strong tier: complex/deep reasoning, multi-file architecture, and correctness-sensitive tasks. Strong may use direct tools (bash, edit, write).\n" +
					  "Flash tier: scoped/simple tasks, test runs, evidence gathering, independent implementation chunks. Prefer flash for anything that does NOT require strong's deep context.\n"
					: "") +
				planSection,
		};
	});

	pi.on("tool_call", async (event) => {
		if (currentRole === "mind") {
			if (MIND_ALLOWED_TOOLS.includes(event.toolName)) return;
			return {
				block: true,
				reason: `Mind mode blocks ${event.toolName}. Use delegate/read/git/ripgrep.`,
			};
		}

		if (currentRole === "worker" && workerBusy && workerSocket && !workerSocket.destroyed && workerTaskId) {
			const { config } = loadConfig();
			if (config.statusStream) {
				sendJson(workerSocket, {
					type: "status",
					id: workerTaskId,
					phase: "tool",
					detail: event.toolName,
				});
			}
		}
	});

	pi.on("input", async (event, ctx) => {
		// Launcher-path worker: suppress interactive keyboard input only
		if (currentRole === "worker" && LAUNCHER_ROLE_FLAG === "worker") {
			if (event.source !== "interactive") return { action: "continue" };
			ctx.ui.notify("[Worker waiting for mind task]", "info");
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (currentRole === "mind") {
			const { config } = loadConfig();
			const summary = extractLastAssistantText(event.messages);
			
			// Log mind response to JSONL for dashboard (respects dashboardEnabled + dashboardLogResponses)
			if (summary) {
				logMindResponse(ctx.cwd, summary);
			}
			
			// Restore idle control-file status after processing completes
			writeControlFileIdle(ctx.cwd);
			await sendMindIdleNotification(config, ctx, summary);
			return;
		}

		if (currentRole !== "worker" || !workerBusy || !workerSocket || workerSocket.destroyed) return;
		try {
			const result = await extractWorkerResult(ctx, event.messages);
			sendJson(workerSocket, result);
		} catch (err: any) {
			sendJson(workerSocket, {
				type: "error",
				id: workerTaskId || "",
				code: "SEND_FAILED",
				message: err?.message || "failed to send result",
			});
		}
		workerBusy = false;
		workerTaskId = null;
	});

	pi.on("session_start", async (_event, ctx) => {
		// Launcher path: skip legacy role-restore, auto-activate fresh role
		if (LAUNCHER_ROLE_FLAG === "mind") {
			await activateMindRole(ctx, pi);
			return;
		}
		if (LAUNCHER_ROLE_FLAG === "worker") {
			await activateWorkerRole(ctx, pi);
			return;
		}

		// Legacy path: restore role from session metadata (unchanged)
		const entries = ctx.sessionManager.getEntries();
		const roleEntry = entries
			.filter((e: any) => e.type === "custom" && e.customType === "mind-worker-role")
			.pop() as any;
		if (!roleEntry?.data || roleEntry.data.cwd !== ctx.cwd) return;

		if (!defaultTools) defaultTools = pi.getActiveTools();

		if (roleEntry.data.role === "mind" && currentRole !== "mind") {
			currentRole = "mind";
			pi.setActiveTools(MIND_ALLOWED_TOOLS);
			const { resolvedWorkers } = loadConfig();
			maxWorkers = resolvedWorkers.length;
			maxQueueSize = resolvedWorkers.length * 2;
			startMindServer(ctx.cwd, ctx);
			ctx.ui.notify(`Mind role restored (max ${maxWorkers} workers)`, "info");
			return;
		}

		if (roleEntry.data.role === "worker" && currentRole !== "worker") {
			currentRole = "worker";
			if (defaultTools) pi.setActiveTools(defaultTools);
			pi.setThinkingLevel(WORKER_THINKING_LEVEL);
			void connectWorker(ctx.cwd, ctx, createWorkerHandler(pi));
			ctx.ui.notify("Worker role restored", "info");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setEditorComponent(undefined);
		if (currentRole === "mind") stopMindServer(ctx.cwd, ctx);
		if (currentRole === "worker") disconnectWorker(ctx);
		failPendingTasks("Session ended", "SESSION_END");
		currentRole = "none";
		workerBusy = false;
		workerTaskId = null;
	});
}
