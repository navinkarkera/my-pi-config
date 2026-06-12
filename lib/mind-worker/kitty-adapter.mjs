#!/usr/bin/env node

// kitty-adapter.mjs — Injectable kitty pane adapter.
// Abstracts kitty terminal operations for the mind-worker launcher.
// Can be stubbed for testing or replaced when kittyEnabled is false.
//
// Usage:
//   import { createKittyAdapter } from "./kitty-adapter.mjs";
//   const kitty = createKittyAdapter(true);  // or false for no-op

import { spawn } from "node:child_process";

// --------------------------------------------------------------------------
// Low-level kitty execution
// --------------------------------------------------------------------------

/** Run a kitty CLI command, resolves on exit code 0. */
function runKitty(args) {
	return new Promise((resolve, reject) => {
		const stdoutChunks = [];
		const stderrChunks = [];
		const proc = spawn("kitty", args, {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15000,
		});
		proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
		proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));
		proc.on("error", (err) => reject(new Error(`kitty spawn failed: ${err.message}`)));
		proc.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
				const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
				reject(new Error(stderr || stdout || `exit code ${code}`));
			}
		});
	});
}

/** Run a kitty CLI command, capture stdout as string. */
function runKittyCapture(args) {
	return new Promise((resolve, reject) => {
		const stdoutChunks = [];
		const stderrChunks = [];
		const proc = spawn("kitty", args, {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10000,
		});
		proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
		proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));
		proc.on("error", (err) => reject(new Error(`kitty failed: ${err.message}`)));
		proc.on("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
			} else {
				const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
				reject(new Error(stderr || `exit code ${code}`));
			}
		});
	});
}

// --------------------------------------------------------------------------
// Adapter factory
// --------------------------------------------------------------------------

/**
 * Create a kitty adapter instance.
 * @param {boolean} enabled — if false, all operations become no-ops.
 */
export function createKittyAdapter(enabled = true) {
	if (!enabled) {
		// No-op adapter for kittyEnabled=false or testing
		return {
			enabled: false,
			launchTab: async () => {},
			launchSplit: async () => {},
			closeByTitle: async () => {},
			focusByTitle: async () => {},
			findWindowByTitle: async () => null,
		findWindowsByTitlePrefix: async () => [],
		runRaw: async () => {},
		runRawCapture: async () => "",
		closeById: async () => {},
		};
	}

	return {
		enabled: true,

		/** Launch a program in a new kitty tab with given title and cwd.
		 *  cmdAndArgs is the full argv array after title/cwd/env-var setup. */
		launchTab: async (title, cwd, cmdAndArgs) => {
			await runKitty([
				"@", "launch", "--type", "tab",
				"--title", title, "--cwd", cwd || "current",
				...cmdAndArgs,
			]);
		},

		/** Launch a program in a new right-split of the focused window. */
		launchSplit: async (title, cwd, cmdAndArgs) => {
			await runKitty([
				"@", "launch",
				"--title", title, "--cwd", cwd || "current", "--location", "hsplit",
				...cmdAndArgs,
			]);
		},

		/** Close a window by exact title match (best-effort). */
		closeByTitle: async (title) => {
			try {
				await runKitty(["@", "close-window", "--match", `title:${title}`]);
			} catch { /* best-effort */ }
		},

		/** Focus a window by exact title match (best-effort). */
		focusByTitle: async (title) => {
			try {
				await runKitty(["@", "focus-window", "--match", `title:${title}`]);
			} catch { /* best-effort */ }
		},

		/** Find window info by exact title match. Returns null if not found. */
		findWindowByTitle: async (title) => {
			try {
				const raw = await runKittyCapture(["@", "ls"]);
				const osWindows = JSON.parse(raw);
				if (!Array.isArray(osWindows)) return null;
				for (const osWin of osWindows) {
					for (const tab of osWin.tabs || []) {
						for (const w of tab.windows || []) {
							if (w.title === title) return w;
						}
					}
				}
			} catch { /* best-effort */ }
			return null;
		},

		/** Run raw kitty command (low-level, for ad-hoc needs). */
		runRaw: async (args) => {
			await runKitty(args);
		},

		/** Run raw kitty command, capture stdout as string. */
		runRawCapture: async (args) => {
			return await runKittyCapture(args);
		},

		/** Find all windows whose title starts with the given prefix. Returns array of window objects. */
		findWindowsByTitlePrefix: async (prefix) => {
			try {
				const raw = await runKittyCapture(["@", "ls"]);
				const osWindows = JSON.parse(raw);
				if (!Array.isArray(osWindows)) return [];
				const matches = [];
				for (const osWin of osWindows) {
					for (const tab of osWin.tabs || []) {
						for (const w of tab.windows || []) {
							if (w.title && w.title.startsWith(prefix)) {
								matches.push(w);
							}
						}
					}
				}
				return matches;
			} catch { /* best-effort */ }
			return [];
		},

		/** Close a window by its numeric kitty window id. */
		closeById: async (id) => {
			try {
				await runKitty(["@", "close-window", "--match", `id:${id}`]);
			} catch { /* best-effort */ }
		},
	};
}
