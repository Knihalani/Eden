#!/usr/bin/env python3
"""Install Eden for Cursor: `~/.cursor/eden/` with `eden-hook.py` + `eden-mcp.py` + the
vendored `eden_client` package + `bin/eden-local`, the hook entries merged into
`~/.cursor/hooks.json` (the flat `{"version": 1, "hooks": {event: [{command, ...}]}}` shape)
and the `eden` MCP server merged into `~/.cursor/mcp.json`.

Run inside an Eden release archive (which ships `bin/eden-local`) or a repo checkout (where this
builds it with Bun). `--cursor-home PATH` installs somewhere other than `~/.cursor`. Re-running
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

HOOK_EVENTS = ["sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse",
               "postToolUseFailure", "afterAgentResponse", "preCompact", "sessionEnd"]
HOOK_ARGS = {
    "sessionStart": "session_start",
    "beforeSubmitPrompt": "before_submit_prompt",
    "preToolUse": "pre_tool_use",
    "postToolUse": "post_tool_use",
    "postToolUseFailure": "post_tool_use_failure",
    "afterAgentResponse": "after_agent_response",
    "preCompact": "pre_compact",
    "sessionEnd": "session_end",
}


def find_root(start):
    for d in [start, *start.parents]:
        if (d / "packages" / "server" / "src" / "main.ts").is_file():
            return d
    return None


def cursor_home(args):
    if args.cursor_home:
        return Path(os.path.expandvars(args.cursor_home)).expanduser().resolve()
    env = os.environ.get("CURSOR_HOME")
    return Path(env).expanduser().resolve() if env else Path.home() / ".cursor"


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


def read_json(path):
    """{} for a missing file; None for one that exists but isn't a JSON object (never clobbered)."""
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else None
    except FileNotFoundError:
        return {}
    except Exception:  # noqa: BLE001
        return None


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    # Keep the file's permissions (a bare replace resets them to the umask's 0o644); a new file
    # holding hook/MCP settings — which may carry env credentials — starts owner-only.
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    tmp.chmod(mode)
    tmp.replace(path)


def merge_hooks(home, dest):
    """Add Eden's hook commands to hooks.json, deduped by command."""
    hooks_path = home / "hooks.json"
    config = read_json(hooks_path)
    if config is None:
        print(f"warning: {hooks_path} is not a JSON object; hooks not merged "
              "(fix or remove it and re-run)", file=sys.stderr)
        return
    config.setdefault("version", 1)
    hooks = config.setdefault("hooks", {})
    for event in HOOK_EVENTS:
        command = f"python3 {shlex.quote(str(dest / 'eden-hook.py'))} {HOOK_ARGS[event]}"
        entries = hooks.setdefault(event, [])
        commands = [
            # Both entry shapes: Cursor's flat {command, ...} and the nested
            # {matcher, hooks: [{command, ...}]} a Claude-format hook file maps to.
            entry.get("command") if isinstance(entry, dict) else None
            for entry in entries
        ] + [
            h.get("command")
            for entry in entries
            for h in ((entry.get("hooks") or []) if isinstance(entry, dict) else [])
            if isinstance(h, dict)
        ]
        if command not in commands:
            entries.append({"command": command, "timeout": 30})
    write_json(hooks_path, config)


def merge_mcp(home, dest):
    """Register the eden MCP server in ~/.cursor/mcp.json, preserving a prior entry's extra keys."""
    mcp_path = home / "mcp.json"
    config = read_json(mcp_path)
    if config is None:
        print(f"warning: {mcp_path} is not a JSON object; the eden MCP server was not registered",
              file=sys.stderr)
        return
    servers = config.setdefault("mcpServers", {})
    existing = servers.get("eden")
    entry = dict(existing) if isinstance(existing, dict) else {}
    entry.update({"command": "python3", "args": [str(dest / "eden-mcp.py")]})
    servers["eden"] = entry
    write_json(mcp_path, config)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cursor-home",
        metavar="PATH",
        help="Cursor home directory (default: $CURSOR_HOME or ~/.cursor)",
    )
    args = parser.parse_args()
    root = find_root(HERE)
    work = Path(tempfile.mkdtemp(prefix="eden-cursor-install-"))
    try:

        home = cursor_home(args)
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
        merge_hooks(home, dest)
        merge_mcp(home, dest)
        print(f"Eden installed to {dest}; hooks registered in {home}/hooks.json, "
              f"the MCP server in {home}/mcp.json")
        print(f"Next: put sources in {home}/eden/sources.json (see README.md) and start a new Cursor session.")
    finally:
        shutil.rmtree(work, ignore_errors=True)  # the private build dir is scratch once artifacts are copied


if __name__ == "__main__":
    main()
