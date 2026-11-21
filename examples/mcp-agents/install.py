#!/usr/bin/env python3
"""Install Eden's MCP server into the agents that expose an MCP client but no hook
surface: Cline, Roo Code, Amazon Q, Crush, Zed, Goose and Codex CLI.

The payload lands once in ``<eden-home>/eden/`` (default ``~/.eden-mcp``): ``eden-mcp.py``,
the vendored ``eden_client`` package and ``bin/eden-local`` for local mode. Each agent then
gets one server entry merged into its own config — JSON (``mcpServers``/``mcp``/
``context_servers``), Goose's YAML ``extensions`` or Codex's TOML ``[mcp_servers.eden]``.

These agents have no hooks: nothing observes prompts, checks tool calls or reports replies,
so the surface is pull-only — ``ask_context`` plus whatever ``pending_context`` drains.
Run inside a release archive (ships ``bin/eden-local``) or a repo checkout (builds with Bun).
``--<agent>-config PATH`` points at a config somewhere else; ``--agents`` selects a subset.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

# agent -> (home dir whose presence means the agent is installed, its MCP config path,
#           merge format). The config flag per agent is ``--<agent>-config``.
def _vscode_user():
    """VS Code's user-data dir for this OS — the installer runs where the agent does."""
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/Code/User")
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~/AppData/Roaming")
        return os.path.join(base, "Code", "User")
    return os.path.expanduser("~/.config/Code/User")


AGENTS = {
    "cline": ("~/.cline",
              "~/.cline/data/settings/cline_mcp_settings.json", "mcpservers"),
    "roo-code": ("~/.roo-code",
                 "~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json",
                 "mcpservers"),
    "amazon-q": ("~/.aws/amazonq", "~/.aws/amazonq/mcp.json", "mcpservers"),
    "crush": ("~/.config/crush", "~/.config/crush/crush.json", "crush"),
    "zed": ("~/.config/zed", "~/.config/zed/settings.json", "zed"),
    "goose": ("~/.config/goose", "~/.config/goose/config.yaml", "goose"),
    "codex": ("~/.codex", "~/.codex/config.toml", "codex"),
    "kiro": ("~/.kiro", "~/.kiro/settings/mcp.json", "mcpservers"),
    "warp": ("~/.warp", "~/.warp/.mcp.json", "mcpservers"),
    # Continue reads every *.json in mcpServers/ as a config of its own — no merge needed.
    "continue": ("~/.continue", "~/.continue/mcpServers/eden.json", "own-file"),
    # Kilo Code v7+: the JSONC kilo.jsonc file; `mcp` holds {type:"local", command:[...]} entries.
    "kilo-code": ("~/.config/kilo", "~/.config/kilo/kilo.jsonc", "kilo"),
    # VS Code's own agent mode reads the user-level mcp.json; `servers` entries are plain
    # stdio, and the user-data dir is per-OS (callables resolve it where the agent runs).
    "vscode": (_vscode_user, lambda: os.path.join(_vscode_user(), "mcp.json"), "servers"),
    # Junie (JetBrains IDE + CLI) reads one mcp.json at both scopes; the global is the user file.
    "junie": ("~/.junie", "~/.junie/mcp/mcp.json", "mcpservers"),
}


def find_root(start):
    for d in [start, *start.parents]:
        if (d / "packages" / "server" / "src" / "main.ts").is_file():
            return d
    return None


def ensure_binary(root, work):
    prebuilt = HERE / "bin" / "eden-local"
    if prebuilt.is_file():
        return prebuilt
    bun = shutil.which("bun")
    if not root or not bun:
        sys.exit("Need Bun and a repo checkout, or a release archive containing bin/eden-local")
    out = work / "eden-local"
    subprocess.run(
        [bun, "build", "--compile", "--no-compile-autoload-dotenv",
         "--no-compile-autoload-bunfig", f"--outfile={out}",
         "packages/server/src/main.ts"],
        cwd=root, check=True)
    return out


