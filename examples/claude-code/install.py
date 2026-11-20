#!/usr/bin/env python3
"""Install Eden for Claude Code: `~/.claude/eden/` with `eden-hook.py` + `eden-mcp.py` + the
vendored `eden_client` package + `bin/eden-local`, and the hook/MCP entries merged into
`~/.claude/settings.json` and `~/.claude.json`.

Run inside an Eden release archive (which ships `bin/eden-local`) or a repo checkout (where this
builds it with Bun). `--claude-home PATH` installs somewhere other than `~/.claude`. Re-running
refreshes the install; existing hooks and MCP servers are left untouched.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]
HOOK_ARGS = {
    "SessionStart": "session_start",
    "UserPromptSubmit": "user_prompt_submit",
    "PreToolUse": "pre_tool_use",
    "PostToolUse": "post_tool_use",
    "Stop": "stop",
    "SessionEnd": "session_end",
}


def find_root(start):
    for d in [start, *start.parents]:
        if (d / "packages" / "server" / "src" / "main.ts").is_file():
            return d
    return None


def claude_home(args):
    if args.claude_home:
        return Path(os.path.expandvars(args.claude_home)).expanduser().resolve()
    env = os.environ.get("CLAUDE_HOME") or os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(env).expanduser().resolve() if env else Path.home() / ".claude"


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
    tmp.replace(path)


def merge_settings(home, dest):
    """Add Eden's hooks to settings.json (deduped by command) and the MCP server to .claude.json."""
    settings_path = home / "settings.json"
    settings = read_json(settings_path)
    if settings is None:
        print(f"warning: {settings_path} is not a JSON object; hooks not merged "
              "(fix or remove it and re-run)", file=sys.stderr)
    else:
        hooks = settings.setdefault("hooks", {})
        for event in HOOK_EVENTS:
            command = f"python3 {dest / 'eden-hook.py'} {HOOK_ARGS[event]}"
            entries = hooks.setdefault(event, [])
            commands = [
                h.get("command")
                for entry in entries
                for h in (entry.get("hooks") if isinstance(entry, dict) else [])
                if isinstance(h, dict)
            ]
            if command not in commands:
                entries.append({"matcher": "*", "hooks": [{"type": "command", "command": command}]})
        write_json(settings_path, settings)

    # MCP servers live in ~/.claude.json (Claude Code's own `claude mcp add` writes there).
    claude_json = home / ".claude.json" if (home / ".claude.json").exists() else home.parent / ".claude.json"
    config = read_json(claude_json)
    if config is None:
        print(f"warning: {claude_json} is not a JSON object; the eden MCP server was not registered",
              file=sys.stderr)
    else:
        servers = config.setdefault("mcpServers", {})
        servers["eden"] = {"command": "python3", "args": [str(dest / "eden-mcp.py")]}
        write_json(claude_json, config)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--claude-home",
        metavar="PATH",
        help="Claude Code home directory (default: $CLAUDE_HOME or ~/.claude)",
    )
    args = parser.parse_args()
    root = find_root(HERE)
    work = Path(os.environ.get("TMPDIR", "/tmp")) / "eden-claude-install"
    work.mkdir(parents=True, exist_ok=True)

    home = claude_home(args)
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
    # Replace via rename: copy2 over a still-running detached server fails with ETXTBSY on Linux.
    staged = work / f"eden-local-staged-{os.getpid()}"
    shutil.copy2(binary, staged)
    staged.chmod(0o755)
    os.replace(staged, dest / "bin" / "eden-local")
    merge_settings(home, dest)
    print(f"Eden installed to {dest}; hooks registered in {home}/settings.json")
    print(f"Next: put sources in {home}/eden/sources.json (see README.md) and start a new Claude Code session.")


if __name__ == "__main__":
    main()
