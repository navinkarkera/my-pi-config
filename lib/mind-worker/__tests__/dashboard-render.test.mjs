// dashboard-render.test.mjs — display-sanitization tests for the mind-worker dashboard.
// Every assertion compares exact captured bytes (or exact captured lines); captured
// output is never stripped or post-processed.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const DASHBOARD = fileURLToPath(new URL("../mind-worker-dashboard.mjs", import.meta.url));
const FROZEN_TIME = "12:00:00";
const CSI_CLEAR = "\x1b[2J";
const OSC_TITLE = "\x1b]0;t\x07";
const HASH = "a1b2c3d4e5f6a7b8";
// Future heartbeat keeps timeSince() at "now" regardless of test timing.
const HEARTBEAT = Date.now() + 60_000;

// Oldest installed Node 20/22 runtime, if present. Never installs or uses the network.
function findOlderNode() {
	const installs = join(homedir(), ".local/share/mise/installs/node");
	try {
		const versions = readdirSync(installs)
			.filter((version) => /^(20|22)\./.test(version))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		for (const version of versions) {
			const nodePath = join(installs, version, "bin", "node");
			if (existsSync(nodePath)) return nodePath;
		}
	} catch {
		/* no mise installs */
	}
	return null;
}
const OLDER_NODE = findOlderNode();
const OLDER_SKIP = OLDER_NODE ? false : "no installed Node 20/22 runtime";

// --------------------------------------------------------------------------
// Capture harness — one ordered array, stdout.write + console.log.
// --------------------------------------------------------------------------

async function capture(fn) {
	const chunks = [];
	const originalLog = console.log;
	const originalWrite = process.stdout.write;
	const originalToLocaleTimeString = Date.prototype.toLocaleTimeString;
	console.log = (...args) => {
		chunks.push(args.join(" "));
	};
	process.stdout.write = (chunk) => {
		chunks.push(String(chunk));
		return true;
	};
	Date.prototype.toLocaleTimeString = () => FROZEN_TIME;
	try {
		await fn();
	} finally {
		console.log = originalLog;
		process.stdout.write = originalWrite;
		Date.prototype.toLocaleTimeString = originalToLocaleTimeString;
	}
	return chunks;
}

// Exactly one import for the whole suite, captured to prove inertness.
let dashboard;
const importChunks = await capture(async () => {
	dashboard = await import(DASHBOARD);
});
const { render, renderDetailView } = dashboard;

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function fixture(overrides = {}) {
	return {
		hash: HASH,
		shortHash: "abcd1234",
		label: "alpha",
		cwd: "/tmp/project",
		manifest: { generation: 7 },
		mindPid: 4242,
		mindPidAlive: true,
		heartbeat: HEARTBEAT,
		socketExists: true,
		workersConnected: 1,
		workersExpected: 1,
		state: "busy",
		running: true,
		activeTasks: [{ taskId: "task-1", tier: "flash", description: "Do the thing" }],
		queuedTasks: [{ id: "queued-1", tier: "strong", description: "Later thing" }],
		workers: [{ workerId: "w-1", tier: "flash", busy: true, taskId: "task-1" }],
		burstWorkers: [],
		lastResultSummary: "result-ok",
		lastResponseSnippet: "resp-ok",
		responses: [{ text: "response-ok" }],
		...overrides,
	};
}

// Safe fixture: the visible text every polluted field folds back to.
function safeFixture(logPath) {
	return fixture({
		activeTasks: [{ taskId: "task-1", tier: "flash", description: "Do the thing" }],
		queuedTasks: [{ id: "queued-1", tier: "strong", description: "Later thing" }],
		workers: [{ workerId: "w-1", tier: "flash", busy: true, taskId: "task-1" }],
		burstWorkers: [
			{ workerId: "burst-k", pid: process.pid, lastEvent: "spawned", launchMode: "kitty", paneTitle: "pane-a", logPath },
			{ workerId: "burst-h", pid: process.pid, lastEvent: "spawned", launchMode: "headless", logPath },
		],
	});
}

