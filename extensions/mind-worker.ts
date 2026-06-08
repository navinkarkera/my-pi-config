import { exec, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
}
const pendingQueue: QueuedTask[] = [];
let maxQueueSize = 6; // 2x default maxWorkers; updated on config load

let lastNotificationFingerprint = "";
let lastNotificationTime = 0;
const NOTIFICATION_COOLDOWN_MS = 10_000;

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
		};
		const resolved = resolveWorkerModels(config);
		return { config, created: false, resolvedWorkers: resolved };
	} catch {
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
			return { workerId: wid, connection: conn };
		}
	}
	return null;
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
	if (pendingQueue.length === 0) return false;
	if (connection.socket.destroyed) return false;

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
						const { resolvedWorkers } = loadConfig();
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
							subdelegateTrackers.delete(flashTaskId);
							subdelegateReverseMap.delete(msg.id);
							sendJson(socket, { type: "subdelegate-response", id: msg.id, error: "No flash workers connected. Workers start automatically — retry shortly.", code: "NO_FLASH_WORKERS" });
							return;
						}
						// All flash workers busy — queue the task
						if (pendingQueue.length >= maxQueueSize) {
							subdelegateTrackers.delete(flashTaskId);
							subdelegateReverseMap.delete(msg.id);
							sendJson(socket, { type: "subdelegate-response", id: msg.id, error: `All flash workers busy and queue full (${pendingQueue.length}/${maxQueueSize}). Retry later.`, code: "QUEUE_FULL" });
							return;
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
						if (workerPool.has(flashWorkerId)) {
							const conn = workerPool.get(flashWorkerId)!;
							conn.busy = false;
							conn.taskId = null;
							dispatchNextQueued(flashWorkerId, conn, ctx);
						}
						writeControlFileIdle(cwd);
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
				// ── Result / Error / Status messages ────────────────
				if ((msg.type === "result" || msg.type === "error") && msg.id) {
					const resolve = pendingResolvers.get(msg.id);
					if (resolve) {
						pendingResolvers.delete(msg.id);
						pendingUpdates.delete(msg.id);
						taskWorkerMap.delete(msg.id);
						// Mark this worker idle, then dispatch next queued task
						if (assignedWorkerId && workerPool.has(assignedWorkerId)) {
							const conn = workerPool.get(assignedWorkerId)!;
							conn.busy = false;
							conn.taskId = null;
							dispatchNextQueued(assignedWorkerId, conn, ctx);
						}
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
			if (LAUNCHER_ROLE_FLAG === "mind") {
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
			if (LAUNCHER_ROLE_FLAG === "mind") {
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
			ctx.ui.notify(
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
				ctx.ui.setStatus("mind-worker", "🟢 worker");
				ctx.ui.notify("Connected to mind", "success");

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
						ctx.ui.notify(`Mind rejected: ${msg.message}`, "error");
						process.exit(1);
						return;
					}

					handler(msg, socket, ctx).catch(() => {});
				}),
			);

			socket.on("close", () => {
				workerSocket = null;
				ctx.ui.setStatus("mind-worker", undefined);
				if (currentRole === "worker") {
					// Launcher-path worker exits immediately on disconnect
					process.exit(0);
				}
			});

			socket.on("error", (err: any) => {
				socket.destroy();
				if (!connected) {
					// Launcher path: do NOT unlink socket — launcher owns lifecycle
					ctx.ui.notify(`Socket error: ${err.message}`, "error");
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
				ctx.ui.setStatus("mind-worker", "🟢 worker");
				ctx.ui.notify("Connected to mind", "success");
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
				ctx.ui.setStatus("mind-worker", undefined);
				if (currentRole === "worker") {
					ctx.ui.notify("Mind disconnected. Waiting...", "warning");
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
						ctx.ui.notify("Failed to connect. Run /be-mind first.", "error");
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
	ctx.ui.setStatus("mind-worker", undefined);
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
	const connected = await connectWorker(ctx.cwd, ctx, createWorkerHandler(pi));
	if (!connected) {
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

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "Delegate task to worker pool. To fan out across N workers, call delegate N times in succession — each routes to next idle worker and runs in parallel. After all calls return, merge results. Omit workerId for auto-routing to first idle worker. If all workers busy, task queues up to max queue size and dispatches when worker becomes idle. Specify workerId to target a specific worker, or tier to target a specific worker type.",
		parameters: Type.Object({
			task: Type.String({ description: "Task for worker" }),
			step: Type.Optional(Type.Number({ description: "Step number" })),
			plan: Type.Optional(Type.String({ description: "Full plan markdown" })),
			context: Type.Optional(Type.String({ description: "Running summary" })),
			reset: Type.Optional(Type.Boolean({ description: "Reserved" })),
			workerId: Type.Optional(Type.String({ description: "Target specific worker by ID. Omit for auto-routing to first idle worker." })),
			tier: Type.Optional(Type.String({ description: "Worker tier: 'flash' for simple/scoped tasks, 'strong' for complex/deep reasoning. Omit or 'auto' for any idle worker." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
					if (connected === 0) {
						return {
							content: [{ type: "text", text: "No workers connected. Workers start automatically." }],
							isError: true,
						};
					}
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
						});
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
			if (currentRole !== "mind") {
				return { content: [{ type: "text", text: "git tool only in mind mode" }], isError: true };
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
			if (currentRole !== "mind") {
				return { content: [{ type: "text", text: "ripgrep tool only in mind mode" }], isError: true };
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
					"\n\n[STRONG WORKER MODE — Subdelegate to Flash Workers]\n" +
					"You are a strong-tier worker with deep reasoning capabilities (multi-file refactors, architecture, debugging).\n" +
					"You have the `delegate` tool to subdelegate scoped tasks to flash workers via delegate(tier='flash').\n" +
					"You also have all normal direct tools (bash, read, edit, write, git, ripgrep, etc.) — use them inline for trivial one-off checks (single file read, quick grep). Reserve delegate for multi-step or scoped work.\n" +
					"\n" +
					"When to subdelegate to flash workers:\n" +
					"  • Simple file reads, grep/ripgrep searches, single-file edits, test runs, builds\n" +
					"  • Any scoped, single-purpose task that does not require architectural reasoning\n" +
					"  • Independent subtasks — fan out to multiple flash workers in parallel by default, not sequential\n" +
					"  • Pass shared context via `plan` and `context` params — use these to share plan state, running summaries, or design decisions\n" +
					"\n" +
					"When NOT to subdelegate (handle yourself):\n" +
					"  • Multi-file refactors, architecture decisions, complex debugging, correctness-sensitive work\n" +
					"  • Tasks requiring deep reasoning, cross-file understanding, or where output quality is critical\n" +
					"\n" +
					"Queue & error handling:\n" +
					"  • If all flash workers are busy, the task queues and dispatches when a flash worker becomes idle\n" +
					"  • If queue is full (queue limit depends on worker count), delegate returns an error — retry later\n" +
					"  • Each subdelegate has a timeout (120s by default). If no response in time, the subdelegate fails with timeout error.\n" +
					"  • If the parent task is aborted, all pending subdelegates are aborted automatically.\n" +
					"\n" +
					"Flash workers cannot delegate further — you are the top of the delegation chain.\n" +
					"Never attempt to delegate to 'strong' tier; only flash workers are available for subdelegation.\n",
			};
		}
		if (currentRole !== "mind" && launcherBootHint !== "mind") return;
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const planPath = getPlanPath(cwd);
		const planSection = existsSync(planPath) ? `\n\n## Current Plan\n${readFileSync(planPath, "utf-8")}` : "";

		const { config, resolvedWorkers } = loadConfig();
		const flashCount = resolvedWorkers.filter(w => w.tier === "flash").length;
		const strongCount = resolvedWorkers.filter(w => w.tier === "strong").length;

		let tierDesc = "";
		if (flashCount > 0 && strongCount > 0) {
			tierDesc = `${flashCount} flash workers (fast/cheap — scoped tasks: grep, single-file edits, run tests, builds) + ${strongCount} strong worker (deep reasoning — multi-file refactors, architecture, debugging).`;
		} else {
			tierDesc = `${resolvedWorkers.length} workers available (each handles 1 task at a time).`;
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
				"Use delegate(tier='flash') for scoped, single-file tasks — faster and cheaper.\n" +
				"Use delegate(tier='strong') for multi-file refactors, architecture decisions, debugging, reviews, or any correctness-sensitive work.\n" +
				"Workers can assist with reviews, but Mind owns final review and verdict.\n" +
				"Use read/git/ripgrep for code review and evidence gathering.\n" +
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
		if (currentRole === "mind") stopMindServer(ctx.cwd, ctx);
		if (currentRole === "worker") disconnectWorker(ctx);
		failPendingTasks("Session ended", "SESSION_END");
		currentRole = "none";
		workerBusy = false;
		workerTaskId = null;
	});
}
