#!/usr/bin/env node

// dashboard-backend.mjs — Reusable dashboard backend for mind-worker instances.
//
// Exports:
//   scanInstances(agentDir, opts) → InstanceSnapshot[]
//   normalizeState(instance) → string
//   sortInstances(instances) → InstanceSnapshot[]
//
// Zero dependencies — only Node built-ins.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// --------------------------------------------------------------------------
// Config defaults (mirrors mind-worker.json schema)
// --------------------------------------------------------------------------

const DEFAULT_STALE_MS = 30_000;

// --------------------------------------------------------------------------
// Types (JSDoc for clarity)
//
// @typedef {Object} InstanceSnapshot
// @property {string} hash
// @property {string} cwd
// @property {string} label
// @property {string} shortHash
// @property {Object|null} manifest
// @property {Object|null} control
// @property {Array} results
// @property {Array} responses
// @property {number} mindPid
// @property {boolean} mindPidAlive
// @property {string|null} terminalBackend   — the manifest's own backend ("hc" v2, "tmux" v3); null on a legacy record
// @property {string|null} rootTerminalAddress — manifest v2 root terminal address; null on a legacy record and on v3
// @property {number} heartbeat
// @property {boolean} heartbeatFresh
// @property {boolean} socketExists
// @property {boolean} socketConnectable
// @property {number} workersConnected
// @property {number} workersExpected
// @property {string} state  ("idle"|"busy"|"degraded"|"error"|"unknown")
// @property {boolean} running
// @property {Array} activeTasks
// @property {Array} queuedTasks
// @property {Array} workers   — control.workers[], whitelisted. A static worker is
//   { workerId, tier, busy, taskId, connectedAt, address, sessionDir }; address and
//   sessionDir are null unless the launcher record carries them (v2/hc address, or a
//   v3/tmux worker pane's %pane and recorded session dir). A burst
//   keeps burst: true and is listed under burstWorkers.
// @property {Array|null} burstWorkers  — burst flash workers from control.burstFlash/control.burstWorkers
// @property {string|null} lastResultSummary
// @property {string|null} lastResponseSnippet
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Burst worker schema
//
// Each burst worker entry (control.burstWorkers[], else connected records in
// control.workers[] with burst: true) is a native hc terminal child:
//   @property {string}   workerId      — burst worker identifier (e.g. "burst-flash-1")
//   @property {string}   address       — hc terminal address (authoritative for peek/kill)
//   @property {string}   terminalState — lifecycle: pending|spawned|connected|busy|idle|retiring|gone
//   @property {string}   sessionDir    — Pi transcript/session directory path
//   @property {string}   logFile       — worker diagnostic log path
//   @property {number}   taskCount     — tasks served by this worker
//   @property {string}   lastEvent     — last known event/status
// No pid, launchMode, paneTitle or kittyWindowId: those ended with the kitty backend.
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Determine agent home dir. Respects PI_AGENT_HOME env var, falls back to ~/.pi/agent. */
function resolveAgentDir(overrides) {
	if (overrides?.agentDir) return overrides.agentDir;
	const envDir = process.env.PI_AGENT_HOME;
	if (envDir && typeof envDir === "string" && envDir.trim()) return envDir.trim();
	return join(homedir(), ".pi", "agent");
}

function loadConfig(agentDir) {
	const configPath = join(agentDir, "mind-worker.json");
	try {
		return JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		return {};
	}
}

/** Check if a process is alive by sending signal 0. */
function isPidAlive(pid) {
	if (!pid || typeof pid !== "number") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// NOTE: No active socket probing. Opening a connection to the mind's Unix socket
// triggers the server's close handler which rewrites the control file status,
// corrupting busy state. socketConnectable is set equal to socketExists — file
// presence combined with PID-alive + heartbeat-fresh + workersConnected is
// already a strong running-detection signal without side effects.

/** Read a JSON file, return null on failure. */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/** Read a JSONL file, return last N entries as array. */
function readJsonl(path, max = 200) {
	try {
		const text = readFileSync(path, "utf-8");
		const lines = text.trim().split("\n").filter(Boolean);
		const entries = lines.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		}).filter(Boolean);
		return entries.slice(-max);
	} catch {
		return [];
	}
}

