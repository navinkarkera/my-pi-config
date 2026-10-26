// Command blocker: ordered regex rules that block matching agent-issued commands.
// Covers only bash and powershell tool calls. User ! commands and custom or MCP
// tools are not checked. Guardrail, not a sandbox: patterns match the raw command
// text, so quoting and shell evaluation can slip past them.
//
// Config: <agent-dir>/command-blocker.json, one level up from this file and next to
// the extensions/ directory, { "rules": [{ pattern, flags?, feedback }] }.
// Compiled once at load; edit the file and reload to change it.
// Malformed config blocks every bash and powershell call instead of silently
// protecting nothing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Rule {
	regex: RegExp;
	feedback: string;
}

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../command-blocker.json", import.meta.url));

function invalid(message: string): never {
	throw new Error(`command-blocker: ${message}`);
}

/** Compile the config document into ordered rules. Throws on any invalid rule. */
export function compileRules(raw: unknown): Rule[] {
	if (typeof raw !== "object" || raw === null) invalid('config must be an object: { "rules": [...] }');
	const entries = (raw as { rules?: unknown }).rules;
	if (!Array.isArray(entries)) invalid('config needs a "rules" array');

	return entries.map((entry: unknown, index: number) => {
		const where = `rule ${index + 1}`;
		if (typeof entry !== "object" || entry === null) invalid(`${where} must be an object`);
		const { pattern, flags, feedback } = entry as { pattern?: unknown; flags?: unknown; feedback?: unknown };
		if (typeof pattern !== "string" || pattern === "") invalid(`${where} needs a non-empty "pattern"`);
		if (typeof feedback !== "string" || feedback === "") invalid(`${where} needs a non-empty "feedback"`);
		if (flags !== undefined && typeof flags !== "string") invalid(`${where} "flags" must be a string`);
		// Global and sticky flags make RegExp.test stateful between calls; drop them.
		const statelessFlags = (flags ?? "").replace(/[gy]/g, "");
		try {
			return { regex: new RegExp(pattern, statelessFlags), feedback };
		} catch (error) {
			invalid(`${where} has an invalid pattern: ${(error as Error).message}`);
		}
	});
}

/** Read and compile a config file. A missing or blank file means no rules. */
export function readConfig(path: string = DEFAULT_CONFIG_PATH): Rule[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		invalid(`cannot read ${path}: ${(error as Error).message}`);
	}
	if (text.trim() === "") return [];

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		invalid(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	try {
		return compileRules(raw);
	} catch (error) {
		invalid(`${path}: ${(error as Error).message.replace(/^command-blocker: /, "")}`);
	}
}

/** First rule matching the command, or undefined. */
export function matchRule(rules: Rule[], command: string): Rule | undefined {
	return rules.find((rule) => rule.regex.test(command));
}

export default function commandBlocker(pi: ExtensionAPI, configPath: string = DEFAULT_CONFIG_PATH) {
	let rules: Rule[] = [];
	let configError: string | undefined;
	try {
		rules = readConfig(configPath);
	} catch (error) {
		configError = (error as Error).message;
	}

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		const command = (event.input as { command?: unknown } | undefined)?.command;
		if (typeof command !== "string") return;
		if (configError) {
			return {
				block: true,
				reason: `${configError}\nEvery shell command is blocked until the config is fixed.`,
			};
		}
		const rule = matchRule(rules, command);
		if (rule) return { block: true, reason: rule.feedback };
	});
}
