#!/usr/bin/env python3
"""Install Eden for Qwen Code: `~/.qwen/eden/` with `eden-hook.py` + `eden-mcp.py` + the
vendored `eden_client` package + `bin/eden-local`, and the hook and MCP entries merged into
`~/.qwen/settings.json` (one file — Qwen reads both from it).

Run inside an Eden release archive (which ships `bin/eden-local`) or a repo checkout (where this
builds it with Bun). `--qwen-home PATH` installs somewhere other than `~/.qwen`. Re-running
refreshes the install; existing hooks and MCP servers are left untouched.
"""

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
               "PostToolUseFailure", "Stop", "PreCompact", "SessionEnd"]
HOOK_ARGS = {
    "SessionStart": "session_start",
    "UserPromptSubmit": "user_prompt_submit",
    "PreToolUse": "pre_tool_use",
    "PostToolUse": "post_tool_use",
    "PostToolUseFailure": "post_tool_use_failure",
    "Stop": "stop",
    "PreCompact": "pre_compact",
    "SessionEnd": "session_end",
}


def find_root(start):
    for d in [start, *start.parents]:
        if (d / "packages" / "server" / "src" / "main.ts").is_file():
            return d
    return None


def qwen_home(args):
    if args.qwen_home:
        return Path(os.path.expandvars(args.qwen_home)).expanduser().resolve()
    env = next((os.environ.get(n) for n in ("QWEN_CODE_HOME", "QWEN_CLI_HOME") if os.environ.get(n)), None)
    return Path(env).expanduser().resolve() if env else Path.home() / ".qwen"


def ensure_binary(root, work):
    prebuilt = HERE / "bin" / "eden-local"
    if prebuilt.is_file():
        return prebuilt
    bun = shutil.which("bun")
    if not root or not bun:
        sys.exit("Need Bun and a repo checkout, or a release archive containing bin/eden-local")
    out = work / "eden-local"
    subprocess.run(
        [
            bun,
            "build",
            "--compile",
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
            f"--outfile={out}",
            "packages/server/src/main.ts",
        ],
        cwd=root,
        check=True,
    )
    return out


