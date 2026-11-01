// hc-terminal.mjs — the one place that starts and retires hc (herdr-core)
// worker terminals for the mind-worker pair (static workers and native bursts).
//
// argv only: no shell strings, no inherited environment, no HC_* assignments
// to a child. hc itself keeps the caller's HC_SESSION/HC_SOCKET selector, which
// is how every call reaches the caller's core.
//
// Core identity has two different meanings:
//   coreIdentity(env)          a selector snapshot only (kept for compatibility)
//   probeCoreIdentity(...)     the authoritative core {id,name,version} from
//                              `hc server status --json`
// Use the probed id for ownership and for fencing async/old-generation results.
// HC_SCOPE and HC_TERMINAL_SOCKET are per-terminal and are never core identity.

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_GONE_TIMEOUT_MS = 2000;
const DEFAULT_POLL_MS = 100;
const MAX_OUTPUT_BYTES = 256 * 1024;
const ENV_BIN = "/usr/bin/env";

// The only variables a worker may receive through hc run. hc gives a child the
// core's environment and has no --env, so identity travels in argv; anything
// else (a shell export, a credential) must not.
const IDENTITY_KEYS = new Set([
  "PI_MIND_WORKER_ROLE",
  "PI_MIND_WORKER_TIER",
  "PI_MIND_WORKER_ID",
  "PI_MIND_WORKER_GENERATION",
  "PI_MIND_WORKER_SESSION_DIR",
  "PI_MIND_WORKER_INSTANCE",
]);

// hc names: 1-32 of a-z 0-9 - _ . and must start with a letter or digit.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
// Core-local terminal address/name. `machine/t7` is another machine: reject it.
const ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class HcError extends Error {
  constructor(message, {
    code = null,
    kind = null,
    hint = null,
    spawnPending = false,
    terminalName = null,
    rootAddress = null,
  } = {}) {
    super(message);
    this.name = "HcError";
    this.code = code;
    this.kind = kind;
    this.hint = hint;
    this.spawnPending = spawnPending;
    this.terminalName = terminalName;
    this.rootAddress = rootAddress;
  }
}

function copyEnv(value) {
  const source = value ?? process.env;
  const env = {};
  for (const [key, val] of Object.entries(source)) {
    if (typeof val === "string") env[key] = val;
  }
  return env;
}

function readSelector(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasCoreSelector(env) {
  return Boolean(readSelector(env, "HC_SESSION") || readSelector(env, "HC_SOCKET"));
}

/**
 * Selector snapshot, kept for callers that store it in a manifest. This is not
 * proof of which core answered. Use probeCoreIdentity() for that.
 */
export function coreIdentity(env = process.env) {
  return {
    socket: readSelector(env, "HC_SOCKET"),
    terminalSocket: readSelector(env, "HC_TERMINAL_SOCKET"),
    session: readSelector(env, "HC_SESSION"),
    scope: readSelector(env, "HC_SCOPE"),
  };
}

/**
 * Authoritative core identity from `hc server status --json`.
 * Refuses to run without HC_SESSION or HC_SOCKET: a missing selector would
 * silently start/select the user's default core.
 *
 * Returns { id, name, version, session, socket }. `socket` is the explicit
 * HC_SOCKET selector when present, never the per-terminal HC_TERMINAL_SOCKET.
 */
export async function probeCoreIdentity(options = {}) {
  const env = copyEnv(options.env);
  const session = readSelector(env, "HC_SESSION");
  const socket = readSelector(env, "HC_SOCKET");
  if (!session && !socket) {
    throw new HcError(
      "probeCoreIdentity requires HC_SESSION or HC_SOCKET; refusing to select the default core",
      { kind: "selector_required" },
    );
  }
  const status = await callJson(["server", "status", "--json"], {
    hcBin: options.hcBin,
    timeoutMs: options.timeoutMs,
    env,
  });
  const core = status?.core;
  if (
    !core || typeof core.id !== "string" || !core.id ||
    typeof core.name !== "string" || !core.name ||
    typeof status?.version !== "string" || !status.version
  ) {
    throw new HcError("hc server status returned no usable core identity", { kind: "malformed_reply" });
  }
  return {
    id: core.id,
    name: core.name,
    version: status.version,
    session,
    socket,
  };
}

/** `<run hash>-<role><index>`, e.g. m7f3a2-w0. */
export function workerTerminalName(runId, role, index) {
  const run = String(runId ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!run) throw new HcError("workerTerminalName: runId must contain a letter or digit");
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new HcError("workerTerminalName: index must be a non-negative safe integer");
  }
  const fixed = { worker: "w", static: "w", burst: "b", flash: "b" };
  const roleKey = String(role ?? "").toLowerCase();
  const code = fixed[roleKey] ?? roleKey.replace(/[^a-z0-9]/g, "");
  if (!code) throw new HcError("workerTerminalName: role must contain a letter or digit");
  const indexText = String(index);
  // Do not truncate the role or the index. The runId may be shortened to fit;
  // if even a one-character runId cannot fit, the caller must shorten the role.
  const maxRun = 32 - 1 - code.length - indexText.length;
  if (maxRun < 1) {
    throw new HcError(`workerTerminalName: role/index does not fit in 32 chars (${code}${indexText})`);
  }
  const prefix = run.slice(0, Math.min(16, maxRun));
  const name = `${prefix}-${code}${indexText}`;
  if (!NAME_RE.test(name)) throw new HcError(`workerTerminalName: ${name} is not a valid hc name`);
  return name;
}