// Static worker ids are the launcher's own `worker-<index>`; a non-canonical id
// (leading zero, another role) has no session dir to report.
const STATIC_WORKER_ID = /^worker-(0|[1-9]\d*)$/;

// The tmux module's wrapper always carries the transcript dir in the child's
// identity, so the recorded start command names it without a guess.
const SESSION_DIR_MARKER = /(?:^|\s)PI_MIND_WORKER_SESSION_DIR=(\S+)/;

/**
 * v3/tmux static workers: the exact owned %pane and the session dir their own
 * start command records. A record without them reports null, never a guess.
 */
function tmuxStaticWorkerLocation(manifest, workerId) {
	if (!STATIC_WORKER_ID.test(workerId)) return { address: null, sessionDir: null };
	const entry = manifest.workerPanes?.[workerId];
	const paneId = typeof entry?.paneId === "string" && /^%[0-9]+$/.test(entry.paneId) ? entry.paneId : null;
	const command = typeof entry?.startCommand === "string" ? entry.startCommand : "";
	const match = SESSION_DIR_MARKER.exec(command);
	const sessionDir = match && match[1].startsWith("/") ? match[1] : null;
	return { address: paneId, sessionDir };
}

/**
 * Static workers get their address and transcript dir from the launcher's own
 * record: manifest v2 for hc, the v3 tmux record for %panes. Fields stay null when
 * the record does not carry them: never invent a path for a legacy or malformed
 * record, and never read hc fields out of a tmux record (or the reverse).
 */
function staticWorkerLocation(agentDir, manifest, workerId) {
	if (manifest?.schemaVersion === 3 && manifest.terminalBackend === "tmux") {
		return tmuxStaticWorkerLocation(manifest, workerId);
	}
	if (manifest?.schemaVersion !== 2 || manifest.terminalBackend !== "hc") {
		return { address: null, sessionDir: null };
	}
	const match = STATIC_WORKER_ID.exec(workerId);
	if (!match) return { address: null, sessionDir: null };

	const recorded = manifest.workerAddresses?.[workerId];
	const address = typeof recorded === "string" && recorded ? recorded : null;
	const cwdHash = typeof manifest.cwdHash === "string" ? manifest.cwdHash : "";
	if (!cwdHash) return { address, sessionDir: null };
	// Same shape as the launcher's workerSessDir(id, i): id = [instance-]cwdHash.
	const instance = typeof manifest.instance === "string" && manifest.instance ? manifest.instance + "-" : "";
	return { address, sessionDir: join(agentDir, "sessions", `worker-${instance}${cwdHash}-${match[1]}`) };
}

// --------------------------------------------------------------------------
// Instance parsing
// --------------------------------------------------------------------------

/**
 * Parse a single hash from its manifest path.
 * Returns null if manifest is unreadable.
 */
