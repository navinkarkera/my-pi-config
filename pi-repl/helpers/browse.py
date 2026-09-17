helper_description = """browse — file/code navigation and git wrappers.
Use browse.read_file(...), browse.search_text(...), browse.find_files(...), browse.cymbal(...), and browse.git(...).
Instead of: subprocess.run(...) for routine repository inspection."""

from pathlib import Path as _Path
import subprocess as _subprocess


def _run(command, *, no_matches=False):
    result = _subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if no_matches and result.returncode == 1:
        return ""
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"{command[0]} failed ({result.returncode}): {detail}")
    return result.stdout


def read_file(path, start_line=None, end_line=None):
    """Return exact UTF-8 text, optionally restricted to a 1-based inclusive line range."""
    for name, value in (("start_line", start_line), ("end_line", end_line)):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 1):
            raise ValueError(f"{name} must be a positive integer")
    if start_line is not None and end_line is not None and start_line > end_line:
        raise ValueError("start_line must not exceed end_line")

    with _Path(path).open("r", encoding="utf-8", newline="") as file:
        text = file.read()
    if start_line is None and end_line is None:
        return text

    lines = text.splitlines(keepends=True)
    start = start_line or 1
    end = min(end_line or len(lines), len(lines))
    return "" if start > len(lines) else "".join(lines[start - 1 : end])


def search_text(pattern, *paths, rg_args=()):
    """Return numbered rg matches as raw path:line:text output; pattern is a regex."""
    command = [
        "rg",
        *(str(arg) for arg in rg_args),
        "--line-number",
        "--with-filename",
        "--color=never",
        str(pattern),
        *(str(path) for path in (paths or (".",))),
    ]
    return _run(command, no_matches=True)


def find_files(pattern=None, *paths, fd_args=()):
    """Return raw fd paths; pattern is an optional regex and results are regular files only."""
    command = [
        "fd",
        *(str(arg) for arg in fd_args),
        "--type",
        "f",
        "--color=never",
    ]
    command.append(str(pattern) if pattern is not None else ".")
    command.extend(str(path) for path in (paths or (".",)))
    return _run(command, no_matches=True)


def cymbal(*args):
    """Run a cymbal subcommand in the session cwd and return raw stdout."""
    if not args:
        raise ValueError("cymbal requires a command")
    return _run(["cymbal", *(str(arg) for arg in args)])


def git(*args):
    """Run a git subcommand in the session cwd and return raw stdout."""
    if not args:
        raise ValueError("git requires a command")
    return _run(["git", *(str(arg) for arg in args)])


class _Browse:
    read_file = staticmethod(read_file)
    search_text = staticmethod(search_text)
    find_files = staticmethod(find_files)
    cymbal = staticmethod(cymbal)
    git = staticmethod(git)


browse = _Browse()