/** Parent equality only; fetch the record under a pinned core before using it. */
export function isOwnedTerminal(record, rootAddress) {
  return Boolean(record && typeof rootAddress === "string" && rootAddress && record.parent === rootAddress);
}

/** Run hc with argv only; bounded by timeout and output size. */
function runHc(args, { hcBin = "hc", timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(hcBin, args, { stdio: ["ignore", "pipe", "pipe"], env: copyEnv(env) });
    } catch (error) {
      reject(new HcError(`hc ${args[0]}: ${error.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const stop = (error) => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(reject, error);
    };
    timer = setTimeout(() => {
      const error = new HcError(`hc ${args[0]} timed out after ${timeoutMs}ms`);
      error.timedOut = true;
      stop(error);
    }, timeoutMs);
    const collect = (which) => (chunk) => {
      const text = chunk.toString();
      if (which === "stdout") stdout += text; else stderr += text;
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        stop(new HcError(`hc ${args[0]} wrote more than ${MAX_OUTPUT_BYTES} bytes`));
      }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => finish(reject, new HcError(`hc ${args[0]}: ${error.message}`)));
    child.on("close", (code) => finish(resolve, { code, stdout, stderr }));
  });
}

/** hc errors are `{error:{kind,message,hint}}` on stderr. */
function hcError(args, { code, stderr }) {
  let detail = null;
  try { detail = JSON.parse(stderr.trim()).error; } catch { /* plain stderr */ }
  const message = detail?.message || stderr.trim() || `exit code ${code}`;
  return new HcError(`hc ${args[0]}: ${message}`, {
    code: Number.isInteger(code) ? code : null,
    kind: detail?.kind ?? null,
    hint: detail?.hint ?? null,
  });
}

function isNotFound(error) {
  if (!(error instanceof HcError)) return false;
  if (error.kind) return error.kind === "not_found";
  return error.code === 3;
}

function isNameTaken(error) {
  if (!(error instanceof HcError)) return false;
  if (error.kind === "name_taken") return true;
  // hc names are deterministic; keep the guard even if an older CLI omits kind.
  return error.code === 1 && /name[_ -]?taken|name .*taken/i.test(error.message);
}

function assertAddress(address, label = "address") {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    throw new HcError(`${label} must be a core-local hc terminal address, got ${JSON.stringify(address)}`);
  }
}

function identityPairs(identity) {
  if (identity == null) return [];
  if (typeof identity !== "object" || Array.isArray(identity)) {
    throw new HcError("worker env must be an object of PI_MIND_WORKER_* strings");
  }
  const pairs = [];
  for (const [key, value] of Object.entries(identity)) {
    if (!IDENTITY_KEYS.has(key)) {
      throw new HcError(`refusing to pass ${key} to a worker: only PI_MIND_WORKER_* identity vars are allowed`);
    }
    if (typeof value !== "string" || value === "") {
      throw new HcError(`worker env ${key} must be a non-empty string`);
    }
    if (/[\0\n\r]/.test(value)) throw new HcError(`worker env ${key} must be one line`);
    pairs.push(`${key}=${value}`);
  }
  return pairs;
}

async function callJson(args, options) {
  const result = await runHc(args, options);
  if (result.code !== 0) throw hcError(args, result);
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    const error = new HcError(`hc ${args[0]} returned unreadable JSON: ${result.stdout.trim().slice(0, 200)}`);
    error.malformedReply = true;
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

async function verifyCore(expectedCoreId, clientEnv, { hcBin, timeoutMs } = {}) {
  if (expectedCoreId === undefined || expectedCoreId === null) return null;
  if (typeof expectedCoreId !== "string" || !expectedCoreId) {
    throw new HcError("expectedCoreId must be a non-empty string", { kind: "invalid_params" });
  }
  if (!hasCoreSelector(clientEnv)) {
    throw new HcError(
      "expectedCoreId requires HC_SESSION or HC_SOCKET; refusing to select the default core",
      { kind: "selector_required" },
    );
  }
  const core = await probeCoreIdentity({ env: clientEnv, hcBin, timeoutMs });
  if (core.id !== expectedCoreId) {
    throw new HcError(
      `hc core mismatch: expected ${expectedCoreId}, reached ${core.id}`,
      { kind: "core_mismatch" },
    );
  }
  return core;
}

function assertOwnedRecord(record, rootAddress, address) {
  assertAddress(rootAddress, "rootAddress");
  if (record && record.parent !== rootAddress) {
    throw new HcError(
      `terminal ${address} is not owned by ${rootAddress} (parent ${JSON.stringify(record.parent)})`,
      { kind: "not_owned" },
    );
  }
}

function assertTerminalRecord(record) {
  if (
    !record || typeof record !== "object" || Array.isArray(record) ||
    typeof record.address !== "string" || !ADDRESS_RE.test(record.address) ||
    (record.state !== "live" && record.state !== "finished")
  ) {
    const error = new HcError(
      `hc returned a malformed terminal record (state=${JSON.stringify(record?.state)} address=${JSON.stringify(record?.address)})`,
      { kind: "malformed_reply" },
    );
    error.malformedReply = true;
    throw error;
  }
}

async function getTerminalOnce(address, { env, hcBin, timeoutMs }) {
  try {
    const record = await callJson(["get", address, "--json"], { hcBin, timeoutMs, env });
    assertTerminalRecord(record);
    return record;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** One terminal record, or null when hc does not know the address. */
export async function getTerminal(address, options = {}) {
  assertAddress(address);
  if (options.rootAddress !== undefined) assertAddress(options.rootAddress, "rootAddress");
  const env = copyEnv(options.env);
  const { hcBin, timeoutMs, expectedCoreId } = options;
  await verifyCore(expectedCoreId, env, { hcBin, timeoutMs });
  const record = await getTerminalOnce(address, { env, hcBin, timeoutMs });
  if (record && options.rootAddress !== undefined) {
    assertOwnedRecord(record, options.rootAddress, address);
  }
  return record;
}

async function listTerminals({ env, hcBin, timeoutMs }) {
  const reply = await callJson(["ls", "--all", "--json"], { hcBin, timeoutMs, env });
  if (!Array.isArray(reply?.terminals)) {
    const error = new HcError("hc ls returned no terminals array", { kind: "malformed_reply" });
    error.malformedReply = true;
    throw error;
  }
  for (const record of reply.terminals) assertTerminalRecord(record);
  return reply.terminals;
}

function spawnPendingError(baseError, { name, rootAddress }, cause = null) {
  const error = new HcError(
    `${baseError.message} (spawn may have left terminal ${name} under ${rootAddress}; kept for retirement)`,
    {
      code: baseError.code ?? null,
      kind: baseError.kind || "spawn_pending",
      hint: baseError.hint ?? null,
      spawnPending: true,
      terminalName: name,
      rootAddress,
    },
  );
  if (cause) error.cause = cause;
  return error;
}

/**
 * A spawn timed out or returned a malformed reply after hc may already have
 * created the terminal. Reconcile by the unique name under the pinned core and
 * root, and kill only a record whose parent proves root ownership.
 */
async function reconcileSpawnFailure(baseError, { name, rootAddress, clientEnv, expectedCoreId, hcBin, timeoutMs }) {
  try {
    await verifyCore(expectedCoreId, clientEnv, { hcBin, timeoutMs });
  } catch (error) {
    throw spawnPendingError(baseError, { name, rootAddress }, error);
  }
  let terminals;
  try {
    terminals = await listTerminals({ env: clientEnv, hcBin, timeoutMs });
  } catch (error) {
    throw spawnPendingError(baseError, { name, rootAddress }, error);
  }
  const named = terminals.filter((record) => record && record.name === name);
  const owned = named.filter((record) => record.parent === rootAddress);
  if (owned.length === 0) {
    // A single list snapshot cannot prove an in-flight server request will not
    // create the terminal afterwards. Keep the name pending for both cases:
    // a same-name record without the proven parent, and no record yet.
    const cause = named.length > 0
      ? new HcError(`terminal name ${name} exists without the proven root parent`, { kind: "not_owned" })
      : null;
    throw spawnPendingError(baseError, { name, rootAddress }, cause);
  }
  if (owned.length > 1) {
    throw spawnPendingError(baseError, { name, rootAddress }, new HcError(
      `multiple terminals named ${name} under ${rootAddress}`,
      { kind: "ambiguous_spawn" },
    ));
  }
  const record = owned[0];
  if (record.state === "finished") throw baseError;
  try {
    assertAddress(record.address);
    await retireWorkerTerminal(record.address, {
      env: clientEnv,
      hcBin,
      timeoutMs,
      expectedCoreId,
      rootAddress,
    });
  } catch (error) {
    throw spawnPendingError(baseError, { name, rootAddress }, error);
  }
  throw baseError;
}

/** Start one worker as a direct hc child of the root; returns its address. */
export async function spawnWorkerTerminal(options = {}) {
  const {
    rootAddress,
    name,
    cwd,
    argv,
    env: identity,
    hcBin,
    timeoutMs,
    clientEnv,
    expectedCoreId,
  } = options;
  assertAddress(rootAddress, "rootAddress");
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new HcError(`worker name must be 1-32 of a-z 0-9 - _ . starting alphanumeric, got ${JSON.stringify(name)}`);
  }
  if (typeof cwd !== "string" || !cwd.startsWith("/")) {
    throw new HcError(`worker cwd must be an absolute path, got ${JSON.stringify(cwd)}`);
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) {
    throw new HcError("worker argv must be a non-empty array of strings");
  }
  if (!argv[0].startsWith("/")) {
    throw new HcError(`worker argv[0] must be an absolute program path, got ${JSON.stringify(argv[0])}`);
  }
  const pinnedEnv = copyEnv(clientEnv);
  const args = [
    "run", "--bg", "--json", "--no-notify", "--rm",
    "--parent", rootAddress,
    "--name", name,
    "--cwd", cwd,
    "--", ENV_BIN, ...identityPairs(identity), ...argv,
  ];
  // A finished/gone parent still accepts an hc child, so prove the root is a
  // live parentless terminal right before the run. Do not compare pid here:
  // Mind is a child of this terminal, not the root program.
  const root = await getTerminal(rootAddress, {
    env: pinnedEnv,
    expectedCoreId,
    hcBin,
    timeoutMs,
  });
  if (!root) {
    throw new HcError(`root terminal ${rootAddress} is gone; refusing to spawn`, { kind: "root_not_live" });
  }
  if (root.state !== "live") {
    throw new HcError(
      `root terminal ${rootAddress} is ${root.state}; refusing to spawn under a non-live root`,
      { kind: "root_not_live" },
    );
  }
  if (root.parent !== null) {
    throw new HcError(
      `root terminal ${rootAddress} has parent ${JSON.stringify(root.parent)}; refusing to spawn under a non-parentless root`,
      { kind: "root_not_parentless" },
    );
  }
  let record;
  try {
    record = await callJson(args, { hcBin, timeoutMs, env: pinnedEnv });
  } catch (error) {
    // Deterministic failures did not create a terminal. Name collisions must
    // never cause us to probe or kill the existing terminal.
    if (isNameTaken(error)) throw error;
    if (error instanceof HcError && (error.timedOut || error.malformedReply)) {
      return reconcileSpawnFailure(error, {
        name, rootAddress, clientEnv: pinnedEnv, expectedCoreId, hcBin, timeoutMs,
      });
    }
    throw error;
  }
  if (expectedCoreId) {
    try {
      await verifyCore(expectedCoreId, pinnedEnv, { hcBin, timeoutMs });
    } catch (error) {
      throw spawnPendingError(error, { name, rootAddress });
    }
  }
  const address = record?.address;
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    const error = new HcError(
      `hc run returned no usable address (got ${JSON.stringify(Object.keys(record ?? {}))})`,
      { kind: "malformed_reply" },
    );
    error.malformedReply = true;
    return reconcileSpawnFailure(error, {
      name, rootAddress, clientEnv: pinnedEnv, expectedCoreId, hcBin, timeoutMs,
    });
  }
  if (record.state === "finished") {
    // A pending success can describe a terminal that is already gone. Never
    // retry and never kill an address that no longer has a live program.
    throw new HcError(`hc run returned ${address}, which is already finished`, { kind: "not_found" });
  }
  let parent = record.parent;
  if (parent === undefined) {
    // A compact run reply omits parent when it is null. Fetch the full record
    // before claiming ownership; a missing parent is not proof of ownership.
    let fetched;
    try {
      fetched = await getTerminalOnce(address, {
        env: pinnedEnv, hcBin, timeoutMs,
      });
    } catch (error) {
      if (error instanceof HcError && isNotFound(error)) throw error;
      return reconcileSpawnFailure(error, {
        name, rootAddress, clientEnv: pinnedEnv, expectedCoreId, hcBin, timeoutMs,
      });
    }
    if (!fetched || fetched.state === "finished") {
      if (expectedCoreId) {
        try {
          await verifyCore(expectedCoreId, pinnedEnv, { hcBin, timeoutMs });
        } catch (error) {
          throw spawnPendingError(error, { name, rootAddress });
        }
      }
      throw new HcError(`hc run returned ${address}, which is already gone`, { kind: "not_found" });
    }
    parent = fetched.parent;
  }
  if (parent !== rootAddress) {
    // Never kill a wrong-parent terminal: it is not proven ours.
    throw new HcError(
      `hc run put ${address} under ${JSON.stringify(parent)}, not ${rootAddress}`,
      { kind: "wrong_parent" },
    );
  }
  return { address, coreId: expectedCoreId ?? null };
}

async function confirmGone(address, {
  env,
  hcBin,
  timeoutMs,
  expectedCoreId,
  goneTimeoutMs,
  pollMs,
}) {
  const deadline = Date.now() + goneTimeoutMs;
  let last = null;
  while (true) {
    const record = await getTerminalOnce(address, { env, hcBin, timeoutMs });
    if (!record || record.state === "finished") {
      // A core restart between kill and confirmation must not turn a missing
      // address on the new core into success.
      if (expectedCoreId) await verifyCore(expectedCoreId, env, { hcBin, timeoutMs });
      return;
    }
    last = record;
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  throw new HcError(
    `hc kill ${address}: terminal still ${last?.state || "present"} after ${goneTimeoutMs}ms`,
    { kind: "retire_timeout" },
  );
}

/**
 * End one worker terminal. not_found means --rm removed it; that is normal on
 * the first kill as well as later. Always confirm with bounded hc get polling.
 */
export async function retireWorkerTerminal(address, options = {}) {
  assertAddress(address);
  const env = copyEnv(options.env);
  const { hcBin, timeoutMs, expectedCoreId, rootAddress } = options;
  const goneTimeoutMs = Number.isFinite(options.goneTimeoutMs)
    ? Math.max(1, options.goneTimeoutMs) : DEFAULT_GONE_TIMEOUT_MS;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(1, options.pollMs) : DEFAULT_POLL_MS;
  if (rootAddress !== undefined) assertAddress(rootAddress, "rootAddress");
  await verifyCore(expectedCoreId, env, { hcBin, timeoutMs });
  if (rootAddress !== undefined) {
    const before = await getTerminalOnce(address, { env, hcBin, timeoutMs });
    if (!before) {
      if (expectedCoreId) await verifyCore(expectedCoreId, env, { hcBin, timeoutMs });
      return { retired: true };
    }
    // Ownership proof comes before "already finished": a wrong-parent record
    // is never ours, even if it has finished.
    assertOwnedRecord(before, rootAddress, address);
    if (before.state === "finished") {
      if (expectedCoreId) await verifyCore(expectedCoreId, env, { hcBin, timeoutMs });
      return { retired: true };
    }
  }
  // The kill is the addressed operation that matters most: re-prove the core
  // after the ownership read and immediately before sending it.
  if (expectedCoreId) await verifyCore(expectedCoreId, env, { hcBin, timeoutMs });
  try {
    await callJson(["kill", address, "--json"], { hcBin, timeoutMs, env });
  } catch (error) {
    // With --rm the first successful kill is reported as not_found
    // ("<addr> was removed"), exit 3. Any other failure leaves state tracked.
    if (!isNotFound(error)) throw error;
  }
  await confirmGone(address, {
    env, hcBin, timeoutMs, expectedCoreId, goneTimeoutMs, pollMs,
  });
  return { retired: true };
}
