#!/usr/bin/env node

// mind-worker-dashboard.mjs — Terminal dashboard CLI for mind-worker instances.
//
// Usage:
//   mind-worker-dashboard          # TUI mode (poll 2s)
//   mind-worker-dashboard --json   # JSON snapshot, one shot
//   mind-worker-dashboard --no-bell  # Suppress terminal bell
//
// Zero dependencies — only Node built-ins.

import { scanInstances, sortInstances, formatStateTag, resolveAgentDir } from "./dashboard-backend.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;
const DEFAULT_STALE_MS = 30_000;

// ── Transition notification state ──────────────────────────────────────
// Tracks previous-state per hash across poll cycles.
const prevStates = new Map(); // hash → { state, heartbeat }
// Accumulated transitions since last render: Map<hash, {from, to}>
let pendingTransitions = new Map();
// Whether bell has been rung for each transition fingerprint this session
const bellFingerprints = new Set();
const TRANSITION_EXPIRY_MS = 10_000;

// ── CLI flags ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const jsonFlag = argv.includes("--json");
const noBell = argv.includes("--no-bell");

// --------------------------------------------------------------------------
// Config helpers
// --------------------------------------------------------------------------

function getStaleMs(agentDir) {
	try {
		const configPath = join(agentDir, "mind-worker.json");
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		return typeof raw.dashboardStaleMs === "number" && raw.dashboardStaleMs > 0
			? raw.dashboardStaleMs
			: DEFAULT_STALE_MS;
	} catch {
		return DEFAULT_STALE_MS;
	}
}

// --------------------------------------------------------------------------
// Transition detection
// --------------------------------------------------------------------------

/**
 * Compare current running instances against prevStates map.
 * Returns a Map<hash, {from, to}> of new transitions.
 */
function detectTransitions(instances) {
	const transitions = new Map();

	for (const inst of instances) {
		if (!inst.running) continue;
		const prev = prevStates.get(inst.hash);
		if (!prev) continue; // first sighting, no transition

		const oldState = prev.state;
		const newState = inst.state;

		if (oldState === newState) continue;

		// Detect meaningful transitions
		let notify = false;
		if (oldState === "busy" && newState === "idle") notify = true;
		if (newState === "error") notify = true;
		if (newState === "degraded") notify = true;

		if (notify) {
			transitions.set(inst.hash, { from: oldState, to: newState, seenAt: Date.now() });

			// Terminal bell (unless suppressed or deduped)
			if (!noBell) {
				const fp = `${inst.hash}:${oldState}->${newState}`;
				if (!bellFingerprints.has(fp)) {
					bellFingerprints.add(fp);
					// Ring bell
					process.stdout.write("\x07");
				}
			}
		}
	}

	return transitions;
}

/**
 * Update prevStates map with current running instances.
 */
function updatePrevStates(instances) {
	for (const inst of instances) {
		if (inst.running) {
			prevStates.set(inst.hash, { state: inst.state, heartbeat: inst.heartbeat });
		} else {
			prevStates.delete(inst.hash);
		}
	}
}

// --------------------------------------------------------------------------
// JSON output mode
// --------------------------------------------------------------------------

async function printJson(agentDir) {
	const staleMs = getStaleMs(agentDir);
	const instances = await scanInstances(agentDir, { staleMs,  });
	const sorted = sortInstances(instances);
	const running = sorted.filter((i) => i.running);

	const clean = running.map((i) => ({
		hash: i.hash,
		cwd: i.cwd,
		label: i.label,
		shortHash: i.shortHash,
		mindPid: i.mindPid,
		mindPidAlive: i.mindPidAlive,
		heartbeat: i.heartbeat,
		heartbeatFresh: i.heartbeatFresh,
		socketExists: i.socketExists,
		socketConnectable: i.socketConnectable,
		workersConnected: i.workersConnected,
		workersExpected: i.workersExpected,
		state: i.state,
		activeTasks: i.activeTasks,
		queuedTasks: i.queuedTasks,
		workers: i.workers,
		burstWorkers: i.burstWorkers,
		lastResultSummary: i.lastResultSummary,
		lastResponseSnippet: i.lastResponseSnippet,
	}));

	const output = {
		timestamp: Date.now(),
		count: clean.length,
		instances: clean,
	};
	console.log(JSON.stringify(output, null, 2));
}

