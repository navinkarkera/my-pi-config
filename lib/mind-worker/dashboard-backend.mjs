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
// @property {Array} workers
// @property {Array|null} burstWorkers  — burst flash workers from control.burstFlash/control.burstWorkers
// @property {string|null} lastResultSummary
// @property {string|null} lastResponseSnippet
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Burst worker schema
//
// Each burst worker entry (from control.burstFlash or control.burstWorkers):
//   @property {string}   burst       — burst worker identifier (e.g. "burst-0")
//   @property {number}   pid         — process ID
//   @property {string}   sessionDir  — session directory path
//   @property {string}   logPath     — path to worker log file
//   @property {string}   lastEvent   — last known event/status
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

	// Workers list from control file
	const workers = control?.workers || [];

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

	// Burst workers: build from control.workers[].burst or legacy control.burstWorkers array
	let burstWorkers = [];
	if (control?.workers && Array.isArray(control.workers)) {
		burstWorkers = control.workers
			.filter(w => w.burst)
			.map(w => ({
				workerId: w.workerId || "?",
				pid: w.pid || null,
				sessionDir: w.sessionDir || null,
				logPath: w.logPath || null,
				taskCount: w.taskCount || 0,
				lastEvent: w.lastEvent || "",
				launchMode: w.launchMode || "headless",
				paneTitle: w.paneTitle || null,
				kittyWindowId: w.kittyWindowId || null,
			}));
	} else if (Array.isArray(control?.burstWorkers)) {
		// Legacy fallback
		burstWorkers = control.burstWorkers.map(bw => ({
			workerId: bw.workerId || bw.burst || bw.id || "?",
			pid: bw.pid || null,
			sessionDir: bw.sessionDir || null,
			logPath: bw.logPath || null,
			taskCount: bw.taskCount || 0,
			lastEvent: bw.lastEvent || "",
			launchMode: bw.launchMode || "headless",
			paneTitle: bw.paneTitle || null,
			kittyWindowId: bw.kittyWindowId || null,
		}));
	}

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
