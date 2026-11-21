#!/usr/bin/env python3
"""Eden's Windsurf Cascade hook (the legacy agent in Devin Desktop). Cascade runs one hook
per event, each its own process: the payload arrives as JSON on stdin with the event named
in ``agent_action_name`` (plus ``trajectory_id``, ``execution_id``, ``model_name`` and the
event's ``tool_info``). Cascade shows a hook's stdout in the UI only — a packet reaches the
agent through an MCP ``pending_context``/``ask_context`` call — while a party finding exits
2 with the held text on stderr, the one channel that blocks the action. Everything fails
open: a hook that errors exits 0 so the agent proceeds (D14).
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # vendored `eden_client` sits beside this script


def _home() -> Path:
    """Windsurf's home: env override, then the install's own directory, then the default."""
    import os

    env_home = os.environ.get("WINDSURF_HOME") or os.environ.get("CODEIUM_WINDSURF_HOME")
    if env_home:
        return Path(env_home).expanduser()
    here = Path(__file__).resolve()
    # Installed as <home>/eden/eden-hook.py, so the install home is the parent of this
    # file's directory; in a repo checkout fall back to the default home.
    if here.parent.name == "eden":
        return here.parents[1]
    return Path.home() / ".codeium" / "windsurf"


def main() -> int:
    try:
        payload = json.load(sys.stdin) or {}
    except Exception:  # noqa: BLE001
        return 0
    try:
        from eden_client.windsurf import EdenWindsurf, dispatch

        plugin = EdenWindsurf(home=_home(), plugin_file=Path(__file__).resolve())
        result = dispatch(plugin, payload)
        if isinstance(result, str):
            if result.startswith("DENY:"):
                # Exit 2 + stderr is Cascade's deny channel: the stderr text goes to the agent.
                print(result[len("DENY:"):], file=sys.stderr)
                return 2
            if result:
                print(result)
    except Exception:  # noqa: BLE001
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
