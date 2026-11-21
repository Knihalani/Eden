#!/usr/bin/env python3
"""Install Eden into every local agent home found: claude-code, cursor, gemini-cli, gptme, openclaw,
opencode, pi, qwen-code.
opencode, pi.
"""Install Eden into every local agent home found: claude-code, cursor, gemini-cli, gptme, openclaw,
"""Install Eden into every local agent home found: claude-code, cursor, devin-cli, gemini-cli, gptme, openclaw,
opencode, pi.

Each agent ships its own `examples/<agent>/install.py`; this detects which agents are present
(their home directories exist, or `--agents` names them) and runs each installer in turn,
passing `--<agent>-home` when the matching `--<agent>-home PATH` flag is given here.
Fails per agent, not wholesale: a broken install leaves the others installed, and the exit
code says how many failed.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# agent -> (env vars / default path its installer resolves for its home, its installer's
# home-flag name). Detection checks the default location only; a `--<agent>-home PATH` flag
# selects the agent even when the default is absent (the path is handed straight through, under
# the flag name that agent's installer actually accepts).
AGENTS = {
    "claude-code": (("CLAUDE_HOME", "CLAUDE_CONFIG_DIR"), Path.home() / ".claude", "--claude-home"),
    "cursor": (("CURSOR_HOME",), Path.home() / ".cursor", "--cursor-home"),
    "gemini-cli": (("GEMINI_CLI_HOME",), Path.home() / ".gemini", "--gemini-home"),
    "qwen-code": (("QWEN_CODE_HOME", "QWEN_CLI_HOME"), Path.home() / ".qwen", "--qwen-home"),
    "devin-cli": (("DEVIN_CLI_HOME",),
                    Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "devin",
                    "--devin-home"),
    "gptme": (("GPTME_HOME",), Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "gptme", "--gptme-home"),
    "openclaw": (("OPENCLAW_HOME",), Path.home() / ".openclaw", "--openclaw-home"),
    "opencode": (("OPENCODE_HOME",), Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "opencode", "--opencode-home"),
    "pi": (("PI_HOME",), Path.home() / ".pi", "--pi-home"),
}

def resolved_home(name):
    """The home an agent's installer would use, same env/default resolution it performs."""
    envs, default, _ = AGENTS[name]
    for env in envs:
        if os.environ.get(env):
            return Path(os.environ[env]).expanduser()
    return Path(default).expanduser()

def home_override(args, name):
    return getattr(args, f"{name.replace('-', '_')}_home")

def detected():
    return [name for name in AGENTS if resolved_home(name).is_dir()]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--agents",
        metavar="LIST",
        help="Comma-separated agents to install (default: every agent whose home directory exists)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="Print the detected agents and exit without installing",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the installer each agent would run without running it",
    )
    for name in AGENTS:
        parser.add_argument(f"--{name}-home", metavar="PATH", help=f"{name} home directory")
    args = parser.parse_args()

    if args.agents:
        chosen = [a.strip() for a in args.agents.split(",") if a.strip()]
        unknown = [a for a in chosen if a not in AGENTS]
        if unknown:
            sys.exit(f"unknown agents: {', '.join(unknown)} (known: {', '.join(AGENTS)})")
    else:
        # A --<agent>-home flag selects that agent even when its default home is absent.
        chosen = detected() + [a for a in AGENTS if home_override(args, a)]
        chosen = list(dict.fromkeys(chosen))

    if args.list:
        for name in AGENTS:
            home = Path(home_override(args, name) or resolved_home(name)).expanduser()
            mark = "detected" if name in chosen else ("home absent" if not home.is_dir() else "skipped")
            print(f"{name:12} {mark:12} {home}")
        return 0

    if not chosen:
        print(
            "No local agents detected. Looked for "
            + ", ".join(f"{n} ({resolved_home(n)})" for n in AGENTS)
            + " — or pass --agents."
        )
        return 1

    failed = []
    for name in chosen:
        installer = HERE / name / "install.py"
        cmd = [sys.executable, str(installer)]
        home = home_override(args, name)
        if home:
            cmd += [AGENTS[name][2], home]
        if args.dry_run:
            print(f"{name:12} {' '.join(cmd)}")
            continue
        print(f"--- {name} ---")
        rc = subprocess.run(cmd).returncode
        if rc != 0:
            failed.append(name)
            print(f"{name}: install failed ({rc})", file=sys.stderr)
    print(f"installed: {', '.join(a for a in chosen if a not in failed) or 'none'}")
    if failed:
        print(f"failed: {', '.join(failed)}", file=sys.stderr)
    return len(failed)

if __name__ == "__main__":
    sys.exit(main())