function parseInstance(agentDir, hash, staleMs) {
	const stateDir = join(agentDir, "mindworker");
	const manifestPath = join(stateDir, `${hash}-manifest.json`);
	const manifest = readJson(manifestPath);
	if (!manifest) return null;

	const cwd = manifest.cwd || "";
	const label = manifest.label || (cwd ? basename(cwd) || cwd : hash);
	const shortHash = hash.slice(0, 8);
	const mindPid = manifest.mindPid || manifest.mindSupervisorPid || 0;
	// Manifest v2 (hc) markers; a legacy record carries neither.
	const terminalBackend = manifest.terminalBackend || null;
	const rootTerminalAddress = manifest.rootTerminalAddress || null;

	// Control file
	const controlPath = join(stateDir, `${hash}-mind-control.json`);
	const control = readJson(controlPath);

	// Determine heartbeat timestamp
	const heartbeat =
		control?.lastHeartbeat ||
		control?.lastUpdated ||
		manifest.lastUpdated ||
		0;

	const heartbeatFresh = heartbeat > 0 && (Date.now() - heartbeat) < staleMs;
	const mindPidAlive = isPidAlive(mindPid);

	// Socket
	const socketPath = join(stateDir, `${hash}.sock`);
	const socketExists = existsSync(socketPath);

	// Workers
	const workersConnected = control?.connectedWorkers ?? 0;
	const workersExpected = control?.expectedWorkers ?? manifest.workerCount ?? 1;

	// Workers list from control file. control.workers[] records only id/tier/busy for
	// statics, so their address and transcript dir come from the manifest. Whitelist
	// the fields: stale pid/launchMode/paneTitle/kittyWindowId never reach the view.
	const workers = (control?.workers || []).map((w) => {
		const base = {
			workerId: w?.workerId,
			tier: w?.tier,
			busy: w?.busy,
			taskId: w?.taskId,
			connectedAt: w?.connectedAt,
		};
		if (w?.burst) return { ...base, burst: true };
		return { ...base, ...staticWorkerLocation(agentDir, manifest, String(w?.workerId ?? "")) };
	});

	// Active / queued tasks
	const activeTasks = control?.activeTasks || [];
	const queuedTasks = control?.queuedTasks || [];

	// Results / responses JSONL
	const resultsPath = join(stateDir, `${hash}-results.jsonl`);
	const responsesPath = join(stateDir, `${hash}-responses.jsonl`);
	const results = readJsonl(resultsPath);
	const responses = readJsonl(responsesPath);

	// Last result summary
	const lastResultSummary = results.length > 0
		? (results[results.length - 1].summary || results[results.length - 1].explanation || "").slice(0, 200)
		: null;

	// Last response snippet (capped ~120 chars for table display)
	const lastResponseSnippet = responses.length > 0
		? (responses[responses.length - 1].text || "").slice(0, 120)
		: null;

	// Burst workers: control.burstWorkers[] carries every tracked burst, including
	// pending spawns that have no socket yet; control.workers[] only carries connected
	// ones. Merge both, top-level first so its lifecycle state wins.
	const burstWorkers = [];
	const seenBurstIds = new Set();
	const addBurst = (bw) => {
		const workerId = bw.workerId || bw.burst || bw.id || "?";
		if (seenBurstIds.has(workerId)) return;
		seenBurstIds.add(workerId);
		burstWorkers.push({
			workerId,
			address: bw.address || null,
			terminalState: bw.terminalState || "",
			sessionDir: bw.sessionDir || null,
			logFile: bw.logFile || null,
			taskCount: bw.taskCount || 0,
			lastEvent: bw.lastEvent || "",
		});
	};
	if (Array.isArray(control?.burstWorkers)) control.burstWorkers.forEach(addBurst);
	if (Array.isArray(control?.workers)) control.workers.filter((w) => w.burst).forEach(addBurst);

	// Build instance object
	const inst = {
		hash,
		cwd,
		label,
		shortHash,
		manifest,
		control,
		results,
		responses,
		mindPid,
		mindPidAlive,
		terminalBackend,
		rootTerminalAddress,
		heartbeat,
		heartbeatFresh,
		socketExists,
		socketConnectable: socketExists, // no active probe — see note at top of file
		workersConnected,
		workersExpected,
		state: "unknown",
		running: false,
		activeTasks,
		queuedTasks,
		workers,
		burstWorkers,
		lastResultSummary,
		lastResponseSnippet,
	};

	return inst;
}

/**
 * Normalize a single instance's state based on the PRD D8 rules.
 * Mutates inst.state and inst.running in place.
 */
