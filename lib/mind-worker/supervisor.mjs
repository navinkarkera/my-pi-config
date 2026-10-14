#!/usr/bin/env node

// supervisor.mjs — Mind instance supervisor for launcher path.
// Wraps the mind Pi instance, relays I/O transparently, and polls the
// control file every 200ms for commands. Handles:
//   - command:"stop" with generation fencing → SIGTERM→SIGKILL + child-stopped
//   - Unexpected child crash → status:"error" with crash detail
//
// Launched by mind-worker-launcher instead of raw pi:
//   node supervisor.mjs --cwd <cwd> --session-dir <dir> --hash <hash>

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --------------------------------------------------------------------------
// CLI args
// --------------------------------------------------------------------------

let cwd = ".";
let sessionDir = "";
let hash = "";
let model = "";

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--cwd" && i + 1 < argv.length) cwd = argv[++i];
	if (argv[i] === "--session-dir" && i + 1 < argv.length) sessionDir = argv[++i];
	if (argv[i] === "--hash" && i + 1 < argv.length) hash = argv[++i];
	if (argv[i] === "--model" && i + 1 < argv.length) model = argv[++i];
}

if (!sessionDir || !hash) {
	console.error("Usage: supervisor.mjs --cwd <cwd> --session-dir <dir> --hash <hash>");
	process.exit(1);
}

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

const AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT_DIR, "mindworker");
const controlPath = join(STATE_DIR, `${hash}-mind-control.json`);

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function readControl() {
	try {
		return JSON.parse(readFileSync(controlPath, "utf-8"));
	} catch {
		return null;
	}
}

/** Atomic write to control file (.tmp + rename). */
function writeControl(data) {
	const tmpPath = controlPath + ".tmp";
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
	renameSync(tmpPath, controlPath);
}

/** Atomic update of a single manifest field (best-effort). */
function writeManifestField(key, value) {
	const manifestPath = join(STATE_DIR, `${hash}-manifest.json`);
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		// Generation sanity: refuse to write if generation doesn't match our session
		if (manifest.generation !== generation) return;
		manifest[key] = value;
		manifest.lastUpdated = Date.now();
		const tmpPath = manifestPath + ".tmp";
		writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf-8");
		renameSync(tmpPath, manifestPath);
	} catch {
		/* best-effort */
	}
}

function resolvePiPath() {
	const pathDirs = (process.env.PATH || "").split(":");
	for (const dir of pathDirs) {
		const candidate = join(dir, "pi");
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* try next */
		}
	}
	return "pi";
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
	const piPath = resolvePiPath();

	// Read generation from manifest (written by launcher before spawn)
	const manifestPath = join(STATE_DIR, `${hash}-manifest.json`);
	let generation = 0;
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		generation = manifest.generation || 0;
	} catch {
		// Write error to control file before exiting so launcher can detect early
		console.error(`Supervisor: manifest not found at ${manifestPath}`);
		try {
			const tmpPath = controlPath + ".tmp";
			writeFileSync(tmpPath, JSON.stringify({
				status: "error",
				generation: 0,
				message: `manifest not found at ${manifestPath}`,
				lastUpdated: Date.now(),
			}, null, 2), "utf-8");
			renameSync(tmpPath, controlPath);
		} catch { /* best-effort */ }
		process.exit(1);
	}

	// Write initial supervisor status once (extension will overwrite during normal op)
	writeControl({
		status: "waiting",
		generation,
		lastUpdated: Date.now(),
	});

	// Spawn mind child with inherited stdio so the interactive TUI works directly.
	// Supervisor keeps polling the control file as a background monitor.
	const piArgs = ["--session-dir", sessionDir];
	if (model) { piArgs.push("--model", model); }
	const child = spawn(piPath, piArgs, {
		stdio: "inherit",
		env: { ...process.env, PI_MIND_WORKER_ROLE: "mind" },
		cwd,
	});

	// Write mindChildPid to manifest for future reset use
	writeManifestField("mindChildPid", child.pid);

	let childExited = false;
	let exitCode = null;
	let exitSignal = null;

	child.on("exit", (code, signal) => {
		childExited = true;
		exitCode = code;
		exitSignal = signal;
	});

	child.on("error", (err) => {
		childExited = true;
		writeControl({
			status: "error",
			generation,
			message: `spawn error: ${err.message}`,
			lastUpdated: Date.now(),
		});
	});

	// Poll control file every 200ms
	while (!childExited) {
		await sleep(200);

		const ctrl = readControl();
		if (!ctrl) continue;

		// Generation mismatch → stale command from prior reset cycle, ignore
		if (ctrl.generation !== generation) continue;

		// Check for stop command
		if (ctrl.command === "stop") {
			// Graceful shutdown: SIGTERM first
			child.kill("SIGTERM");

			// Wait up to 3s for child to exit
			for (let waited = 0; waited < 3000 && !childExited; waited += 100) {
				await sleep(100);
			}

			// Force kill if still alive
			if (!childExited) {
				child.kill("SIGKILL");
				// Brief wait for kill to take effect
				await sleep(200);
			}

			// Report child stopped and clear command
			writeControl({
				status: "child-stopped",
				generation,
				command: "",
				lastUpdated: Date.now(),
			});

			process.exit(0);
		}
	}

	// Child exited unexpectedly (not via stop command)
	if (exitCode !== 0 || exitSignal) {
		writeControl({
			status: "error",
			generation,
			message: exitSignal
				? `child killed by signal ${exitSignal}`
				: `child exited with code ${exitCode}`,
			lastUpdated: Date.now(),
		});
	}
}

main().catch((err) => {
	console.error(`Supervisor fatal: ${err.message}`);
	process.exit(1);
});