def strip_jsonc(text):
    """Drop // and /* */ comments outside strings: Qwen accepts commented settings.json
    (JSONC) though `json.loads` does not."""
    out, i, in_str, esc = [], 0, False, False
    while i < len(text):
        ch = text[i]
        if in_str:
            out.append(ch)
            in_str = esc or ch != '"'
            esc = not esc and ch == "\\"
        elif ch == '"':
            out.append(ch)
            in_str = True
        elif ch == "/" and i + 1 < len(text) and text[i + 1] == "/":
            i = text.find("\n", i)
            if i == -1:
                break
            out.append("\n")
        elif ch == "/" and i + 1 < len(text) and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            if end == -1:
                break
            i = end + 2
            continue
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def read_json(path):
    """{} for a missing file; None for one that exists but isn't a JSON object (never clobbered).
    Settings are UTF-8 regardless of the platform locale; a file that only parses with its
    comments stripped returns (data, True) so the caller can keep the original beside it."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, False
    try:
        data = json.loads(text)
    except Exception:  # noqa: BLE001
        try:
            data = json.loads(strip_jsonc(text))
        except Exception:  # noqa: BLE001
            return None, False
        return (data if isinstance(data, dict) else None), True
    return (data if isinstance(data, dict) else None), False


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    # Keep the file's permissions (a bare replace resets them to the umask's 0o644); a new file
    # holding hook/MCP settings — which may carry env credentials — starts owner-only.
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    tmp.chmod(mode)
    tmp.replace(path)


def merge_settings(home, dest):
    """Add Eden's hooks and the MCP server to settings.json (both deduped by command/name)."""
    settings_path = home / "settings.json"
    settings, had_comments = read_json(settings_path)
    if settings is None:
        print(f"warning: {settings_path} is not a JSON object; hooks and the MCP server not merged "
              "(fix or remove it and re-run)", file=sys.stderr)
        return
    hooks = settings.setdefault("hooks", {})
    for event in HOOK_EVENTS:
        command = f"python3 {shlex.quote(str(dest / 'eden-hook.py'))} {HOOK_ARGS[event]}"
        entries = hooks.setdefault(event, [])
        commands = [
            h.get("command")
            for entry in entries
            for h in ((entry.get("hooks") or []) if isinstance(entry, dict) else [])
            if isinstance(h, dict)
        ]
        if command not in commands:
            entries.append({"matcher": "*", "hooks": [{"type": "command", "command": command}]})
    servers = settings.setdefault("mcpServers", {})
    # Merge over an existing entry: a previous install's extra keys (a hosted setup's env,
    # e.g. EDEN_URL/EDEN_API_KEY) survive a reinstall while command/args refresh.
    existing = servers.get("eden")
    entry = dict(existing) if isinstance(existing, dict) else {}
    entry.update({"command": "python3", "args": [str(dest / "eden-mcp.py")]})
    servers["eden"] = entry
    if had_comments:
        # The merged file is rewritten as plain JSON — keep the commented original beside it
        # rather than silently deleting the user's notes and commented-out settings.
        # Refresh every time (the latest commented original is the one worth keeping) and match
        # the source file's mode — it may hold commented-out credentials.
        backup = settings_path.with_suffix(".json.eden-backup")
        backup.write_bytes(settings_path.read_bytes())
        backup.chmod(settings_path.stat().st_mode & 0o777)
        print(f"note: {settings_path} had comments; the original is kept at {backup}",
              file=sys.stderr)
    write_json(settings_path, settings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--qwen-home",
        metavar="PATH",
        help="Qwen Code home directory (default: $QWEN_CODE_HOME or ~/.qwen)",
    )
    args = parser.parse_args()
    root = find_root(HERE)
    work = Path(tempfile.mkdtemp(prefix="eden-qwen-install-"))
    try:

        home = qwen_home(args)
        dest = home / "eden"
        # Refresh only what this installer owns: sources.json, state/, data/ and logs/ are the user's
        # (a re-run that rmtree'd the directory deleted configured sources and session state).
        dest.mkdir(parents=True, exist_ok=True)
        for stale in ("eden-hook.py", "eden-mcp.py"):
            (dest / stale).unlink(missing_ok=True)
        vendored = dest / "eden_client"
        if vendored.is_dir():
            shutil.rmtree(vendored)
        (dest / "bin").mkdir(parents=True, exist_ok=True)
        for name in ("eden-hook.py", "eden-mcp.py"):
            shutil.copy2(HERE / name, dest / name)
            (dest / name).chmod(0o755)
        client_src = (root or HERE) / "packages" / "client-python" / "eden_client"
        if not client_src.is_dir():
            sys.exit("Need a repo checkout or release archive containing packages/client-python/eden_client")
        shutil.copytree(
            client_src,
            dest / "eden_client",
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        binary = ensure_binary(root, work)
        # Replace via rename staged in the same directory: copy2 over a still-running detached server
        # fails ETXTBSY on Linux, and a cross-filesystem rename fails EXDEV.
        # On Windows the client only discovers eden-local.exe/.cmd — an extensionless file
        # would leave local mode disabled.
        binary_name = "eden-local.exe" if sys.platform == "win32" else "eden-local"
        staged = dest / "bin" / f".{binary_name}.{os.getpid()}.tmp"
        shutil.copy2(binary, staged)
        staged.chmod(0o755)
        os.replace(staged, dest / "bin" / binary_name)
        merge_settings(home, dest)
        print(f"Eden installed to {dest}; hooks and the MCP server registered in {home}/settings.json")
        print(f"Next: put sources in {home}/eden/sources.json (see README.md) and start a new Qwen Code session.")
    finally:
        shutil.rmtree(work, ignore_errors=True)  # the private build dir is scratch once artifacts are copied


if __name__ == "__main__":
    main()
