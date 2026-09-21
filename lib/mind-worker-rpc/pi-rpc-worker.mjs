import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";

export const DEFAULT_WORKER_PROMPT = `You are an implementation worker controlled by another Pi agent called the mind.

Investigate the repository, implement the requested change, run relevant tests, debug failures, and report concise results. The mind owns architecture and final review.

Rules:
1. Follow the current task precisely and do not broaden scope.
2. If the task says explore only, do not edit files.
3. Prefer reading the repository over guessing.
4. Preserve unrelated user changes; never use destructive git commands.
5. Run relevant tests after implementation when practical.
6. End with what you found or changed, important design details, changed files, tests and results, unresolved issues, and questions for the mind.

Code exploration policy:
Use the cymbal CLI for code navigation, preferring it over Read, Grep, Glob, or Bash for code exploration.
- New repo: start with 'cymbal structure'.
- Understand a symbol: use 'cymbal context <symbol>' or 'cymbal investigate <symbol>'.
- Understand multiple symbols: use 'cymbal investigate Foo Bar Baz'.
- Trace execution: use 'cymbal trace <symbol>'.
- Assess risk: use 'cymbal changed', 'cymbal changed --base main', or 'cymbal impact <symbol>'.
- Review a symbol diff: use 'cymbal diff <symbol> [base]'.
- Before reading a file: use 'cymbal outline <file>' or 'cymbal show <file:L1-L2>'.
- Before searching: use 'cymbal search <query>' or 'cymbal search <query> --text'.
- Before exploring structure: use 'cymbal ls' or 'cymbal ls --stats'.
- Find usage with 'cymbal refs <symbol>' or 'cymbal importers <file>'.
- Use 'cymbal show <symbol>' for specific functions and types.
- The index auto-builds and refreshes incrementally.`;

export function extractAssistantText(message) {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** Strict LF-delimited JSONL decoder. U+2028/U+2029 remain valid JSON content. */
export class JsonlDecoder {
  #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk, onValue) {
    this.#buffer += this.#decoder.write(chunk);
    this.#drain(onValue);
  }

  end(onValue) {
    this.#buffer += this.#decoder.end();
    if (this.#buffer) {
      this.#emit(this.#buffer, onValue);
      this.#buffer = "";
    }
  }

  #drain(onValue) {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#emit(line, onValue);
    }
  }

  #emit(line, onValue) {
    if (!line) return;
    onValue(JSON.parse(line));
  }
}

export class PiRpcWorker extends EventEmitter {
  #process;
  #decoder = new JsonlDecoder();
  #pending = new Map();
  #nextId = 0;
  #startPromise;
  #stopping = false;
  #stderr = "";

  constructor({ cwd, command = "pi", model, systemPrompt = DEFAULT_WORKER_PROMPT, env } = {}) {
    super();
    this.cwd = cwd;
    this.command = command;
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.env = env;
  }

  get stderr() {
    return this.#stderr;
  }

  get alive() {
    return !!this.#process && !this.#process.killed && this.#process.exitCode === null;
  }

  async start() {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = new Promise((resolve, reject) => {
      const args = ["--mode", "rpc", "--no-session", "--no-extensions"];
      if (this.model) args.push("--model", this.model);
      if (this.systemPrompt) args.push("--append-system-prompt", this.systemPrompt);

      const child = spawn(this.command, args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#process = child;

      let spawned = false;
      child.on("error", (error) => {
        this.#rejectPending(error);
        this.emit("process_error", error);
        if (!spawned) reject(error);
      });
      child.once("spawn", () => {
        spawned = true;
        resolve();
        this.emit("started");
      });
      child.stdout.on("data", (chunk) => {
        try {
          this.#decoder.push(chunk, (value) => this.#handle(value));
        } catch (error) {
          this.emit("protocol_error", error);
          this.#rejectPending(error);
        }
      });
      child.stdout.on("end", () => {
        try {
          this.#decoder.end((value) => this.#handle(value));
        } catch (error) {
          this.emit("protocol_error", error);
        }
      });
      child.stderr.on("data", (chunk) => {
        this.#stderr = `${this.#stderr}${chunk}`.slice(-8_000);
      });
      child.once("exit", (code, signal) => {
        const error = new Error(`Pi worker exited${code === null ? ` by ${signal}` : ` with code ${code}`}`);
        this.#rejectPending(error);
        this.emit("exit", { code, signal, intentional: this.#stopping, error });
      });
    });
    return this.#startPromise;
  }

  async send(type, fields = {}) {
    await this.start();
    if (!this.alive) throw new Error("Pi worker is not running");
    const id = `rpc-${++this.#nextId}`;
    const command = { id, type, ...fields };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#process.stdin.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  prompt(message) {
    return this.send("prompt", { message });
  }

  followUp(message) {
    return this.send("follow_up", { message });
  }

  steer(message) {
    return this.send("steer", { message });
  }

  abort() {
    return this.send("abort");
  }

  getState() {
    return this.send("get_state");
  }

  getSessionStats() {
    return this.send("get_session_stats");
  }

  compact(customInstructions) {
    return this.send("compact", customInstructions ? { customInstructions } : {});
  }

  async stop() {
    if (!this.#process || this.#process.exitCode !== null) return;
    this.#stopping = true;
    this.#process.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#process?.kill("SIGTERM");
        resolve();
      }, 1_000);
      this.#process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #handle(value) {
    if (value?.type === "response" && value.id) {
      const pending = this.#pending.get(value.id);
      if (!pending) return;
      this.#pending.delete(value.id);
      if (value.success === false) {
        pending.reject(new Error(value.error || `RPC command ${value.command} failed`));
      } else {
        pending.resolve(value);
      }
      return;
    }
    this.emit("event", value);
  }

  #rejectPending(error) {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}
