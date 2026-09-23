import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WORKER_NAME = "worker";

function requestedWorker(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("worker" in input)) {
    return undefined;
  }
  return (input as { worker?: unknown }).worker;
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      `${event.systemPrompt}\n\n` +
      "## Worker policy\n" +
      "Use only the user-defined `worker` from `~/.pi/agent/pi-orchestrate/workers/worker.md`. " +
      "Do not dispatch any fallback or other worker definitions.",
  }));

  pi.on("tool_call", (event) => {
    if (event.toolName !== "orchestrate") return;

    const worker = requestedWorker(event.input);
    if (worker === WORKER_NAME) return;

    return {
      block: true,
      reason: "Only the user-defined `worker` may be dispatched.",
    };
  });
}
