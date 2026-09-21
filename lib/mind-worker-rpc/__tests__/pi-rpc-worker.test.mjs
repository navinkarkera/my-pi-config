import assert from "node:assert/strict";
import test from "node:test";
import { JsonlDecoder, extractAssistantText } from "../pi-rpc-worker.mjs";

test("JSONL decoder only splits on LF and handles split UTF-8 chunks", () => {
  const decoder = new JsonlDecoder();
  const values = [];
  const input = Buffer.from(`${JSON.stringify({ type: "message", text: "line value" })}\n${JSON.stringify({ type: "done" })}\n`);
  decoder.push(input.subarray(0, 7), (value) => values.push(value));
  decoder.push(input.subarray(7), (value) => values.push(value));
  assert.deepEqual(values, [
    { type: "message", text: "line value" },
    { type: "done" },
  ]);
});

test("assistant text extraction ignores thinking and tool calls", () => {
  assert.equal(
    extractAssistantText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "summary" },
        { type: "toolCall", name: "bash" },
      ],
    }),
    "summary",
  );
});
