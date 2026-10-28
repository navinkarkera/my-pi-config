import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

// Focused coverage for the Kitty launcher's --thinking plumbing. The Kitty
// adapter shells out to "kitty" from PATH, so a fake kitty records every
// launch argv and fakes the readiness files the launcher polls.

const launcher = new URL("../mind-worker-launcher.mjs", import.meta.url).pathname;

const fakeKitty = [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "const args = process.argv.slice(2);",
  "fs.appendFileSync(process.env.KITTY_LOG, JSON.stringify({ args }) + '\\n');",
  "const val = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };",
  "if (args[0] === '@' && args[1] === 'ls') { process.stdout.write('[]'); process.exit(0); }",
  "if (args[0] === '@' && args[1] === 'launch') {",
  "  const title = val('--title') || '';",
  "  const envArg = args.find(a => a.startsWith('PI_MIND_WORKER_GENERATION=')) || '';",
  "  const gen = Number(envArg.split('=')[1] || 1);",
  "  if (title.startsWith('mind-')) {",
  "    try { const m = JSON.parse(fs.readFileSync(process.env.MANIFEST_FILE, 'utf8')); m.generation = gen; m.state = 'running'; fs.writeFileSync(process.env.MANIFEST_FILE, JSON.stringify(m)); } catch {}",
  "  } else if (title.startsWith('worker-')) {",
  "    // Count launches from the shared log: concurrent worker launches must not race a counter file.",
  "    const genArg = 'PI_MIND_WORKER_GENERATION=' + gen;",
  "    const launches = fs.readFileSync(process.env.KITTY_LOG, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line).args);",
  "    const count = launches.filter(argv => argv.includes('PI_MIND_WORKER_ROLE=worker') && argv.includes(genArg)).length;",
  "    fs.writeFileSync(process.env.CONTROL_FILE, JSON.stringify({ status: 'worker-connected', generation: gen, connectedWorkers: count, lastUpdated: Date.now() }));",
  "  }",
  "}",
].join("\n");

function readJsonl(path) {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for kitty launcher condition");
}

