import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const promptPath = join(homedir(), ".pi", "agent", "REPL_APPEND_SYSTEM.md");

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (pi.getFlag("repl") !== true) return;
		try {
			const prompt = readFileSync(promptPath, "utf8").trim();
			if (!prompt) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
		} catch {
			return;
		}
	});
}