def strip_jsonc(text):
    """Drop // and /* */ comments outside strings: Zed's settings.json is JSONC."""
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
        elif ch == ",":
            # A trailing comma is legal JSONC: drop it when only whitespace/comments stand
            # between it and the closing bracket. A comma straight after '{'/'[' is not
            # trailing — keep it so malformed files still fail to parse.
            prev = len(out) - 1
            while prev >= 0 and out[prev] in " \t\r\n":
                prev -= 1
            if prev < 0 or out[prev] in "{[":
                out.append(ch)
                i += 1
                continue
            j = i + 1
            while j < len(text):
                if text[j] in " \t\r\n":
                    j += 1
                elif text[j:j + 2] == "//":
                    k = text.find("\n", j)
                    j = len(text) if k == -1 else k + 1
                elif text[j:j + 2] == "/*":
                    k = text.find("*/", j + 2)
                    j = len(text) if k == -1 else k + 2
                else:
                    break
            if j < len(text) and text[j] in "]}":
                i += 1
                continue
            out.append(ch)
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def read_json(path):
    """{} for a missing file; None for one that exists but isn't a JSON object (never clobbered)."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    try:
        data = json.loads(text)
    except Exception:  # noqa: BLE001
        try:
            data = json.loads(strip_jsonc(text))
        except Exception:  # noqa: BLE001
            return None
    return data if isinstance(data, dict) else None


def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    # 0600 from creation, not after: a merged EDEN_API_KEY must never sit in a readable file —
    # not for the tmp's brief life, and not under an existing config's looser mode.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    mode = (path.stat().st_mode & 0o700) if path.exists() else 0o600
    tmp.chmod(mode or 0o600)
    tmp.replace(path)


def write_json(path, data):
    write_text(path, json.dumps(data, indent=2) + "\n")


def entry_for(fmt, mcp_py, env):
    if fmt == "kilo":
        e = {"type": "local", "command": ["python3", str(mcp_py)], "enabled": True}
        if env:
            e["environment"] = env
        return e
    if fmt in ("mcpservers", "crush", "servers"):
        e = {"command": "python3", "args": [str(mcp_py)]}
        if fmt in ("crush", "servers"):
            e["type"] = "stdio"
        if env:
            e["env"] = env
        return e
    if fmt == "zed":
        cmd = {"path": "python3", "args": [str(mcp_py)]}
        if env:
            cmd["env"] = env
        return {"command": cmd}
    return None


def merge_json(config, fmt, mcp_py, env, remove=False):
    data = read_json(config)
    if data is None:
        print(f"warning: {config} is not a JSON object; the Eden server was not merged "
              "(fix or remove it and re-run)", file=sys.stderr)
        return False
    key = {"mcpservers": "mcpServers", "crush": "mcp", "kilo": "mcp",
           "zed": "context_servers", "servers": "servers"}[fmt]
    servers = data.setdefault(key, {})
    if not isinstance(servers, dict):
        print(f"warning: {config}'s {key} is not an object; skipped", file=sys.stderr)
        return False
    if remove:
        servers.pop("eden", None)
    else:
        servers["eden"] = entry_for(fmt, mcp_py, env)
    write_json(config, data)
    return True


def merge_goose(path, mcp_py, env, remove=False):
    """Rewrite the ``eden`` extension in config.yaml. Line-level surgery under ``extensions:``
    (a comment may trail the colon): an existing ``eden:`` entry — at whatever child indent the
    file uses — is dropped and the fresh block is inserted at that same indent, so an install
    can neither nest siblings under Eden nor duplicate the key."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        lines = []

    def indent(line):
        return len(line) - len(line.lstrip())

    ext_i = next((i for i, l in enumerate(lines)
                  if re.match(r"^\s*extensions\s*:\s*(#.*)?$", l)), None)
    if ext_i is None:
        if remove:
            if lines:
                write_text(path, "\n".join(lines) + "\n")
            return True
        block = ["  eden:", "    type: stdio", "    name: eden", "    enabled: true",
                 "    timeout: 300", "    cmd: python3", "    args:", f"      - {mcp_py}"]
        if env:
            block.append("    envs:")
            block += [f"      {k}: {v}" for k, v in env.items()]
        out = list(lines)
        if out and out[-1].strip():
            out.append("")
        out.append("extensions:")
        out.extend(block)
        write_text(path, "\n".join(out) + "\n")
        return True

    ext_indent = indent(lines[ext_i])
    end, child = ext_i + 1, None
    while end < len(lines):
        l = lines[end]
        if l.strip() and indent(l) <= ext_indent:
            break
        if l.strip() and not l.lstrip().startswith("#") and child is None:
            child = indent(l)
        end += 1
    if child is None:
        child = ext_indent + 2

    # drop an `eden:` entry at the child indent (or shallower-but-still-under-extensions)
    kept, skipping = [], False
    for l in lines[ext_i + 1:end]:
        if l.strip() and ext_indent < indent(l) <= child and re.match(r"^eden\s*:", l.lstrip()):
            skipping = True
            continue
        if skipping and l.strip() and not l.lstrip().startswith("#") and indent(l) <= child:
            skipping = False
        if not skipping:
            kept.append(l)

    out = lines[:ext_i + 1] + kept + lines[end:]
    if not remove:
        pad = " " * child
        block = [f"{pad}eden:", f"{pad}  type: stdio", f"{pad}  name: eden",
                 f"{pad}  enabled: true", f"{pad}  timeout: 300", f"{pad}  cmd: python3",
                 f"{pad}  args:", f"{pad}    - {mcp_py}"]
        if env:
            block.append(f"{pad}  envs:")
            block += [f"{pad}    {k}: {v}" for k, v in env.items()]
        out = lines[:ext_i + 1] + block + kept + lines[end:]
    write_text(path, "\n".join(out) + "\n")
    return True


