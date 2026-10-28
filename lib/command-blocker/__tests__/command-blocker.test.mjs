import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import commandBlocker, { matchRule, readConfig } from "../../../extensions/command-blocker.ts";

// Real extension module, fake pi API, real config files on disk.

function harness(config) {
	const dir = mkdtempSync(join(tmpdir(), "command-blocker-"));
	const configPath = join(dir, "command-blocker.json");
	if (config !== undefined) {
		writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
	}
	const handlers = new Map();
	commandBlocker({ on: (name, handler) => handlers.set(name, handler) }, configPath);
	return {
		call: (event) => handlers.get("tool_call")(event),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const bash = (command) => ({ toolName: "bash", input: { command } });

test("empty and missing config allow every command", () => {
	for (const config of [{ rules: [] }, ""]) {
		const blocker = harness(config);
		assert.equal(blocker.call(bash("rm -rf /")), undefined);
		blocker.cleanup();
	}
	const missing = harness(undefined);
	assert.equal(missing.call(bash("git clean -xfd")), undefined);
	missing.cleanup();
});

test("blocks a matching command with that rule's feedback", () => {
	const blocker = harness({ rules: [{ pattern: "\\bnpm publish\\b", feedback: "Publishing is manual." }] });
	assert.deepEqual(blocker.call(bash("npm publish --access public")), {
		block: true,
		reason: "Publishing is manual.",
	});
	assert.equal(blocker.call(bash("npm test")), undefined);
	blocker.cleanup();
});

test("applies rules in order and blocks on the first match", () => {
	const blocker = harness({
		rules: [
			{ pattern: "deploy", feedback: "first rule" },
			{ pattern: "deploy --prod", feedback: "second rule" },
		],
	});
	assert.equal(blocker.call(bash("deploy --prod")).reason, "first rule");
	blocker.cleanup();
});

test("an invalid regex blocks all shell commands with a clear reason", () => {
	const blocker = harness({ rules: [{ pattern: "deploy (", feedback: "x" }] });
	const result = blocker.call(bash("npm test"));
	assert.equal(result.block, true);
	assert.match(result.reason, /invalid pattern/);
	assert.match(result.reason, /Every shell command is blocked/);
	assert.equal(blocker.call({ toolName: "read", input: { path: "README.md" } }), undefined);
	blocker.cleanup();
});

test("invalid JSON blocks all shell commands", () => {
	const blocker = harness("{ not json");
	const result = blocker.call(bash("ls"));
	assert.equal(result.block, true);
	assert.match(result.reason, /is not valid JSON/);
	blocker.cleanup();
});

test("a config without a rules array blocks all shell commands", () => {
	const blocker = harness({ patterns: ["ls"] });
	assert.match(blocker.call(bash("ls")).reason, /needs a "rules" array/);
	blocker.cleanup();
});

test("ignores tool calls whose input carries no string command", () => {
	const blocker = harness({ rules: [{ pattern: ".*", feedback: "denied" }] });
	assert.equal(blocker.call({ toolName: "read", input: { path: "a.ts" } }), undefined);
	assert.equal(blocker.call({ toolName: "bash", input: { command: 5 } }), undefined);
	assert.equal(blocker.call({ toolName: "bash", input: undefined }), undefined);
	assert.equal(blocker.call({ toolName: "bash" }), undefined);
	assert.equal(blocker.call(bash("echo hi")).block, true);
	blocker.cleanup();
});

test("ignores command-shaped custom tools, even with matching or malformed config", () => {
	const matching = harness({ rules: [{ pattern: ".*", feedback: "denied" }] });
	assert.equal(matching.call({ toolName: "run_command", input: { command: "deploy" } }), undefined);
	matching.cleanup();

	const malformed = harness("{ not json");
	assert.equal(malformed.call({ toolName: "run_command", input: { command: "ls" } }), undefined);
	malformed.cleanup();
});

test("blocks a matching powershell command", () => {
	const blocker = harness({ rules: [{ pattern: "\\bRemove-Item\\b", feedback: "No recursive deletes." }] });
	assert.deepEqual(blocker.call({ toolName: "powershell", input: { command: "Remove-Item -Recurse C:\\" } }), {
		block: true,
		reason: "No recursive deletes.",
	});
	blocker.cleanup();
});

test("a rule configured with the g flag still matches on consecutive calls", () => {
	const blocker = harness({ rules: [{ pattern: "deploy", flags: "g", feedback: "no deploy" }] });
	assert.deepEqual(blocker.call(bash("deploy now")), { block: true, reason: "no deploy" });
	assert.deepEqual(blocker.call(bash("deploy now")), { block: true, reason: "no deploy" });
	blocker.cleanup();
});

// Destructive command shapes the shipped rules must block.
const DESTRUCTIVE = [
	"rm -rf /",
	"rm -rf -- /",
	"rm -rf /;",
	"rm -rf / | cat",
	"rm -rf /)",
	"rm --recursive --force /",
	"git push --force origin main",
	"git push -f origin main",
	"git push \\\n  --force origin main",
	"git reset --hard HEAD~1",
	"reboot",
	"sudo reboot",
	"systemctl reboot",
];
// Safe shapes that must stay allowed, including look-alikes the guardrail cannot parse.
const SAFE = [
	"npm run build",
	"git status",
	"git push origin main",
	"git push --force-with-lease origin main",
	"rm -rf ./build",
	"rm -rf /tmp",
	"rm -v /",
	"git reset HEAD~1",
	"echo reboot",
	"grep shutdown file",
	"grep -E 'shutdown|reboot' services.log",
	"echo rm -rf /",
	"npm rm -rf /",
	"git commit -m 'never git push --force again'",
	"git log --grep 'git reset --hard'",
	"ls && reboot",
];

test("the shipped example config blocks destructive commands only", () => {
	const rules = readConfig();
	assert.ok(rules.length > 0);
	for (const command of DESTRUCTIVE) {
		assert.ok(matchRule(rules, command), command + " should be blocked");
	}
	for (const command of SAFE) {
		assert.equal(matchRule(rules, command), undefined, command + " should be allowed");
	}
});

test("destructive commands wrapped in cd or rtk stay blocked with the base feedback, and wrapped safe commands stay allowed", () => {
	const rules = readConfig();
	for (const command of DESTRUCTIVE) {
		const base = matchRule(rules, command);
		assert.ok(base, command + " must be blocked unwrapped");
		for (const prefix of ["cd repo && ", "rtk ", "cd repo && rtk "]) {
			const wrapped = prefix + command;
			const match = matchRule(rules, wrapped);
			assert.ok(match, wrapped + " should be blocked");
			// First-match semantics: same rule, same reason.
			assert.equal(match.feedback, base.feedback, wrapped + " must keep the base rule feedback");
		}
	}
	for (const command of SAFE) {
		for (const prefix of ["cd repo && ", "rtk ", "cd repo && rtk "]) {
			const wrapped = prefix + command;
			assert.equal(matchRule(rules, wrapped), undefined, wrapped + " should be allowed");
		}
	}
});

test("the shipped config blocks full-suite test entrypoints but allows focused tests", () => {
	const rules = readConfig();
	for (const command of [
		"npm test",
		"npm run test",
		"pnpm test",
		"yarn run test",
		"npm test --silent",
		"npm test -- --runInBand",
		"make test",
		"make validate",
		"make -j8 test",
		"make test -j8",
		"pytest",
		"pytest -q",
		"pytest -x --maxfail=1",
		"python -m pytest",
		"python3 -m pytest",
		"python3 -m pytest -q",
	]) {
		assert.ok(matchRule(rules, command), command + " should be blocked");
	}
	for (const command of [
		"npm test -- path/to/test.js",
		"npm test -- -t auth",
		"npm run test -- path/to/test.js",
		"pnpm test -- path/to/test.js",
		"npm run test:unit",
		"make test TESTS=tests/unit",
		"make -j8 test TESTS=tests/unit",
		"make build",
		"pytest tests/test_one.py",
		"pytest -k auth",
		"pytest -q tests/test_one.py",
		"python -m pytest tests/test_one.py",
		"python3 -m pytest tests/test_one.py",
	]) {
		assert.equal(matchRule(rules, command), undefined, command + " should be allowed");
	}
	assert.match(matchRule(rules, "npm test").feedback, /focused/);
	assert.match(matchRule(rules, "pytest").feedback, /focused/);

	// Regression: workers prefix commands with "cd <dir> && ", which must not evade the rules.
	for (const command of [
		"cd /home/navin/.pi/agent && npm test",
		"cd repo && npm run test",
		"cd /tmp/project && make test",
		"cd repo && pytest -q",
		"cd repo && python3 -m pytest",
	]) {
		assert.ok(matchRule(rules, command), command + " should be blocked");
	}
	for (const command of [
		"cd repo && npm test -- path/to/test.js",
		"cd /home/navin/.pi/agent && pytest tests/test_one.py",
	]) {
		assert.equal(matchRule(rules, command), undefined, command + " should be allowed");
	}
});
