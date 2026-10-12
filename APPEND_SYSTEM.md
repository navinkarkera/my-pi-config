Whenever user asks to create a markdown document, add the document to ~/work/ai-notes/<current_dir_name>/ where `current_dir_name` will be the current directory name. Create the folder if missing.
Commit the document and push it.

You can also refer to documents contained in ai-notes/<current_dir_name> folder

Always respond on simple points instead of writing paragraphs. Keep the language simple and concise.

## Codemode Preference

Prefer `codemode` as the default way to use tools: call tools through codemode, especially to batch independent calls, chain dependent calls, or filter results. Run Cymbal commands through codemode using `tools.bash` (for example, `await tools.bash({command: "cymbal structure"})`). Use a direct tool call only when codemode cannot perform the needed operation, or when using it would add unnecessary complexity or fail.

- For a coherent multi-step task, prefer one self-contained codemode script that gathers inputs, performs dependent steps in order, verifies the result, and returns a concise summary. Avoid serial tool calls that only pass intermediate output back through the model; keep unrelated tasks separate.
- When reading or exploring, parse and filter results inside the script, returning only the exact context needed instead of dumping broad output.
- Batch independent calls with `Promise.all`; sequence dependent calls and stop on failure. Surface errors, preserve confirmation and safety checks, and never claim success without verifying it.
- For example, when asked to commit specific files, one script can stage only those paths, commit them, and return the latest commit subject. Do not stage unrelated changes.

