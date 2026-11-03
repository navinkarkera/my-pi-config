#!/usr/bin/env node

// dashboard-backend.mjs — Reusable dashboard backend for mind-worker instances.
//
// Exports:
//   scanInstances(agentDir, opts) → InstanceSnapshot[]
//   normalizeState(instance) → string
//   sortInstances(instances) → InstanceSnapshot[]
//
// Zero dependencies — only Node built-ins.

import { createHash } from "node:crypto";
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
// @property {string|null} terminalBackend   — the record's own backend ("hc" v2, "tmux" v3, "mindmux" for a
//   synthesised Go record); null on a legacy record
// @property {string|null} rootTerminalAddress — manifest v2 root terminal address, or a mindmux record's root %pane;
//   null on a legacy record and on v3
// @property {Object|null} [mindmux]      — the raw Go record a mindmux instance came from
// @property {Array} [recordWorkers]      — a mindmux record's own workers (Go ids, tiers, %panes, session dirs),
//   listed even when the Mind's control file is gone; never mixed into workers[] so no live/idle claim is invented
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

/**
 * A pool's own result/response logs, named after its hash (pi's scoped task id).
 * Missing files are empty, never an error.
 */
function readResultLogs(stateDir, hash) {
	const results = readJsonl(join(stateDir, `${hash}-results.jsonl`));
	const responses = readJsonl(join(stateDir, `${hash}-responses.jsonl`));
	return {
		results,
		responses,
		lastResultSummary: results.length > 0
			? (results[results.length - 1].summary || results[results.length - 1].explanation || "").slice(0, 200)
			: null,
		lastResponseSnippet: responses.length > 0
			? (responses[responses.length - 1].text || "").slice(0, 120)
			: null,
	};
}

/**
 * Burst workers: control.burstWorkers[] carries every tracked burst, including
 * pending spawns that have no socket yet; control.workers[] only carries connected
 * ones. Merge both, top-level first so its lifecycle state wins.
 */
function collectBurstWorkers(control) {
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
	return burstWorkers;
}

/** A control field the view iterates: only a real array is evidence. */
function controlArray(value) {
	return Array.isArray(value) ? value : [];
}

// --------------------------------------------------------------------------
// Native mindmux (Go) discovery
//
// mindmux keeps one record per tmux session of its own, outside the agent dir:
//   stateRoot()/sessions/<key>.json                        Go record (version 1)
//   <record.controlFile>  =  $XDG_RUNTIME_DIR/mindmux/<key>-<hex gen>/control.json
// The record's key is a hash of the tmux server tuple and session id (state.go
// poolKey), so it is NOT pi's cwd hash. pi derives every path it owns from its own
// scoped task id instead:
//   <instance label>-<sha256(cwd)[:16]>,  label = "mx-g<generation>"
// and Go hands that same label to Mind and every worker (supervisor.go). Discovery
// therefore recomputes pi's id from the record's cwd and generation, and never
// assumes record.key is the dashboard hash.
// --------------------------------------------------------------------------

/**
 * Go's stateRoot(): XDG_STATE_HOME/mindmux when the variable is non-empty, else
 * ~/.local/state/mindmux. Go tests the variable for emptiness and joins it raw
 * (state.go), so it is never trimmed here either.
 */
function mindmuxStateRoot(opts = {}) {
	if (opts.mindmuxStateRoot) return opts.mindmuxStateRoot;
	const xdg = process.env.XDG_STATE_HOME || "";
	if (xdg) return join(xdg, "mindmux");
	return join(homedir(), ".local", "state", "mindmux");
}

// Go refuses any other record version (loadRecord), so a foreign or future record
// is not evidence about a pool we can name.
const MINDMUX_RECORD_VERSION = 1;

/**
 * pi's scoped task id for one mindmux generation (mindmux-host.mjs scopedTaskId
 * with the label Go passes as PI_MIND_WORKER_INSTANCE/MINDMUX_SESSION_KEY). A
 * record without a usable cwd or generation has no derivable id: null, never a
 * guess. If Go ever changes that label, discovery degrades to "unknown" instead
 * of showing a pool under a path pi did not write.
 */
function mindmuxTaskId(cwd, generation) {
	// Go records the pane's absolute cwd; anything else names no path pi writes.
	if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
	if (!Number.isSafeInteger(generation) || generation <= 0) return null;
	const cwdHash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return `mx-g${generation}-${cwdHash}`;
}

