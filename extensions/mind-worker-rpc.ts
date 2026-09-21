// @ts-nocheck

import { Type } from "typebox";
import { WorkerManager } from "../lib/mind-worker-rpc/worker-manager.mjs";

const TaskParams = Type.Object({
  task: Type.String({ description: "The repository task for the worker" }),
  cwd: Type.Optional(Type.String({ description: "Repository working directory" })),
});

const ContinueParams = Type.Object({
  task_id: Type.String({ description: "Worker task ID" }),
  instruction: Type.String({ description: "The next instruction for the same worker session" }),
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
  const manager = new WorkerManager({
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

  pi.on("session_shutdown", async () => {
    await manager.close();
  });

  pi.registerTool({
    name: "worker_explore",
    label: "Worker explore",
    description: "Start an asynchronous read-only repository exploration in a separate Pi RPC worker.",
    parameters: TaskParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const task = await manager.createExploreTask(params.task, params.cwd || ctx.cwd);
        const message = `Explore only. Do not modify files.\n\nTask:\n${params.task}`;
        return textResult(`Started worker task ${task.id}.\n\nWorker message:\n${message}`, { taskId: task.id, status: task.status, message });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "worker_execute",
    label: "Worker execute",
    description: "Start an asynchronous implementation task in a separate Pi RPC worker.",
    parameters: TaskParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const task = await manager.createExecuteTask(params.task, params.cwd || ctx.cwd);
        const message = `Implement the requested change and run relevant tests.\n\nTask:\n${params.task}`;
        return textResult(`Started worker task ${task.id}.\n\nWorker message:\n${message}`, { taskId: task.id, status: task.status, message });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "worker_continue",
    label: "Worker continue",
    description: "Send a follow-up instruction to the same worker task and preserve its context.",
    parameters: ContinueParams,
    async execute(_id, params) {
      try {
        const task = await manager.continueTask(params.task_id, params.instruction);
        return textResult(`Continued worker task ${task.id}.`, { taskId: task.id, status: task.status });
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
