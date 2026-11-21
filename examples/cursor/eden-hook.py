#!/usr/bin/env python3
"""Eden's Cursor hook. Cursor runs one hook per event, each its own process: argv[1] is the
event name, the payload arrives as JSON on stdin (``conversation_id``, ``transcript_path``,
``hook_event_name`` plus the event's fields) and a JSON object on stdout steers the turn — a
packet becomes ``additional_context`` and a party finding becomes
``{"permission": "deny", "agent_message": ...}``. Everything fails open: a hook that errors exits
0 with no output so the action proceeds (D14).
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # vendored `eden_client` sits beside this script


def main() -> int:
    if len(sys.argv) < 2:
        return 0
    event = sys.argv[1]
    try:
        payload = json.load(sys.stdin) or {}
    except Exception:  # noqa: BLE001
        return 0
    try:
        import os

        from eden_client.cursor import EdenCursor, dispatch

        env_home = os.environ.get("CURSOR_HOME")
        if env_home:
            home = Path(env_home).expanduser()
        else:
            here = Path(__file__).resolve()
            # Installed as <home>/eden/eden-hook.py; in a repo checkout, the default home.
            home = here.parents[1] if here.parent.name == "eden" else Path.home() / ".cursor"
        plugin = EdenCursor(home=home, plugin_file=Path(__file__).resolve())
        result = dispatch(plugin, event, payload)
        if not isinstance(result, dict):
            return 0
        if result.get("deny"):
            # `agent_message` is what the agent reads back; `user_message` shows the user why.
            print(json.dumps({"permission": "deny",
                              "agent_message": result["deny"],
                              "user_message": result["deny"]}))
        elif result.get("context"):
            print(json.dumps({"additional_context": result["context"]}))
    except Exception:  # noqa: BLE001
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