/** Read and validate one Go record. Null for unreadable, foreign or unnamed state. */
function readMindmuxRecord(path) {
	const record = readJson(path);
	if (!record || typeof record !== "object" || Array.isArray(record)) return null;
	if (record.version !== MINDMUX_RECORD_VERSION) return null;
	if (typeof record.state !== "string" || !record.state) return null;
	if (typeof record.key !== "string" || !record.key) return null;
	if (!mindmuxTaskId(record.root?.cwd, record.generation)) return null;
	return record;
}

/**
 * pi's control status for this generation. Go records its absolute path, and the
 * runtime dir is per generation, so only a control record naming this exact
 * generation is evidence. A missing, non-numeric or other generation proves
 * nothing about this pool and is dropped, never applied to it.
 */
function mindmuxControl(record) {
	const path = typeof record.controlFile === "string" ? record.controlFile : "";
	if (!path.startsWith("/")) return null;
	const control = readJson(path);
	if (!control || typeof control !== "object" || Array.isArray(control)) return null;
	const generation = control.generation;
	if (typeof generation !== "number" || generation !== record.generation) return null;
	return control;
}

/** Go's recorded workers, whitelisted: ids, tiers and the paths Go itself wrote. */
function mindmuxRecordWorkers(record) {
	const list = Array.isArray(record.workers) ? record.workers : [];
	return list
		.filter((w) => w && typeof w.id === "string" && w.id)
		.map((w) => ({
			workerId: w.id,
			tier: typeof w.tier === "string" ? w.tier : null,
			model: typeof w.model === "string" ? w.model : null,
			thinking: typeof w.thinking === "string" ? w.thinking : null,
			paneId: typeof w.paneId === "string" && /^%[0-9]+$/.test(w.paneId) ? w.paneId : null,
			sessionDir: typeof w.sessionDir === "string" && w.sessionDir.startsWith("/") ? w.sessionDir : null,
			state: typeof w.state === "string" ? w.state : null,
		}));
}

/**
 * One instance from a Go record. The legacy record shapes never reach here, and no
 * legacy field is read off a Go record: the generated manifest is pi's own view of
 * the record (state, generation, cwd) so the shared state rules apply unchanged.
 */
function parseMindmuxInstance(agentDir, record, staleMs) {
	const generation = record.generation;
	const cwd = record.root.cwd;
	const hash = mindmuxTaskId(cwd, generation);
	if (!hash) return null;
	const cwdHash = hash.slice(`mx-g${generation}-`.length);

	const stateDir = join(agentDir, "mindworker");
	const control = mindmuxControl(record);
	const recordWorkers = mindmuxRecordWorkers(record);
	const byWorkerId = new Map(recordWorkers.map((w) => [w.workerId, w]));

	// No control file means no freshness evidence: a freshly claimed record must not
	// read as ready. stopped/cleanup_unconfirmed never count as running here either —
	// the record's own state is the gate normalizeState applies.
	const heartbeat = control
		? (Number(control.lastHeartbeat) || Number(control.lastUpdated) || 0)
		: 0;
	const heartbeatFresh = control !== null && heartbeat > 0 && (Date.now() - heartbeat) < staleMs;

	const socketExists = existsSync(join(stateDir, `${hash}.sock`));

	const workers = controlArray(control?.workers).map((w) => {
		const base = {
			workerId: w?.workerId,
			tier: w?.tier,
			busy: w?.busy,
			taskId: w?.taskId,
			connectedAt: w?.connectedAt,
		};
		if (w?.burst) return { ...base, burst: true };
		const recorded = byWorkerId.get(String(w?.workerId ?? ""));
		// address stays null: the view prints an `hc read` hint for any non-tmux
		// backend, and a mindmux worker's %pane is not an hc address. The %pane is
		// reported as paneId, and the transcript dir is the one Go recorded.
		return {
			...base,
			address: null,
			sessionDir: recorded?.sessionDir ?? null,
			paneId: recorded?.paneId ?? null,
		};
	});

	const { results, responses, lastResultSummary, lastResponseSnippet } = readResultLogs(stateDir, hash);
	const rootPaneId = typeof record.root?.paneId === "string" && /^%[0-9]+$/.test(record.root.paneId)
		? record.root.paneId
		: null;

	return {
		hash,
		cwd,
		label: basename(cwd) || cwd,
		// The table shows the cwd fragment, not the id's "mx-g<generation>" prefix:
		// generation is already in the detail view, and labels repeat across checkouts.
		shortHash: cwdHash.slice(0, 8),
		manifest: {
			schemaVersion: 4,
			terminalBackend: "mindmux",
			state: record.state,
			generation,
			cwd,
			cwdHash,
			key: record.key,
			mindPid: Number(record.mind?.pid) || 0,
			lastUpdated: Number(record.updatedAt) || 0,
		},
		control,
		results,
		responses,
		mindPid: Number(record.mind?.pid) || 0,
		mindPidAlive: isPidAlive(Number(record.mind?.pid) || 0),
		terminalBackend: "mindmux",
		rootTerminalAddress: rootPaneId,
		heartbeat,
		heartbeatFresh,
		socketExists,
		socketConnectable: socketExists, // no active probe — see note at top of file
		workersConnected: control?.connectedWorkers ?? 0,
		workersExpected: control?.expectedWorkers ?? (recordWorkers.length || 1),
		state: "unknown",
		running: false,
		activeTasks: controlArray(control?.activeTasks),
		queuedTasks: controlArray(control?.queuedTasks),
		workers,
		burstWorkers: collectBurstWorkers(control),
		recordWorkers,
		mindmux: record,
		lastResultSummary,
		lastResponseSnippet,
	};
}

