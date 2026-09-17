helper_description = """subagent(prompt, *, cwd=None) — run a read-only pi exploration subagent with openai-codex/gpt-5.6-luna and high thinking; bash is enabled for cymbal navigation; returns its answer."""

import subprocess as _subprocess


def subagent(prompt, *, cwd=None):
    """Ask pi to gather repository context without changing files."""
    result = _subprocess.run(
        [
            "pi",
            "--no-session",
            "--model",
            "openai-codex/gpt-5.6-luna",
            "--thinking",
            "high",
            "--tools",
            "read,grep,find,ls,bash",
            "--print",
            "--",
            str(prompt),
        ],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"pi subagent failed ({result.returncode}): {detail}")
    return result.stdout
