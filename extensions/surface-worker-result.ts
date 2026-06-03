/**
 * Surface Worker Result
 *
 * Auto-injects subagent final outputs into the parent session
 * as user messages, so the main LLM sees worker results without
 * manual copy/paste.
 *
 * Hooks tool_result for "subagent" tool, extracts
 * text content, and queues it as a followUp user message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WORKER_TOOLS = new Set(["subagent"]);

interface BufferedResult {
  toolName: string;
  text: string;
}

const resultBuffer: BufferedResult[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, _ctx) => {
    // Only intercept subagent tool results
    if (!WORKER_TOOLS.has(event.toolName)) {
      return;
    }

    // Skip error results — let the main agent handle failures
    // through normal tool error reporting
    if (event.isError) {
      return;
    }

    // Extract text content from the result
    const textParts = (event.content ?? [])
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text);

    if (textParts.length === 0) {
      return;
    }

    const resultText = textParts.join("\n\n").trim();
    if (!resultText) {
      return;
    }

    // Truncate extremely long results to avoid bloating context
    const MAX_LENGTH = 16_000;
    const displayText =
      resultText.length > MAX_LENGTH
        ? resultText.slice(0, MAX_LENGTH) +
          `\n\n... (result truncated from ${resultText.length} to ${MAX_LENGTH} chars)`
        : resultText;

    // Buffer result and flush batched followUp on next tick.
    // Parallel completions in the same macrotask batch merge into
    // one followUp instead of N separate messages.
    resultBuffer.push({ toolName: event.toolName, text: displayText });
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const batch = resultBuffer.splice(0, resultBuffer.length);
        if (batch.length === 0) return;
        const combined = batch
          .map(r => `[Worker result from \`${r.toolName}\`]:\n\n${r.text}`)
          .join("\n\n---\n\n");
        pi.sendUserMessage(combined, { deliverAs: "followUp" });
      }, 0);
    }
  });
}