// Polluted fixture: every display sink prefixed with a complete control sequence;
// cwd (unsliced) also ends in a lone C0 residual.
function pollutedFixture(logPath) {
	return fixture({
		label: CSI_CLEAR + "alpha",
		shortHash: CSI_CLEAR + "abcd1234",
		cwd: CSI_CLEAR + "/tmp/project\u0007",
		manifest: { generation: CSI_CLEAR + "7" },
		activeTasks: [{ taskId: CSI_CLEAR + "task-1", tier: CSI_CLEAR + "flash", description: CSI_CLEAR + "Do the thing" }],
		queuedTasks: [{ id: CSI_CLEAR + "queued-1", tier: CSI_CLEAR + "strong", description: CSI_CLEAR + "Later thing" }],
		workers: [{ workerId: CSI_CLEAR + "w-1", tier: CSI_CLEAR + "flash", busy: true, taskId: CSI_CLEAR + "task-1" }],
		burstWorkers: [
			{ workerId: CSI_CLEAR + "burst-k", pid: process.pid, lastEvent: OSC_TITLE + "spawned", launchMode: "kitty", paneTitle: CSI_CLEAR + "pane-a", logPath },
			{ workerId: CSI_CLEAR + "burst-h", pid: process.pid, lastEvent: OSC_TITLE + "spawned", launchMode: "headless", logPath },
		],
		lastResultSummary: CSI_CLEAR + "result-ok",
		lastResponseSnippet: CSI_CLEAR + "resp-ok",
		responses: [{ text: CSI_CLEAR + "response-ok" }],
	});
}

// --------------------------------------------------------------------------
// Private temp fixtures
// --------------------------------------------------------------------------

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "mw-render-"));

// Sink log files: polluted path and its visible-equivalent safe path, identical
// visible content, so a byte difference can only come from display sanitation.
const sinkDir = join(FIXTURE_ROOT, "sinks");
mkdirSync(sinkDir);
const pollutedLogPath = join(sinkDir, "log-" + CSI_CLEAR + "worker.txt");
const safeLogPath = join(sinkDir, "log-worker.txt");
writeFileSync(pollutedLogPath, CSI_CLEAR + "log tail line\n");
writeFileSync(safeLogPath, "log tail line\n");

// Raw-IO log file: the only file at this real, control-bearing path.
const ioDir = join(FIXTURE_ROOT, "io");
mkdirSync(ioDir);
const rawIOPath = join(ioDir, "log-" + CSI_CLEAR + "io.log");
writeFileSync(rawIOPath, "raw io works\n");

// --json agent home: one running instance whose result summary carries a sentinel.
const jsonHome = join(FIXTURE_ROOT, "json-home");
const jsonStateDir = join(jsonHome, "mindworker");
mkdirSync(jsonStateDir, { recursive: true });
writeFileSync(
	join(jsonStateDir, HASH + "-manifest.json"),
	JSON.stringify({
		cwd: "/tmp/project",
		cwdHash: HASH,
		state: "running",
		label: "alpha",
		generation: 7,
		mindPid: process.pid,
		lastUpdated: Date.now(),
		startedAt: Date.now(),
	}),
);
writeFileSync(join(jsonStateDir, HASH + ".sock"), "");
writeFileSync(
	join(jsonStateDir, HASH + "-results.jsonl"),
	JSON.stringify({ id: 1, summary: CSI_CLEAR + "raw json value" }) + "\n",
);

// --------------------------------------------------------------------------
// Cases
// --------------------------------------------------------------------------

