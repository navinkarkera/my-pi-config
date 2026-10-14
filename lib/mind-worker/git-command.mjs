const READ_ONLY_COMMANDS = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "ls-files",
  "blame", "grep", "name-rev", "remote", "tag",
]);

const LIST_ONLY_ARGS = {
  branch: new Set(["--list", "-l"]),
  remote: new Set(["-v", "--verbose"]),
  tag: new Set(["--list", "-l"]),
};

export function parseSafeGitArgs(command) {
  if (typeof command !== "string" || !command.trim() || /[;&|><`$\r\n]/.test(command)) return null;

  // shortcut: Git arguments are whitespace-split; use an argv schema if paths with spaces need support.
  const args = command.trim().split(/\s+/);
  const [subcommand, ...options] = args;
  if (!READ_ONLY_COMMANDS.has(subcommand)) return null;
  if (options.some(arg =>
    arg === "-o" ||
    /^--output(?:=|$)/.test(arg) ||
    /^--open-files-in-pager(?:=|$)/.test(arg) ||
    arg === "--ext-diff" ||
    arg === "--textconv"
  )) return null;

  const listArgs = LIST_ONLY_ARGS[subcommand];
  if (listArgs && options.length > 0 && !(options.length === 1 && listArgs.has(options[0]))) return null;

  return args;
}
