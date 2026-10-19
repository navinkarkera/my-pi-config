/**
 * Parse a Git command line into an argv array without a shell.
 * Any subcommand is accepted; execFile keeps shell metacharacters literal.
 * Quoting is POSIX-like: single quotes are fully literal; inside double quotes a backslash
 * only escapes $ ` " \\ and a backslash-newline is a line continuation (removed).
 * Returns null for malformed input (non-string, empty, unmatched quote, trailing escape)
 * and for a first token beginning with "-", which would be a Git global option.
 */
const ESCAPABLE_IN_DOUBLE_QUOTES = new Set(['$', '`', '"', '\\']);

export function parseGitArgs(command) {
  if (typeof command !== "string" || command.trim() === "") return null;

  const args = [];
  let current = "";
  let started = false;
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      // Inside single quotes everything is literal, including backslashes.
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\") {
        const next = command[i + 1];
        if (next === "\n") {
          i++; // POSIX line continuation: backslash-newline is removed.
          continue;
        }
        if (next !== undefined && ESCAPABLE_IN_DOUBLE_QUOTES.has(next)) {
          current += next;
          i++;
        } else current += char;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = command[i + 1];
      if (next === undefined) return null; // trailing escape
      if (next === "\n") {
        i++; // POSIX line continuation: backslash-newline is removed.
        continue;
      }
      current += next;
      i++;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote) return null;
  if (started) args.push(current);
  if (args.length === 0 || args[0].startsWith("-")) return null;
  return args;
}
