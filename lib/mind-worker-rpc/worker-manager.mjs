import { PiRpcWorker, extractAssistantText } from "./pi-rpc-worker.mjs";

const TERMINAL = new Set(["failed", "aborted"]);

export class WorkerManager {
  #tasks = new Map();
  #current;
  #sequence = 0;
  #workerOptions;
  #onComplete;

  constructor({ workerCommand = process.env.PI_WORKER_COMMAND || "pi", workerModel = process.env.PI_WORKER_MODEL || "openai-codex/gpt-5.6-luna:high", onComplete } = {}) {
    this.#workerOptions = { command: workerCommand, model: workerModel };
    this.#onComplete = onComplete;
  }

  async createExploreTask(objective, cwd = process.cwd()) {
    return this.#create("explore", objective, cwd);
  }

  async createExecuteTask(objective, cwd = process.cwd()) {
    return this.#create("execute", objective, cwd);
  }

  getTask(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`Unknown worker task: ${taskId}`);
    return task;
  }

  async continueTask(taskId, instruction) {
    const task = this.getTask(taskId);
    if (TERMINAL.has(task.status)) throw new Error(`Cannot continue ${task.status} task ${taskId}`);
    if (!task.worker?.alive) throw new Error(`Worker for ${taskId} is not running`);
    task.status = "running";
    task.updatedAt = Date.now();
    await task.worker.followUp(instruction);
    return task;
  }

  async steer(taskId, instruction) {
    const task = this.getTask(taskId);
    if (task.status !== "running") throw new Error(`Task ${taskId} is not running`);
    await task.worker.steer(instruction);
    task.updatedAt = Date.now();
    return task;
  }

  async status(taskId) {
    const task = this.getTask(taskId);
    if (task.worker?.alive) {
      try {
        const response = await task.worker.getSessionStats();
        task.contextUsage = response.data?.contextUsage;
      } catch {
        // A status poll should not turn a healthy task into a failed task.
      }
    }
    return this.#publicTask(task);
  }

  result(taskId) {
    const task = this.getTask(taskId);
    return task.result;
  }

  async abort(taskId) {
    const task = this.getTask(taskId);
    if (TERMINAL.has(task.status)) return task;
    try {
      if (task.worker?.alive) await task.worker.abort();
    } finally {
      task.status = "aborted";
      task.updatedAt = Date.now();
      await task.worker?.stop();
      if (this.#current === task) this.#current = undefined;
    }
    return task;
  }

  async close() {
    if (this.#current?.worker) await this.#current.worker.stop();
    this.#current = undefined;
  }

  async #create(kind, objective, cwd) {
    if (!objective?.trim()) throw new Error("Worker task must not be empty");
    if (this.#current && !TERMINAL.has(this.#current.status)) {
      throw new Error(`Worker task ${this.#current.id} is still active; continue or abort it first`);
    }
    if (this.#current?.worker) await this.#current.worker.stop();

    const task = {
      id: `worker-${String(++this.#sequence).padStart(3, "0")}`,
      kind,
      status: "starting",
      sessionId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      objective,
      cwd,
      contextUsage: undefined,
      lastAssistantText: "",
      result: undefined,
      error: undefined,
      worker: undefined,
    };
    const worker = new PiRpcWorker({ ...this.#workerOptions, cwd });
    task.worker = worker;
    this.#current = task;
    this.#tasks.set(task.id, task);
    this.#wire(task);

    try {
      await worker.start();
      try {
        const state = await worker.getState();
        task.sessionId = state.data?.sessionId;
      } catch {
        // Session metadata is best-effort; the worker can still execute the task.
      }
      const mode = kind === "explore"
        ? "Explore only. Do not modify files."
        : "Implement the requested change and run relevant tests.";
      await worker.prompt(`${mode}\n\nTask:\n${objective}`);
      task.status = "running";
      task.updatedAt = Date.now();
    } catch (error) {
      this.#fail(task, error);
      throw error;
    }
    return this.#publicTask(task);
  }

  #wire(task) {
    const worker = task.worker;
    worker.on("event", (event) => {
      task.updatedAt = Date.now();
      if (event.type === "agent_start" || event.type === "tool_execution_start") {
        task.status = "running";
      } else if (event.type === "message_end") {
        const text = extractAssistantText(event.message);
        if (text) task.lastAssistantText = text;
      } else if (event.type === "agent_settled") {
        task.status = task.kind === "explore" ? "waiting" : "completed";
        task.result = this.#makeResult(task);
        this.#onComplete?.(this.#publicTask(task), task.result);
      } else if (event.type === "extension_error") {
        this.#fail(task, new Error(event.error || "Worker extension error"));
      }
    });
    worker.on("exit", ({ intentional, error }) => {
      if (!intentional && !TERMINAL.has(task.status) && task.status !== "completed" && task.status !== "waiting") {
        this.#fail(task, error);
      }
    });
    worker.on("protocol_error", (error) => this.#fail(task, error));
    worker.on("process_error", (error) => this.#fail(task, error));
  }

  #makeResult(task) {
    return {
      summary: task.lastAssistantText || "Worker finished without an assistant summary.",
      changedFiles: [],
      tests: [],
      unresolved: [],
    };
  }

  #fail(task, error) {
    task.status = "failed";
    task.error = error instanceof Error ? error.message : String(error);
    task.updatedAt = Date.now();
    task.result = this.#makeResult(task);
  }

  #publicTask(task) {
    return {
      id: task.id,
      kind: task.kind,
      status: task.status,
      sessionId: task.sessionId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      objective: task.objective,
      cwd: task.cwd,
      contextUsage: task.contextUsage,
      lastAssistantText: task.lastAssistantText,
      error: task.error,
    };
  }
}
