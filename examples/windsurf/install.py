#!/usr/bin/env python3
"""Install Eden for Windsurf Cascade (the legacy agent in Devin Desktop).

Usage: python3 install.py [--windsurf-home PATH] [--dry-run] [--local] [--uninstall]

Builds ``eden-local`` from the repo, copies it with ``eden_client`` and the hook/MCP scripts
into ``<windsurf-home>/eden/``, merges one ``bash`` command into every event list in
``~/.codeium/windsurf/hooks.json`` (blocking and observe events alike — ``agent_action_name``
in each payload picks the path) and registers the MCP server in
``~/.codeium/windsurf/mcp_config.json`` ``mcpServers.eden``.

``--local`` (the default) runs ``<home>/eden/eden-local`` over stdio; ``--remote`` or
``EDEN_HERMES_URL`` installs a remote endpoint instead (needs ``EDEN_API_KEY``).
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent

EVENTS = [
    "pre_user_prompt",
    "pre_run_command",
    "pre_write_code",
    "pre_read_code",
    "pre_mcp_tool_use",
    "post_run_command",
    "post_write_code",
    "post_read_code",
    "post_mcp_tool_use",
    "post_cascade_response",
]


def default_home() -> Path:
    env = os.environ.get("WINDSURF_HOME") or os.environ.get("CODEIUM_WINDSURF_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".codeium" / "windsurf"


def build_local(dry_run: bool) -> str | None:
    """Build ``eden-local`` from the repo (a prebuilt binary beside the script wins)."""
    binary_name = "eden-local.exe" if sys.platform == "win32" else "eden-local"
    built = SCRIPT_DIR / "bin" / binary_name
    if built.exists():
        return str(built)
    if dry_run:
        return f"<{binary_name} from bun build --compile>"
    if not shutil.which("bun"):
        print("[eden] need bun and a repo checkout, or a release archive with bin/eden-local")
        return None
    print("[eden] building eden-local (bun build --compile) ...")
    out_dir = SCRIPT_DIR / "bin"
    out_dir.mkdir(exist_ok=True)
    proc = subprocess.run(
        ["bun", "build", "--compile", "--no-compile-autoload-dotenv",
         "--no-compile-autoload-bunfig",
         f"--outfile={out_dir / binary_name}", "packages/server/src/main.ts"],
        cwd=str(REPO_ROOT), capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        return None
    return str(out_dir / binary_name)


def save_json(path: Path, obj: dict, dry: bool) -> None:
    if dry:
        print(f"[dry] would write {path}: {json.dumps(obj)[:160]}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, indent=2) + "\n"
    tmp = tempfile.NamedTemporaryFile("w", dir=str(path.parent), delete=False, suffix=".tmp")
    try:
        tmp.write(text)
        tmp.close()
        os.replace(tmp.name, path)
    except BaseException:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


def load_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _merged(hooks: dict, command: str) -> dict:
    """Add ``{bash: command}`` to every event's hook list; merge tolerates flat entries and
    drops any prior Eden command so a reinstall refreshes in place."""
    out = dict(hooks)
    for event in EVENTS:
        entries = []
        for entry in (out.get(event) or []):
            if isinstance(entry, dict):
                if "eden/eden-hook.py" in str(entry.get("bash") or ""):
                    continue
                entries.append(entry)
        entries.append({"bash": command})
        out[event] = entries
    return out


def _unmerged(hooks: dict, command: str) -> dict:
    out = dict(hooks)
    for event in list(out):
        entries = [
            e for e in (out.get(event) or [])
            if not (isinstance(e, dict) and "eden/eden-hook.py" in str(e.get("bash") or ""))
        ]
        if entries:
            out[event] = entries
        else:
            out.pop(event, None)
    return out


def install(home: Path, local_bin: str | None, remote: bool, dry: bool) -> None:
    dest = home / "eden"
    command = f"python3 {shlex.quote(str(dest / 'eden-hook.py'))}"

    if not dry:
        dest.mkdir(parents=True, exist_ok=True)
        client_src = REPO_ROOT / "packages" / "client-python" / "eden_client"
        client_dest = dest / "eden_client"
        if client_dest.exists():
            shutil.rmtree(client_dest)
        shutil.copytree(
            client_src, client_dest,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "test_*.py", "tests"))
        for f in ("eden-hook.py", "eden-mcp.py"):
            shutil.copy2(SCRIPT_DIR / f, dest / f)
            (dest / f).chmod((dest / f).stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        if local_bin:
            (dest / "bin").mkdir(parents=True, exist_ok=True)
            binary_name = Path(local_bin).name
            target = dest / "bin" / binary_name
            # Atomic replace: a running eden-local rejects writes (ETXTBSY).
            staged = dest / "bin" / f".{binary_name}.{os.getpid()}.tmp"
            if Path(local_bin).resolve() != target.resolve():
                shutil.copy2(local_bin, staged)
            else:
                shutil.copy2(local_bin, staged)
            os.replace(staged, target)
            target.chmod(target.stat().st_mode | stat.S_IXUSR)
        print(f"[eden] installed into {dest}")

    hooks_path = home / "hooks.json"
    hooks = load_json(hooks_path)
    new_hooks = _merged(hooks, command)
    if not dry:
        if hooks_path.exists():
            backup = hooks_path.with_suffix(".json.bak")
            backup.write_bytes(hooks_path.read_bytes())
            os.chmod(backup, hooks_path.stat().st_mode & 0o777)
        save_json(hooks_path, new_hooks, False)
        hooks_path.chmod(0o600)
    else:
        print(f"[dry] would merge Eden's command into {hooks_path}")

    mcp_path = home / "mcp_config.json"
    mcp = load_json(mcp_path)
    servers = mcp.get("mcpServers") if isinstance(mcp.get("mcpServers"), dict) else {}
    env = {}
    if remote:
        url = os.environ.get("EDEN_HERMES_URL")
        if not url:
            print("[eden] --remote needs EDEN_HERMES_URL set")
            sys.exit(1)
        env["EDEN_HERMES_URL"] = url
        if os.environ.get("EDEN_API_KEY"):
            env["EDEN_API_KEY"] = os.environ["EDEN_API_KEY"]
    servers["eden"] = {
        "command": "python3",
        "args": [str(dest / "eden-mcp.py")],
        **({"env": env} if env else {}),
    }
    mcp["mcpServers"] = servers
    if not dry:
        if mcp_path.exists():
            backup = mcp_path.with_suffix(".json.bak")
            backup.write_bytes(mcp_path.read_bytes())
            os.chmod(backup, mcp_path.stat().st_mode & 0o777)
        save_json(mcp_path, mcp, False)
        mcp_path.chmod(0o600)
    else:
        print(f"[dry] would register the MCP server in {mcp_path}")

    print(f"[eden] hooks: {len(EVENTS)} events -> {command}")
    print("[eden] deny channel: exit 2 + stderr; context rides MCP (stdout is UI-only).")
    print("[eden] done.")


def uninstall(home: Path, dry: bool) -> None:
    dest = home / "eden"
    hooks_path = home / "hooks.json"
    hooks = _unmerged(load_json(hooks_path), f"python3 {dest / 'eden-hook.py'}")
    if not dry:
        save_json(hooks_path, hooks, False)
        hooks_path.chmod(0o600)
    else:
        print(f"[dry] would remove Eden's commands from {hooks_path}")
    mcp_path = home / "mcp_config.json"
    mcp = load_json(mcp_path)
    if isinstance(mcp.get("mcpServers"), dict):
        mcp["mcpServers"].pop("eden", None)
    if not dry:
        save_json(mcp_path, mcp, False)
        mcp_path.chmod(0o600)
    else:
        print(f"[dry] would unregister the MCP server in {mcp_path}")
    if dest.exists() and not dry:
        shutil.rmtree(dest)
        print(f"[eden] removed {dest}")
    print("[eden] uninstalled.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Install Eden for Windsurf Cascade")
    ap.add_argument("--windsurf-home", default=str(default_home()))
    ap.add_argument("--remote", action="store_true")
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()

    home = Path(args.windsurf_home).expanduser()
    if args.uninstall:
        uninstall(home, args.dry_run)
        return

    remote = args.remote or bool(os.environ.get("EDEN_HERMES_URL"))
    local_bin = None
    if not remote:
        local_bin = build_local(args.dry_run)
        if local_bin is None:
            print("[eden] eden-local build failed; install the binary into <home>/eden/ first")
            sys.exit(1)
    install(home, local_bin, remote, args.dry_run)


if __name__ == "__main__":
    main()
