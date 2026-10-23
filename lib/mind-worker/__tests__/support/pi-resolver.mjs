// Test-only ESM resolution for the real extension.
//
// extensions/mind-worker.ts imports two bare specifiers that cannot resolve from
// this repo (package.json is {} and there is no node_modules):
//   - @earendil-works/pi-coding-agent
//   - typebox
// Pi loads the extension through its own loader, but a plain "node --test"
// import fails with ERR_MODULE_NOT_FOUND. Register a resolve hook that points
// both at the installed Pi package BEFORE importing the extension. Node 26
// strips the TypeScript itself; no jiti or build step is needed.

import { registerHooks } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function isPiPackageDir(dir) {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		return pkg.name === PI_PACKAGE && existsSync(join(dir, "dist", "index.js"));
	} catch {
		return false;
	}
}

/** Walk up from the installed "pi" shim until the owning package directory. */
function packageDirFromPath() {
	for (const dir of (process.env.PATH || "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, "pi");
		if (!existsSync(candidate)) continue;
		let current;
		try {
			current = realpathSync(candidate);
		} catch {
			continue;
		}
		for (let i = 0; i < 6; i += 1) {
			current = dirname(current);
			if (isPiPackageDir(current)) return current;
			if (current === dirname(current)) break;
		}
	}
	return null;
}

/** Absolute path of the installed Pi package, or null when unavailable. */
export function findPiPackageDir() {
	if (process.env.PI_PACKAGE_DIR && isPiPackageDir(process.env.PI_PACKAGE_DIR)) {
		return process.env.PI_PACKAGE_DIR;
	}
	const fromPath = packageDirFromPath();
	if (fromPath) return fromPath;
	const sibling = resolve(
		dirname(process.execPath), "..", "lib", "node_modules",
		"@earendil-works", "pi-coding-agent",
	);
	return isPiPackageDir(sibling) ? sibling : null;
}

/** typebox resolves to the ESM build Pi's own loader uses (exports["."].import). */
function typeboxEntry(packageDir) {
	const dir = join(packageDir, "node_modules", "typebox");
	const preferred = join(dir, "build", "index.mjs");
	if (existsSync(preferred)) return preferred;
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		const entry = pkg.exports?.["."]?.import ?? pkg.module;
		if (entry) return join(dir, entry);
	} catch { /* fall through */ }
	throw new Error("Cannot locate the typebox ESM entry under " + dir);
}

let installed = null;

/**
 * Install the resolve hook and return the resolved entry points.
 * Idempotent; safe to call from every test file and from fixture.load().
 */
export function installPiResolver() {
	if (installed) return installed;
	const packageDir = findPiPackageDir();
	if (!packageDir) {
		throw new Error(
			"Cannot locate the installed @earendil-works/pi-coding-agent package. " +
			"Set PI_PACKAGE_DIR or put 'pi' on PATH.",
		);
	}
	const piEntry = join(packageDir, "dist", "index.js");
	const boxEntry = typeboxEntry(packageDir);
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === PI_PACKAGE) {
				return { url: pathToFileURL(piEntry).href, format: "module", shortCircuit: true };
			}
			if (specifier === "typebox") {
				return { url: pathToFileURL(boxEntry).href, format: "module", shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	installed = {
		packageDir,
		piEntry,
		typeboxEntry: boxEntry,
		// Pi's own CLI entry, as mind-worker.ts derives it: getPackageDir()/dist/cli.js.
		cliPath: join(packageDir, "dist", "cli.js"),
	};
	return installed;
}

/** True when a real Pi CLI can be spawned for the end-to-end proof. */
export function realPiAvailability() {
	try {
		const { cliPath } = installPiResolver();
		if (!existsSync(cliPath)) {
			return { available: false, reason: "Pi CLI not found at " + cliPath };
		}
		return { available: true, cliPath, reason: null };
	} catch (error) {
		return { available: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/** Extension module URL; the caller appends a cache-busting query per instance. */
export const EXTENSION_URL = new URL("../../../../extensions/mind-worker.ts", import.meta.url).href;