function normalizeState(inst, staleMs) {
	const { control, mindPidAlive, heartbeatFresh, workersConnected, workersExpected } = inst;

	// Running detection
	const manifestRunning = inst.manifest?.state === "running";
	if (!manifestRunning || !mindPidAlive || !heartbeatFresh) {
		inst.running = false;
		inst.state = "unknown";
		return;
	}

	// Socket or workers check (no active probe — see note at top of file)
	const hasSocket = inst.socketExists;
	const hasWorkers = workersConnected > 0;
	if (!hasSocket && !hasWorkers) {
		inst.running = false;
		inst.state = "unknown";
		return;
	}

	inst.running = true;

	// State normalization (PRD D8)
	if (!control) {
		inst.state = "idle";
		return;
	}

	const status = control.status || "";

	// error takes precedence
	if (status === "error" || control.message) {
		inst.state = "error";
		return;
	}

	// degraded: live heartbeat but fewer workers connected than expected
	if (workersConnected < workersExpected) {
		inst.state = "degraded";
		return;
	}

	// busy: active tasks or busy status
	if (status === "busy" || (inst.activeTasks && inst.activeTasks.length > 0)) {
		inst.state = "busy";
		return;
	}

	// worker-connected + nothing active = idle
	if (status === "worker-connected") {
		inst.state = "idle";
		return;
	}

	// Fallback — manifest running but control says something else
	inst.state = "idle";
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Scan all instances in the mindworker directory.
 *
 * @param {string} [agentDir] - Override agent directory (default ~/.pi/agent)
 * @param {Object} [opts]
 * @param {number} [opts.staleMs] - Stale threshold (default 30000)
 * @returns {Promise<InstanceSnapshot[]>}
 */
async function scanInstances(agentDir, opts = {}) {
	const ad = agentDir || resolveAgentDir();
	const staleMs = opts.staleMs || DEFAULT_STALE_MS;

	const stateDir = join(ad, "mindworker");
	if (!existsSync(stateDir)) return [];

	// Discover manifest files
	let entries;
	try {
		entries = readdirSync(stateDir);
	} catch {
		return [];
	}

	const manifestFiles = entries.filter(
		(e) => e.endsWith("-manifest.json") && !e.includes("-mind-control"),
	);

	// Extract hashes
	const hashes = manifestFiles.map((f) => f.replace("-manifest.json", ""));

	// Parse each instance
	const instances = [];
	for (const hash of hashes) {
		const inst = parseInstance(ad, hash, staleMs);
		if (inst) instances.push(inst);
	}

	// Normalize state (sync pass — no async socket probing)
	for (const inst of instances) {
		normalizeState(inst, staleMs);
	}

	return instances;
}

/**
 * Sort instances: busy/error/degraded first (priority group), then by heartbeat recency.
 * Non-running instances are pushed to end.
 */
function sortInstances(instances) {
	const stateRank = { busy: 0, error: 1, degraded: 2, idle: 3, unknown: 4 };

	return [...instances].sort((a, b) => {
		// Running instances before non-running
		if (a.running !== b.running) return a.running ? -1 : 1;

		const rankA = stateRank[a.state] ?? 4;
		const rankB = stateRank[b.state] ?? 4;
		if (rankA !== rankB) return rankA - rankB;

		// Within same state: most recent heartbeat first
		return (b.heartbeat || 0) - (a.heartbeat || 0);
	});
}

/**
 * Format a human-readable status tag for an instance.
 */
function formatStateTag(state) {
	switch (state) {
		case "busy": return "\x1b[33mBUSY\x1b[0m";      // yellow
		case "error": return "\x1b[31mERROR\x1b[0m";     // red
		case "degraded": return "\x1b[35mDEGRADED\x1b[0m"; // magenta
		case "idle": return "\x1b[32mIDLE\x1b[0m";        // green
		default: return "\x1b[90m?\x1b[0m";               // gray
	}
}

export {
	scanInstances,
	normalizeState,
	sortInstances,
	formatStateTag,
	resolveAgentDir,
	loadConfig,
	readJsonl,
	parseInstance,
};