/** Every Go record under the mindmux state root. A missing dir is no instances. */
function parseMindmuxInstances(agentDir, opts, staleMs) {
	const dir = join(mindmuxStateRoot(opts), "sessions");
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const instances = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const record = readMindmuxRecord(join(dir, entry));
		if (!record) continue;
		const inst = parseMindmuxInstance(agentDir, record, staleMs);
		if (inst) instances.push(inst);
	}
	return instances;
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

	// Control file: the pi-written one next to the manifest. Go's own record is
	// never a manifest here (it lives in the mindmux state root and names its
	// per-generation control file for native discovery), so no env override applies.
	const control = readJson(join(stateDir, `${hash}-mind-control.json`));

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
	const workers = controlArray(control?.workers).map((w) => {
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
	const activeTasks = controlArray(control?.activeTasks);
	const queuedTasks = controlArray(control?.queuedTasks);

	const { results, responses, lastResultSummary, lastResponseSnippet } = readResultLogs(stateDir, hash);
	const burstWorkers = collectBurstWorkers(control);

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
 * Scan all instances: the agent's own mindworker records plus the native mindmux
 * (Go) records for this state root. Read-only — no socket is opened.
 *
 * @param {string} [agentDir] - Override agent directory (default ~/.pi/agent)
 * @param {Object} [opts]
 * @param {number} [opts.staleMs] - Stale threshold (default 30000)
 * @param {string} [opts.mindmuxStateRoot] - Override mindmux's Go state root (default XDG_STATE_HOME/mindmux
 *   or ~/.local/state/mindmux). Tests pass a temp root so no live pool is scanned.
 * @returns {Promise<InstanceSnapshot[]>}
 */
async function scanInstances(agentDir, opts = {}) {
	const ad = agentDir || resolveAgentDir();
	const staleMs = opts.staleMs || DEFAULT_STALE_MS;

	const stateDir = join(ad, "mindworker");
	const instances = [];
	const seen = new Set();

	// Discover manifest files
	let entries = [];
	try {
		entries = existsSync(stateDir) ? readdirSync(stateDir) : [];
	} catch {
		entries = [];
	}

	const manifestFiles = entries.filter(
		(e) => e.endsWith("-manifest.json") && !e.includes("-mind-control"),
	);

	// Extract hashes
	const hashes = manifestFiles.map((f) => f.replace("-manifest.json", ""));

	// Parse each instance
	for (const hash of hashes) {
		const inst = parseInstance(ad, hash, staleMs);
		if (!inst || seen.has(inst.hash)) continue;
		seen.add(inst.hash);
		instances.push(inst);
	}

	// Native mindmux records are a second, read-only source. Legacy discovery stays
	// until legacy hosting is removed: those pools still exist, their records are
	// still on disk, and hiding them would lose live instances from the view.
	for (const inst of parseMindmuxInstances(ad, opts, staleMs)) {
		if (seen.has(inst.hash)) continue;
		seen.add(inst.hash);
		instances.push(inst);
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