describe("dashboard render sanitation", () => {
	it("import is inert and exports render", () => {
		assert.deepEqual(importChunks, []);
		assert.equal(typeof render, "function");
		assert.equal(typeof renderDetailView, "function");
	});

	it("a minimal valid snapshot renders as before", async () => {
		const chunks = await capture(() => render([fixture()], 0, null, "", new Map()));
		assert.equal(chunks[0], "\x1b[2J\x1b[H");
		assert.equal(
			chunks[1],
			"\x1b[1mMind Instance Dashboard\x1b[0m  \x1b[90m" + FROZEN_TIME +
				"\x1b[0m  (1 running, \x1b[32mq\x1b[90m=quit \x1b[32mr\x1b[90m=refresh \x1b[32mEnter\x1b[90m=detail)",
		);
		assert.equal(chunks[2], "");
		assert.ok(chunks[3].startsWith("\x1b[90mSTATE"));
		assert.equal(chunks.length, 7);
	});

	it("safe unicode is preserved", async () => {
		const inst = fixture({ label: "prøjekt-ü", lastResponseSnippet: null, lastResultSummary: "✓ naïve façade" });
		const table = await capture(() => render([inst], 0, null, "", new Map()));
		const row = table.find((line) => line.includes("prøjekt-ü"));
		assert.ok(row, "label column should render");
		assert.ok(row.includes("✓ naïve façade"));
		const detail = await capture(() => render([inst], 0, inst.hash, "", new Map()));
		assert.ok(detail.at(-1).split("\n").includes("  ✓ naïve façade"));
	});

	it("sanitizing runs before slicing", async () => {
		const visible = "A".repeat(30) + "B".repeat(30);
		const unsafe = CSI_CLEAR + "A".repeat(30) + CSI_CLEAR + "B".repeat(30);
		const unsafeChunks = await capture(() =>
			render([fixture({ lastResponseSnippet: null, lastResultSummary: unsafe })], 0, null, "", new Map()),
		);
		const safeChunks = await capture(() =>
			render([fixture({ lastResponseSnippet: null, lastResultSummary: visible })], 0, null, "", new Map()),
		);
		assert.deepEqual(unsafeChunks, safeChunks);
	});

	it("a folded newline keeps one field on one line", async () => {
		const unsafeChunks = await capture(() =>
			render([fixture({ lastResponseSnippet: null, lastResultSummary: "alpha\nbeta\rgamma\tdelta" })], 0, null, "", new Map()),
		);
		const safeChunks = await capture(() =>
			render([fixture({ lastResponseSnippet: null, lastResultSummary: "alpha beta gamma delta" })], 0, null, "", new Map()),
		);
		assert.deepEqual(unsafeChunks, safeChunks);
	});

	it("app-owned ANSI is preserved exactly", async () => {
		const inst = fixture();
		const detail = await capture(() => render([inst], 0, inst.hash, "", new Map()));
		const heading = "\x1b[1mDetail: " + inst.label + " [" + inst.shortHash + "]\x1b[0m";
		assert.equal(detail.at(-1).split("\n")[0], heading);
		const withError = await capture(() => render([], 0, null, "Scan error: boom", new Map()));
		assert.ok(withError.includes("\x1b[31mScan error: boom\x1b[0m"));
	});

	it("every sink is sanitized", async () => {
		const polluted = pollutedFixture(pollutedLogPath);
		const safe = safeFixture(safeLogPath);
		const pollutedTable = await capture(() => render([polluted], 0, null, CSI_CLEAR + "boom", new Map()));
		const safeTable = await capture(() => render([safe], 0, null, "boom", new Map()));
		assert.deepEqual(pollutedTable, safeTable);
		const pollutedDetail = await capture(() => render([polluted], 0, polluted.hash, "", new Map()));
		const safeDetail = await capture(() => render([safe], 0, safe.hash, "", new Map()));
		assert.deepEqual(pollutedDetail, safeDetail);
	});

	it("raw scalar numeric sinks are sanitized in table and detail", async () => {
		const safe = fixture({
			mindPid: "4242",
			workersConnected: "1",
			workersExpected: "1",
			burstWorkers: [
				{ workerId: "burst-scalar", pid: String(process.pid), lastEvent: "spawned", launchMode: "headless", logPath: null },
			],
		});
		const polluted = fixture({
			mindPid: CSI_CLEAR + "4242",
			workersConnected: CSI_CLEAR + "1",
			workersExpected: CSI_CLEAR + "1",
			burstWorkers: [
				{ workerId: "burst-scalar", pid: CSI_CLEAR + String(process.pid), lastEvent: "spawned", launchMode: "headless", logPath: null },
			],
		});
		const safeTable = await capture(() => render([safe], 0, null, "", new Map()));
		const pollutedTable = await capture(() => render([polluted], 0, null, "", new Map()));
		assert.deepEqual(pollutedTable, safeTable);
		const safeDetail = await capture(() => render([safe], 0, safe.hash, "", new Map()));
		const pollutedDetail = await capture(() => render([polluted], 0, polluted.hash, "", new Map()));
		assert.deepEqual(pollutedDetail, safeDetail);

		// Valid numbers keep their exact output.
		const numeric = fixture();
		const numericDetail = await capture(() => render([numeric], 0, numeric.hash, "", new Map()));
		const numericLines = numericDetail.at(-1).split("\n");
		assert.ok(numericLines.some((line) => line.startsWith("  PID:     4242 (")));
		assert.ok(numericLines.includes("  Workers: 1/1"));
	});

	it("--json stays raw", () => {
		const result = spawnSync(process.execPath, [DASHBOARD, "--json"], {
			env: { ...process.env, PI_AGENT_HOME: jsonHome },
			encoding: "utf-8",
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout.includes("\x1b"), false);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.instances[0].lastResultSummary, CSI_CLEAR + "raw json value");
	});

	function runJson(nodeBin, entry = DASHBOARD) {
		return spawnSync(nodeBin, [entry, "--json"], {
			env: { ...process.env, PI_AGENT_HOME: jsonHome },
			encoding: "utf-8",
		});
	}

	it("direct --json executes on the older installed Node", { skip: OLDER_SKIP }, () => {
		const result = runJson(OLDER_NODE);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.instances[0].lastResultSummary, CSI_CLEAR + "raw json value");
	});

	it("import stays inert on the older installed Node", { skip: OLDER_SKIP }, () => {
		const script = `const m = await import(${JSON.stringify(pathToFileURL(DASHBOARD).href)}); console.log("imported", typeof m.render, typeof m.renderDetailView);`;
		const result = spawnSync(OLDER_NODE, ["--input-type=module", "-e", script], { encoding: "utf-8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout, "imported function function\n");
	});

	it("direct --json through a symlinked entry executes on the older installed Node", { skip: OLDER_SKIP }, () => {
		const link = join(FIXTURE_ROOT, "dashboard-link.mjs");
		if (!existsSync(link)) symlinkSync(DASHBOARD, link);
		const result = runJson(OLDER_NODE, link);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.count, 1);
	});

	it("log path is used raw for IO, printed sanitized", async () => {
		assert.equal(existsSync(rawIOPath), true);
		const printedPath = rawIOPath.replace(CSI_CLEAR, "");
		const inst = fixture({
			burstWorkers: [
				{ workerId: "burst-io", pid: process.pid, lastEvent: "", launchMode: "headless", logPath: rawIOPath },
			],
		});
		const detail = await capture(() => render([inst], 0, inst.hash, "", new Map()));
		const lines = detail.at(-1).split("\n");
		assert.ok(lines.includes("    \x1b[90mlog (" + printedPath + "):\x1b[0m"));
		assert.ok(lines.includes("    \x1b[90mraw io works\x1b[0m"));
	});
});

// --------------------------------------------------------------------------
// Cleanup private fixtures
// --------------------------------------------------------------------------

after(() => {
	rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});