def merge_codex(path, mcp_py, env, remove=False):
    """Rewrite ``[mcp_servers.eden]`` in config.toml: the old table's lines are dropped and
    the fresh table is appended (a TOML table may sit anywhere)."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        lines = []
    out, skipping = [], False
    for line in lines:
        head = line.strip()
        if head == "[mcp_servers.eden]" or head.startswith("[mcp_servers.eden."):
            skipping = True
            continue
        if skipping and line.strip().startswith("["):
            skipping = False
        if not skipping:
            out.append(line)
    if not remove:
        while out and not out[-1].strip():
            out.pop()
        out += ["", "[mcp_servers.eden]", 'command = "python3"',
                f'args = ["{mcp_py}"]']
        if env:
            pairs = ", ".join(f'{k} = "{v}"' for k, v in env.items())
            out.append(f"env = {{ {pairs} }}")
    write_text(path, "\n".join(out) + "\n")
    return True


def merge_agent(name, config, fmt, mcp_py, env, remove=False):
    if fmt == "own-file":
        # Continue reads every *.json in mcpServers/ as a config of its own — but the file may
        # still hold other servers (a hand-named --continue-config): merge, never clobber.
        data = read_json(config)
        if data is None:
            print(f"warning: {config} is not a JSON object; skipped", file=sys.stderr)
            return False
        servers = data.setdefault("mcpServers", {})
        if not isinstance(servers, dict):
            print(f"warning: {config}'s mcpServers is not an object; skipped", file=sys.stderr)
            return False
        if remove:
            servers.pop("eden", None)
            if servers or len(data) > 1:
                write_json(config, data)
            else:
                config.unlink(missing_ok=True)
        else:
            servers["eden"] = entry_for("mcpservers", mcp_py, env)
            write_json(config, data)
        return True
    if fmt == "goose":
        return merge_goose(config, mcp_py, env, remove)
    if fmt == "codex":
        return merge_codex(config, mcp_py, env, remove)
    return merge_json(config, fmt, mcp_py, env, remove)


def install_payload(eden_home, root, remote, dry):
    dest = eden_home / "eden"
    mcp_py = dest / "eden-mcp.py"
    if dry:
        return mcp_py
    dest.mkdir(parents=True, exist_ok=True)
    client_src = (root or HERE.parent.parent) / "packages" / "client-python" / "eden_client"
    client_dest = dest / "eden_client"
    if client_dest.exists():
        shutil.rmtree(client_dest)
    shutil.copytree(client_src, client_dest,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "test_*.py", "tests"))
    shutil.copy2(HERE / "eden-mcp.py", mcp_py)
    if not remote:
        with tempfile.TemporaryDirectory(dir=dest) as work_d:
            src = ensure_binary(root, Path(work_d))
            bin_dest = dest / "bin"
            bin_dest.mkdir(exist_ok=True)
            # The client's win32 discovery looks for .exe/.cmd only — name it that there.
            name = "eden-local.exe" if sys.platform == "win32" else "eden-local"
            tmp = bin_dest / f".{name}.{os.getpid()}"
            shutil.copy2(src, tmp)
            tmp.chmod(0o755)
            os.replace(tmp, bin_dest / name)
    return mcp_py


def _p(p):
    return p() if callable(p) else p


def config_path(args, name, default):
    override = getattr(args, f"{name.replace('-', '_')}_config", None)
    env_override = os.environ.get(f"EDEN_MCP_{name.upper().replace('-', '_')}_CONFIG")
    raw = override or env_override or _p(default)
    return Path(raw).expanduser().resolve()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--agents", help="comma-separated subset of: " + ", ".join(AGENTS))
    ap.add_argument("--eden-home", default=os.environ.get("EDEN_MCP_HOME", "~/.eden-mcp"),
                    help="where eden-mcp.py, eden_client and bin/eden-local install")
    ap.add_argument("--remote", action="store_true",
                    help="serve EDEN_URL/EDEN_API_KEY instead of a local eden-local")
    ap.add_argument("--local", action="store_true", help="force local mode (default)")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    for name in AGENTS:
        ap.add_argument(f"--{name}-config")
    args = ap.parse_args()

    if args.list:
        for name, (home, cfg, _) in AGENTS.items():
            found = Path(_p(home)).expanduser().exists() or Path(_p(cfg)).expanduser().exists()
            print(f"{name:10} {'detected' if found else 'home absent'}")
        return 0

    names = [n.strip() for n in args.agents.split(",")] if args.agents else list(AGENTS)
    unknown = [n for n in names if n not in AGENTS]
    if unknown:
        sys.exit(f"unknown agent(s): {', '.join(unknown)} (known: {', '.join(AGENTS)})")

    eden_home = Path(args.eden_home).expanduser().resolve()
    env = {}
    if args.remote:
        url = os.environ.get("EDEN_URL")
        if not url:
            sys.exit("--remote needs EDEN_URL set")
        env = {"EDEN_URL": url}
        # Remote Eden keys the session by user+tenant — without EDEN_USER_ID no client registers.
        for k in ("EDEN_API_KEY", "EDEN_USER_ID", "EDEN_TENANT_ID"):
            if os.environ.get(k):
                env[k] = os.environ[k]

    root = find_root(HERE)
    # Uninstall only edits configs — no payload is installed (and none is needed to find
    # the entry's path: the merged command's own arg names it).
    mcp_py = (eden_home / "eden" / "eden-mcp.py") if args.uninstall else \
        install_payload(eden_home, root, args.remote, args.dry_run)

    failed = 0
    for name in names:
        home, cfg, fmt = AGENTS[name]
        config = config_path(args, name, cfg)
        if args.dry_run:
            print(f"[dry] would {'remove Eden from' if args.uninstall else 'merge Eden into'} "
                  f"{config} ({name})")
            continue
        try:
            if merge_agent(name, config, fmt, mcp_py, env, remove=args.uninstall):
                print(f"[eden] {name}: {'removed from' if args.uninstall else 'merged into'} {config}")
            else:
                failed += 1
        except Exception as e:  # noqa: BLE001 — one agent's config must not block the rest
            failed += 1
            print(f"warning: {name}: {e}", file=sys.stderr)
    print(f"[eden] server: python3 {mcp_py}" + ("" if args.dry_run else " (pull-only: ask_context, pending_context)"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