function fixture(t, config) {
  const root = mkdtempSync(join(tmpdir(), "mind-worker-kitty-test-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const stateDir = join(agentDir, "mindworker");
  const project = join(root, "project");
  const fakeBin = join(root, "bin");
  for (const dir of [agentDir, stateDir, join(agentDir, "sessions"), project, fakeBin]) mkdirSync(dir, { recursive: true });

  const kittyLog = join(root, "kitty.jsonl");
  writeFileSync(join(fakeBin, "kitty"), fakeKitty);
  chmodSync(join(fakeBin, "kitty"), 0o755);

  const cwd = realpathSync(project);
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const controlFile = join(stateDir, hash + "-mind-control.json");
  const manifestFile = join(stateDir, hash + "-manifest.json");
  const socketFile = join(stateDir, hash + ".sock");

  writeFileSync(join(agentDir, "mind-worker.json"), JSON.stringify({ kittyEnabled: true, ...config }));

  const env = {
    ...process.env,
    HOME: home,
    PATH: fakeBin + ":" + dirname(process.execPath) + ":" + (process.env.PATH || ""),
    KITTY_LOG: kittyLog,
    CONTROL_FILE: controlFile,
    MANIFEST_FILE: manifestFile,
  };
  for (const key of ["KITTY_LISTEN_ON", "KITTY_WINDOW_ID", "MIND_WORKER_LAUNCHER_BACKGROUND"]) delete env[key];

  const children = [];
  const servers = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  return {
    root, home, agentDir, stateDir, project: cwd, cwd, hash, controlFile, manifestFile, socketFile, env, kittyLog, children, servers,
  };
}

/** Start the launcher and expose the readiness socket only after its preflight. */
function startLauncher(f) {
  const child = spawn(process.execPath, [launcher], { cwd: f.project, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const entry = { child, closed, output: () => ({ stdout, stderr }) };
  f.children.push(entry);

  // The socket file marks a pair as live, so it may only appear after isPairLive().
  const ready = (async () => {
    await waitFor(() => readJsonl(f.kittyLog).some(event => {
      const i = event.args.indexOf("--title");
      return i !== -1 && String(event.args[i + 1]).startsWith("mind-");
    }));
    const server = createServer(socket => socket.destroy());
    f.servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(f.socketFile, resolve);
    });
  })();
  entry.ready = ready;
  return entry;
}

function launches(f) {
  return readJsonl(f.kittyLog)
    .filter(event => event.args[0] === "@" && event.args[1] === "launch")
    .map(event => {
      const args = event.args;
      const titleIndex = args.indexOf("--title");
      const title = titleIndex === -1 ? "" : String(args[titleIndex + 1]);
      const thinkingIndex = args.indexOf("--thinking");
      const modelIndex = args.indexOf("--model");
      const envArg = args.find(arg => arg.startsWith("PI_MIND_WORKER_GENERATION=")) || "";
      return {
        title,
        role: title.startsWith("mind-") ? "mind" : "worker",
        generation: envArg.split("=")[1] || null,
        model: modelIndex === -1 ? null : args[modelIndex + 1],
        thinking: thinkingIndex === -1 ? null : args[thinkingIndex + 1],
      };
    });
}

async function runLauncher(f) {
  const proc = startLauncher(f);
  await proc.ready;
  const result = await proc.closed;
  assert.deepEqual(result, { code: 0, signal: null }, "launcher output: " + proc.output().stdout + proc.output().stderr);
  return launches(f);
}

test("kitty launcher: no thinking settings keeps workers on max and Mind on the Pi default", async t => {
  const f = fixture(t, {
    mindModel: "vendor/mind-model",
    workerModels: [{ model: "vendor/worker-model", count: 2, tier: "flash" }],
  });
  const found = await runLauncher(f);
  const mind = found.filter(entry => entry.role === "mind");
  assert.equal(mind.length, 1);
  assert.equal(mind[0].thinking, null, "Mind must not receive --thinking when unconfigured");
  assert.equal(mind[0].model, "vendor/mind-model");
  assert.deepEqual(found.filter(entry => entry.role === "worker").map(entry => entry.thinking), ["max", "max"]);
});

test("kitty launcher: configured mind and per-entry worker thinking levels reach the CLI", async t => {
  const f = fixture(t, {
    mindModel: "vendor/mind-model",
    mindThinkingLevel: "medium",
    workerThinkingLevel: "high",
    workerModels: [
      { model: "vendor/worker-a", count: 1, tier: "flash" },
      { model: "vendor/worker-b", count: 1, tier: "strong", thinkingLevel: "low" },
    ],
  });
  const found = await runLauncher(f);
  const mind = found.filter(entry => entry.role === "mind");
  assert.equal(mind[0].thinking, "medium");
  const workers = found.filter(entry => entry.role === "worker")
    .map(entry => [entry.model, entry.thinking])
    .sort((a, b) => a[0].localeCompare(b[0]));
  // worker-a inherits the global level, worker-b overrides it per entry
  assert.deepEqual(workers, [["vendor/worker-a", "high"], ["vendor/worker-b", "low"]]);
});

test("kitty launcher: invalid thinking settings never reach the CLI", async t => {
  const f = fixture(t, {
    mindModel: "vendor/mind-model",
    mindThinkingLevel: "turbo",
    workerThinkingLevel: "banana",
    workerModels: [{ model: "vendor/worker-model", count: 1, tier: "flash", thinkingLevel: "nope" }],
  });
  const found = await runLauncher(f);
  const mind = found.filter(entry => entry.role === "mind");
  assert.equal(mind[0].thinking, null);
  assert.deepEqual(found.filter(entry => entry.role === "worker").map(entry => entry.thinking), ["max"]);
});

test("kitty launcher: unreadable config falls back to max workers and no Mind thinking", async t => {
  const f = fixture(t, { mindModel: "unused" });
  // A brand-new or broken config disables kitty, so the fallback shows up in the printed commands.
  writeFileSync(join(f.agentDir, "mind-worker.json"), "{ not json");
  const child = spawn(process.execPath, [launcher], { cwd: f.project, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  f.children.push(child);
  const code = await new Promise(resolve => child.once("close", resolve));
  assert.equal(code, 0, stdout + stderr);

  assert.match(stderr, /mind-worker\.json invalid/);
  const workerLines = stdout.split("\n").filter(line => line.includes("PI_MIND_WORKER_ROLE=worker"));
  assert.equal(workerLines.length, 3);
  for (const line of workerLines) assert.match(line, /--thinking max/);
  const mindLines = stdout.split("\n").filter(line => line.includes("PI_MIND_WORKER_ROLE=mind"));
  assert.equal(mindLines.length, 1);
  assert.doesNotMatch(mindLines[0], /--thinking/);
});
