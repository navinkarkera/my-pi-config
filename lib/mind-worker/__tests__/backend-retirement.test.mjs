// backend-retirement.test.mjs - the retired hc/tmux entrypoints stay retired.
//
// bin/mind-worker-launcher is now only a mindmux delegation shim: Herdr's
// pi-current-mind runs that exact path with no arguments and requires it to be
// executable. tmux-cleanup.mjs keeps only its read-only --check-stopped guard.
// A fake mindmux binary proves the delegation, the argv and the exit code;
// nothing here starts a pool, a tmux server or a model.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LAUNCHER = join(HERE, "..", "..", "..", "bin", "mind-worker-launcher");
const CLEANUP = join(HERE, "..", "tmux-cleanup.mjs");

const FAKE = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FAKE_MINDMUX_LOG"',
  'if [ -n "$FAKE_MINDMUX_EXIT" ]; then exit "$FAKE_MINDMUX_EXIT"; fi',
  "exit 0",
  "",
].join("\n");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "launcher-shim-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const log = join(dir, "calls.log");
  const fake = join(binDir, "mindmux");
  writeFileSync(fake, FAKE, { mode: 0o755 });
  chmodSync(fake, 0o755);
  const env = { ...process.env, PATH: binDir + ":/usr/bin:/bin", FAKE_MINDMUX_LOG: log };
  for (const key of ["MINDMUX_BIN", "MIND_WORKER_LAUNCHER_BACKGROUND", "FAKE_MINDMUX_EXIT"]) delete env[key];
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { dir, binDir, fake, log, env, calls };
}

const run = (fx, args, extra = {}) =>
  spawnSync(LAUNCHER, args, { encoding: "utf8", timeout: 20000, env: { ...fx.env, ...extra } });

test("a plain start and --force are pure delegation, and the exit code is kept", (t) => {
  const fx = fixture(t);

  const plain = run(fx, []);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(fx.calls(), ["start"]);
  assert.equal(plain.stdout, "");

  const forced = run(fx, ["--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(fx.calls(), ["start", "start --force"]);
  assert.equal(forced.stdout, "");

  // Both calls were recorded, and the shim created no state of its own.
  assert.equal(fx.calls().length, 2);
  assert.deepEqual(readFileSync(fx.log, "utf8").trim().split("\n"), ["start", "start --force"]);

  // A failing mindmux start is surfaced, not swallowed or retried.
  const failing = run(fx, [], { FAKE_MINDMUX_EXIT: "7" });
  assert.equal(failing.status, 7, failing.stderr);
});

test("MINDMUX_BIN wins over PATH", (t) => {
  const fx = fixture(t);
  const moved = join(fx.dir, "elsewhere", "mindmux");
  mkdirSync(join(fx.dir, "elsewhere"), { recursive: true });
  writeFileSync(moved, FAKE, { mode: 0o755 });
  chmodSync(moved, 0o755);

  const result = run(fx, [], { MINDMUX_BIN: moved, PATH: "/usr/bin:/bin" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fx.calls(), ["start"]);
});

test("a missing or non-executable mindmux refuses the start and names it", (t) => {
  const fx = fixture(t);
  const empty = join(fx.dir, "empty-path");
  mkdirSync(empty, { recursive: true });
  // The shebang needs bash; only the mindmux lookup must fail.
  symlinkSync("/bin/bash", join(empty, "bash"));

  const missing = run(fx, [], { PATH: empty });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /mindmux is not installed/);
  assert.deepEqual(fx.calls(), [], "nothing was executed");

  const absent = run(fx, [], { MINDMUX_BIN: join(fx.dir, "no-such-mindmux") });
  assert.equal(absent.status, 1, absent.stderr);
  assert.match(absent.stderr, /not executable/);

  const plain = join(fx.dir, "plain-mindmux");
  writeFileSync(plain, FAKE, { mode: 0o644 });
  const notExecutable = run(fx, ["--force"], { MINDMUX_BIN: plain });
  assert.equal(notExecutable.status, 1, notExecutable.stderr);
  assert.match(notExecutable.stderr, /not executable/);
  assert.deepEqual(fx.calls(), []);
});

test("every retired flag and session argument is refused before any delegation", (t) => {
  const fx = fixture(t);
  const retired = [
    ["--backend", "tmux"],
    ["--backend=hc"],
    ["--reset"],
    ["--background"],
    ["--instance", "alt"],
    ["--cwd", "/tmp/project"],
    ["@3"],
    ["some-session"],
    ["--force", "extra"],
  ];
  for (const args of retired) {
    const result = run(fx, args);
    assert.equal(result.status, 2, args.join(" ") + ": " + result.stderr);
    assert.equal(result.stdout, "", args.join(" ") + ": stdout is quiet");
    assert.match(result.stderr, /mindmux start/, args.join(" ") + ": names the new entrypoint");
  }
  assert.match(run(fx, ["--backend", "tmux"]).stderr, /--backend/);
  assert.match(run(fx, ["@3"]).stderr, /session arguments are no longer accepted/);
  assert.deepEqual(fx.calls(), [], "a refused invocation never reaches mindmux");
});

test("--help describes the delegation and starts nothing", (t) => {
  const fx = fixture(t);
  const result = run(fx, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /mindmux/);
  assert.deepEqual(fx.calls(), []);
});

test("MIND_WORKER_LAUNCHER_BACKGROUND is refused", (t) => {
  const fx = fixture(t);
  const result = run(fx, [], { MIND_WORKER_LAUNCHER_BACKGROUND: "1" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /MIND_WORKER_LAUNCHER_BACKGROUND is gone/);
  assert.deepEqual(fx.calls(), []);
});

test("the retirement stays static: no legacy module, backend flag or cleanup import survives", () => {
  assert.equal(existsSync(LAUNCHER), true);
  assert.notEqual(statSync(LAUNCHER).mode & 0o111, 0, "Herdr requires the launcher to be executable");
  const launcher = readFileSync(LAUNCHER, "utf8");
  assert.doesNotMatch(launcher, /hc-launcher\.mjs|hc-terminal\.mjs|tmux-terminal\.mjs|terminalBackend/);
  assert.doesNotMatch(launcher, /--backend|--reset|--instance|--background/);
  // It delegates and never hosts: the only program it runs is the mindmux binary.
  assert.match(launcher, /exec "\$\{BIN\}" start/);

  const cleanup = readFileSync(CLEANUP, "utf8");
  assert.doesNotMatch(cleanup, /from "\.\/tmux-terminal\.mjs"/);
  assert.doesNotMatch(cleanup, /cleanupPool|inspectPool|probeTmuxSource|probeTmuxRoot/);
  // The only mode left is the read-only check.
  assert.match(cleanup, /--check-stopped/);
});
