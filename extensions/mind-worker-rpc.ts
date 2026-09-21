// @ts-nocheck

import { Type } from "typebox";
import { WorkerManager } from "../lib/mind-worker-rpc/worker-manager.mjs";

const TaskParams = Type.Object({
  task: Type.String({ description: "The repository task for the worker" }),
  cwd: Type.Optional(Type.String({ description: "Repository working directory" })),
});

const TaskIdParams = Type.Object({
  task_id: Type.String({ description: "Worker task ID" }),
});

function textResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function errorResult(error) {
  return textResult(`Worker error: ${error instanceof Error ? error.message : String(error)}`, { error: true });
}

function formatContext(contextUsage) {
  if (!contextUsage) return "unknown";
  return contextUsage.percent == null ? "unknown" : `${contextUsage.percent}%`;
}

export default function mindWorkerRpc(pi) {
  let ui;

  function updateWorkerStatus(task) {
    if (!ui) return;
    const done = task.status === "completed" || task.status === "waiting";
    const color = task.status === "failed" ? "error" : task.status === "aborted" ? "warning" : done ? "success" : "accent";
    const icon = task.status === "failed" ? "✗" : task.status === "aborted" ? "!" : done ? "✓" : "●";
    ui.setStatus("mind-worker", ui.theme.fg(color, `${icon} ${task.id}: ${task.status}`));
  }

  const manager = new WorkerManager({
    onStatus: updateWorkerStatus,
    onComplete(task, result) {
      const summary = result.summary.length > 8_000 ? `${result.summary.slice(0, 8_000)}\n[summary truncated]` : result.summary;
      pi.sendMessage(
        {
          customType: "worker-result",
          content: `Worker task ${task.id} ${task.status}.\n\n${summary}\n\nUse worker_result with task_id '${task.id}' for the stored result.`,
          display: true,
          details: { taskId: task.id, status: task.status, result },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.mode === "tui" ? ctx.ui : undefined;
  });

  pi.on("session_shutdown", async () => {
    ui?.setStatus("mind-worker", undefined);
    ui = undefined;
    await manager.close();
  });

  pi.registerTool({
    name: "worker",
    label: "Worker",
    description: "Give the worker a task, reusing its existing session when possible.",
    parameters: TaskParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const task = await manager.run(params.task, params.cwd || ctx.cwd);
        const action = task.reused ? "Reused" : "Started";
        return textResult(`${action} worker task ${task.id}.`, { taskId: task.id, status: task.status });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "worker_stop",
    label: "Stop worker",
    description: "Stop the current worker process.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const task = await manager.stop();
        return textResult(task ? `Stopped worker task ${task.id}.` : "No worker is running.", task || {});
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "worker_restart",
    label: "Restart worker",
    description: "Restart the worker process, optionally with a new task.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "Optional task; defaults to the previous task" })),
      cwd: Type.Optional(Type.String({ description: "Optional repository working directory" })),
    }),
    async execute(_id, params) {
      try {
        const task = await manager.restart(params.task, params.cwd);
        return textResult(`Restarted worker task ${task.id}.`, { taskId: task.id, status: task.status });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "worker_status",
    label: "Worker status",
    description: "Get compact status and context usage for a worker task.",
    parameters: TaskIdParams,
    async execute(_id, params) {
      try {
        const task = await manager.status(params.task_id);
        const lines = [
          `task: ${task.id}`,
          `status: ${task.status}`,
          `context: ${formatContext(task.contextUsage)}`,
        ];
        if (task.lastAssistantText) lines.push(`last activity: ${task.lastAssistantText.slice(0, 500)}`);
        if (task.error) lines.push(`error: ${task.error}`);
        return textResult(lines.join("\n"), task);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "worker_result",
    label: "Worker result",
    description: "Read the completed worker summary without dumping its raw RPC event stream.",
    parameters: TaskIdParams,
    async execute(_id, params) {
      try {
        const task = manager.getTask(params.task_id);
        if (!task.result) return textResult(`Task ${task.id} is still ${task.status}.`, { taskId: task.id, status: task.status });
        return textResult(task.result.summary, { taskId: task.id, ...task.result });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "worker_abort",
    label: "Worker abort",
    description: "Abort an active worker task and stop its RPC process.",
    parameters: TaskIdParams,
    async execute(_id, params) {
      try {
        const task = await manager.abort(params.task_id);
        return textResult(`Aborted worker task ${task.id}.`, { taskId: task.id, status: task.status });
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
