#!/usr/bin/env python3
"""Install Eden into every local agent home found: claude-code, gptme, openclaw, opencode, pi.

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

# agent -> the env var / default path its installer resolves for its home. Detection checks the
# default location only; a `--<agent>-home PATH` flag selects the agent even when the default
# is absent (the path is handed straight through).
AGENTS = {
    "claude-code": ("CLAUDE_HOME", Path.home() / ".claude"),
    "gptme": ("GPTME_HOME", Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "gptme"),
    "openclaw": ("OPENCLAW_HOME", Path.home() / ".openclaw"),
    "opencode": ("OPENCODE_HOME", Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "opencode"),
    "pi": ("PI_HOME", Path.home() / ".pi"),
}


def detected():
    found = []
    for name, (env, default) in AGENTS.items():
        home = Path(os.environ.get(env, default)).expanduser()
        if home.is_dir():
            found.append(name)
    return found


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
        chosen = detected() + [a for a in AGENTS if getattr(args, f"{a.replace('-', '_')}_home")]
        chosen = list(dict.fromkeys(chosen))

    if args.list:
        for name in AGENTS:
            env, default = AGENTS[name]
            home = Path(os.environ.get(env, default)).expanduser()
            mark = "detected" if name in chosen else ("home absent" if not home.is_dir() else "skipped")
            print(f"{name:12} {mark:12} {home}")
        return 0

    if not chosen:
        print(
            "No local agents detected. Looked for "
            + ", ".join(f"{n} ({h})" for n, (_, h) in AGENTS.items())
            + " — or pass --agents."
        )
        return 1

    failed = []
    for name in chosen:
        installer = HERE / name / "install.py"
        cmd = [sys.executable, str(installer)]
        home = getattr(args, f"{name.replace('-', '_')}_home")
        if home:
            cmd += [f"--{name}-home", home]
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