// --------------------------------------------------------------------------
// TUI mode
// --------------------------------------------------------------------------

function enableRawMode() {
	const stdin = process.stdin;
	if (stdin.isTTY) {
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf-8");
	}
}

function disableRawMode() {
	try {
		process.stdin.setRawMode(false);
		process.stdin.pause();
	} catch {
		/* ignore */
	}
}

function clearScreen() {
	process.stdout.write("\x1b[2J\x1b[H");
}

function hideCursor() {
	process.stdout.write("\x1b[?25l");
}

function showCursor() {
	process.stdout.write("\x1b[?25h");
}

function stateTagPlain(state) {
	switch (state) {
		case "busy": return "BUSY";
		case "error": return "ERROR";
		case "degraded": return "DEGRADED";
		case "idle": return "IDLE";
		default: return "?";
	}
}

/** Get a short visual badge for a transition. */
function transitionBadge(from, to) {
	if (to === "idle") return "\x1b[32m\u25B4\x1b[0m";    // green up-tick
	if (to === "error") return "\x1b[31m\u2717\x1b[0m";   // red X
	if (to === "degraded") return "\x1b[35m\u26A0\x1b[0m"; // magenta warning
	return "";
}

/** Format duration since a timestamp. */
function timeSince(ts) {
	if (!ts) return "-";
	const diff = Date.now() - ts;
	if (diff < 1000) return "now";
	if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
	if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
	return `${Math.floor(diff / 3600000)}h`;
}

function pad(str, width) {
	const plain = str.replace(/\x1b\[[0-9;]*m/g, "");
	if (plain.length > width) return str.slice(0, width);
	return str + " ".repeat(width - plain.length);
}

/**
 * Render the TUI.
 */
function render(instances, selectedIdx, detailHash, errorMsg, transitions) {
	clearScreen();

	const running = instances.filter((i) => i.running);
	const sorted = sortInstances(running);

	const header = `\x1b[1mMind Instance Dashboard\x1b[0m  \x1b[90m${new Date().toLocaleTimeString()}\x1b[0m  (${sorted.length} running, \x1b[32mq\x1b[90m=quit \x1b[32mr\x1b[90m=refresh \x1b[32mEnter\x1b[90m=detail)`;
	console.log(header);

	// ── Transition notification banner ──
	if (transitions && transitions.size > 0) {
		const parts = [];
		for (const [hash, tr] of transitions) {
			const inst = running.find((i) => i.hash === hash);
			const label = inst ? inst.label : hash.slice(0, 8);
			const badge = transitionBadge(tr.from, tr.to);
			parts.push(`${badge} ${label}: ${tr.from}\u2192${tr.to}`);
		}
		if (parts.length > 0) {
			console.log(`\x1b[33m${parts.join("  ")}\x1b[0m`);
		}
	} else {
		console.log("");
	}

	if (sorted.length === 0) {
		if (errorMsg) {
			console.log(`\x1b[31m${errorMsg}\x1b[0m`);
		} else {
			console.log("  \x1b[33m\u26A0 No running mind-worker instances.\x1b[0m");
			console.log("  \x1b[90mStart a pair from any project directory:\x1b[0m");
			console.log("    \x1b[36mmind-worker-launcher --cwd /path/to/project\x1b[0m");
			console.log("    \x1b[90mThen check back here. The dashboard auto-refreshes every 2s.\x1b[0m");
		}
		console.log("");
		console.log("\x1b[90mPress q to quit.\x1b[0m");
		return;
	}

	// ── Detail view ─────────────────────────────────────────────────
	if (detailHash) {
		const inst = sorted.find((i) => i.hash === detailHash);
		if (inst) {
			renderDetailView(inst);
			return;
		}
	}

	// ── Table view ─────────────────────────────────────────────────
	const colState = 10;
	const colLabel = 30;
	const colHash = 10;
	const colWorkers = 12;
	const colHeartbeat = 10;
	const colResponse = 50;

	const headerRow = [
		pad("STATE", colState),
		pad("INSTANCE", colLabel),
		pad("HASH", colHash),
		pad("WORKERS", colWorkers),
		pad("ACTIVE", colHeartbeat),
		pad("LAST RESPONSE", colResponse),
	].join("");

	console.log(`\x1b[90m${headerRow}\x1b[0m`);

	for (let i = 0; i < sorted.length; i++) {
		const inst = sorted[i];
		const isSelected = i === selectedIdx;
		const hasTransition = transitions && transitions.has(inst.hash);

		const stateTag = formatStateTag(inst.state);
		const stateStr = stateTagPlain(inst.state);

		const label = inst.label + (inst.shortHash ? ` [${inst.shortHash}]` : "");
		const burstCount = inst.burstWorkers && inst.burstWorkers.length > 0 ? inst.burstWorkers.length : 0;
		const workersStr = burstCount > 0
			? `${inst.workersConnected}/${inst.workersExpected}+${burstCount}`
			: `${inst.workersConnected}/${inst.workersExpected}`;
		const heartbeatStr = timeSince(inst.heartbeat);
		const activeStr = inst.activeTasks.length > 0
			? `${inst.activeTasks.length} task(s)`
			: "-";

		const responseStr = inst.lastResponseSnippet
			? inst.lastResponseSnippet.slice(0, colResponse - 1)
			: (inst.lastResultSummary ? inst.lastResultSummary.slice(0, colResponse - 1) : "");

		// Add transition badge next to state tag
		let prefix = isSelected ? "\x1b[7m > " : "   ";
		let suffix = isSelected ? " \x1b[0m" : "";
		let stateDisplay = stateTag;
		if (hasTransition) {
			const tr = transitions.get(inst.hash);
			const badge = transitionBadge(tr.from, tr.to);
			stateDisplay = `${badge} ${stateTag}`;
		}

		const row = [
			pad(stateStr, colState - 1),
			pad(label, colLabel),
			pad(inst.shortHash, colHash),
			pad(workersStr, colWorkers),
			pad(activeStr || heartbeatStr, colHeartbeat),
			pad(responseStr, colResponse),
		].join(" ");

		const coloredRow = stateDisplay + row.slice(stateStr.length);
		console.log(`${prefix}${coloredRow}${suffix}`);
	}

	console.log("");
	if (errorMsg) {
		console.log(`\x1b[31m${errorMsg}\x1b[0m`);
	}
	const bellHint = noBell ? "" : " \x1b[90m(bell on transition)\x1b[0m";
	console.log(`\x1b[90m\u2191\u2193 Navigate  Enter Detail  r Refresh  q Quit${bellHint}\x1b[0m`);
}

function renderDetailView(inst) {
	const stateTag = formatStateTag(inst.state);
	const lines = [
		`\x1b[1mDetail: ${inst.label} [${inst.shortHash}]\x1b[0m`,
		`${"=".repeat(60)}`,
		`  CWD:     ${inst.cwd}`,
		`  State:   ${stateTag}  (running: ${inst.running})`,
		`  PID:     ${inst.mindPid} (${inst.mindPidAlive ? "\x1b[32malive\x1b[0m" : "\x1b[31mdead\x1b[0m"})`,
		`  Gen:     ${inst.manifest?.generation ?? "-"}`,
		`  Socket:  ${inst.socketExists ? "\x1b[32mpresent\x1b[0m" : "\x1b[31mabsent\x1b[0m"}`,
		`  Workers: ${inst.workersConnected}/${inst.workersExpected}`,
		`  HB:      ${timeSince(inst.heartbeat)} ago`,
		``,
	];

	if (inst.workers && inst.workers.length > 0) {
		lines.push(`\x1b[1mWorkers:\x1b[0m`);
		for (const w of inst.workers) {
			const status = w.busy ? "\x1b[33mbusy\x1b[0m" : "\x1b[32midle\x1b[0m";
			lines.push(`  ${w.workerId || "?"} [${w.tier || "?"}] ${status}  ${w.taskId ? `task: ${w.taskId.slice(0, 20)}` : ""}`);
		}
		lines.push("");
	}

	if (inst.activeTasks && inst.activeTasks.length > 0) {
		lines.push(`\x1b[1mActive Tasks:\x1b[0m`);
		for (const t of inst.activeTasks) {
			lines.push(`  ${t.taskId?.slice(0, 16) || "?"} ${t.tier || "?"}  ${(t.description || "").slice(0, 60)}`);
		}
		lines.push("");
	}

	if (inst.queuedTasks && inst.queuedTasks.length > 0) {
		lines.push(`\x1b[1mQueued Tasks:\x1b[0m`);
		for (const t of inst.queuedTasks) {
			lines.push(`  ${t.id?.slice(0, 16) || "?"} ${t.tier || "?"}  ${(t.description || "").slice(0, 60)}`);
		}
		lines.push("");
	}

	// ── Burst Workers section ─────────────────────────────────────
	if (inst.burstWorkers && inst.burstWorkers.length > 0) {
		lines.push(`\x1b[1mBurst Workers (${inst.burstWorkers.length}):\x1b[0m`);
		for (const bw of inst.burstWorkers) {
			const pidStr = bw.pid ? `pid=${bw.pid}${isPidAlive(bw.pid) ? " \x1b[32malive\x1b[0m" : " \x1b[31mdead\x1b[0m"}` : "pid=?";
			const lastEventStr = bw.lastEvent ? `  last: ${bw.lastEvent.slice(0, 80)}` : "";
			const displayId = bw.workerId || bw.burst || "?";
			lines.push(`  ${displayId}  ${pidStr}${lastEventStr}`);
			// Log tail if logPath exists
			if (bw.logPath && existsSync(bw.logPath)) {
				try {
					const logContent = readFileSync(bw.logPath, "utf-8");
					const logLines = logContent.split("\n").filter(Boolean);
					const tail = logLines.slice(-20);
					lines.push(`    \x1b[90mlog (${bw.logPath}):\x1b[0m`);
					for (const l of tail) {
						// Truncate long lines for compactness
						const truncated = l.length > 180 ? l.slice(0, 180) + "…" : l;
						lines.push(`    \x1b[90m${truncated}\x1b[0m`);
					}
				} catch {
					lines.push(`    \x1b[31m(log unreadable)\x1b[0m`);
				}
			} else if (bw.logPath) {
				lines.push(`    \x1b[90mlog: ${bw.logPath} (not found)\x1b[0m`);
			}
		}
		lines.push("");
	}

	if (inst.lastResultSummary) {
		lines.push(`\x1b[1mLast Result:\x1b[0m`);
		lines.push(`  ${inst.lastResultSummary.slice(0, 200)}`);
		lines.push("");
	}

	if (inst.responses && inst.responses.length > 0) {
		const last = inst.responses[inst.responses.length - 1];
		lines.push(`\x1b[1mLast Response:\x1b[0m`);
		lines.push(`  ${(last.text || last.response || "").slice(0, 200)}`);
		lines.push("");
	}

	lines.push(`\x1b[90mEsc Back  r Refresh  q Quit\x1b[0m`);

	console.log(lines.join("\n"));
}

// --------------------------------------------------------------------------
// TUI loop
// --------------------------------------------------------------------------

async function runTui(agentDir) {
	const staleMs = getStaleMs(agentDir);
	let instances = [];
	let selectedIdx = 0;
	let detailHash = null;
	let errorMsg = "";
	let running = true;

	enableRawMode();
	hideCursor();

	process.on("exit", () => {
		showCursor();
		disableRawMode();
	});
	process.on("SIGINT", () => {
		showCursor();
		disableRawMode();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		showCursor();
		disableRawMode();
		process.exit(0);
	});
	process.on("SIGWINCH", () => {
		render(instances, selectedIdx, detailHash, errorMsg, pendingTransitions);
	});

	// Initial fetch
	try {
		instances = await scanInstances(agentDir, { staleMs,  });
		errorMsg = "";
		updatePrevStates(instances);
	} catch (err) {
		errorMsg = `Scan error: ${err.message}`;
	}
	render(instances, selectedIdx, null, errorMsg, new Map());

	// Keyboard input
	const stdin = process.stdin;
	stdin.on("data", async (data) => {
		const key = data.toString();
		const code = key.charCodeAt(0);

		if (key === "q" || key === "Q") {
			running = false;
			showCursor();
			disableRawMode();
			process.exit(0);
			return;
		}

		if (key === "r" || key === "R") {
			try {
				instances = await scanInstances(agentDir, { staleMs,  });
				errorMsg = "";
				const transitions = detectTransitions(instances);
				updatePrevStates(instances);
				// Merge transitions preserving seenAt from existing entries
				pendingTransitions = new Map();
				for (const [hash, tr] of transitions) {
					pendingTransitions.set(hash, tr);
				}
				const sorted = sortInstances(instances.filter((i) => i.running));
				if (selectedIdx >= sorted.length) selectedIdx = Math.max(0, sorted.length - 1);
			} catch (err) {
				errorMsg = `Scan error: ${err.message}`;
			}
			render(instances, selectedIdx, detailHash, errorMsg, pendingTransitions);
			return;
		}

		if (key === "\x1b[A") {
			if (!detailHash) {
				const sorted = sortInstances(instances.filter((i) => i.running));
				if (selectedIdx > 0) selectedIdx--;
				render(instances, selectedIdx, null, errorMsg, pendingTransitions);
			}
			return;
		}

		if (key === "\x1b[B") {
			if (!detailHash) {
				const sorted = sortInstances(instances.filter((i) => i.running));
				if (selectedIdx < sorted.length - 1) selectedIdx++;
				render(instances, selectedIdx, null, errorMsg, pendingTransitions);
			}
			return;
		}

		if (code === 13 && !detailHash) {
			const sorted = sortInstances(instances.filter((i) => i.running));
			if (sorted.length > 0 && selectedIdx < sorted.length) {
				detailHash = sorted[selectedIdx].hash;
				render(instances, selectedIdx, detailHash, errorMsg, pendingTransitions);
			}
			return;
		}

		if (key === "\x1b" && detailHash) {
			detailHash = null;
			render(instances, selectedIdx, null, errorMsg, pendingTransitions);
			return;
		}
	});

	// Poll loop
	while (running) {
		await sleep(POLL_INTERVAL_MS);
		if (!running) break;
		try {
			instances = await scanInstances(agentDir, { staleMs,  });
			errorMsg = "";
			const transitions = detectTransitions(instances);
			// Merge with any existing pending transitions (newest wins per hash)
			for (const [hash, tr] of transitions) {
				pendingTransitions.set(hash, { ...tr, seenAt: Date.now() });
			}
			updatePrevStates(instances);
			// Expire old transitions (>10s) and filter if state changed again
			const now = Date.now();
			for (const [hash, tr] of pendingTransitions) {
				if (now - (tr.seenAt || 0) > TRANSITION_EXPIRY_MS) {
					pendingTransitions.delete(hash);
					continue;
				}
				const inst = instances.find((i) => i.hash === hash);
				if (inst && inst.running && inst.state !== tr.to) {
					pendingTransitions.delete(hash);
				}
			}
			const sorted = sortInstances(instances.filter((i) => i.running));
			if (selectedIdx >= sorted.length) selectedIdx = Math.max(0, sorted.length - 1);
		} catch (err) {
			errorMsg = `Scan error: ${err.message}`;
		}
		render(instances, selectedIdx, detailHash, errorMsg, pendingTransitions);
	}
}

function isPidAlive(pid) {
	if (!pid || typeof pid !== "number") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
	const agentDir = resolveAgentDir();

	if (jsonFlag) {
		await printJson(agentDir);
	} else {
		await runTui(agentDir);
	}
}

main().catch((err) => {
	console.error(`FATAL: ${err.message}`);
	process.exit(1);
});
