#!/usr/bin/env python3
"""Eden's Devin CLI hook. Devin runs one hook per event, each its own process: argv[1] is the
event name, the payload arrives as JSON on stdin (``session_id``, ``prompt_id``,
``hook_event_name`` plus the event's fields) and a JSON object on stdout steers the turn — a
packet becomes ``hookSpecificOutput.additionalContext`` (named for the event it answers) and a
party finding becomes ``{"decision": "block", "reason": ...}``. Everything fails open: a hook
that errors exits 0 with no output so the agent proceeds (D14).
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # vendored `eden_client` sits beside this script

# The event name additionalContext is attributed to on the wire.
CONTEXT_EVENTS = {
    "session_start": "SessionStart",
    "user_prompt_submit": "UserPromptSubmit",
    "post_tool_use": "PostToolUse",
}


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

        from eden_client.devincli import EdenDevinCli, dispatch

        env_home = os.environ.get("DEVIN_CLI_HOME")
        here = Path(__file__).resolve()
        if env_home:
            home = Path(env_home).expanduser()
        elif here.parent.name == "eden":
            # Installed as <home>/eden/eden-hook.py: the install home is the grandparent.
            home = here.parents[1]
        else:
            xdg = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
            home = xdg / "devin"
        plugin = EdenDevinCli(home=home, plugin_file=Path(__file__).resolve())
        result = dispatch(plugin, event, payload)
        if not isinstance(result, dict):
            return 0
        if result.get("deny"):
            # The hook's JSON decision blocks the tool call; the finding is the reason shown.
            print(json.dumps({"decision": "block", "reason": result["deny"]}))
        elif result.get("context"):
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": CONTEXT_EVENTS.get(event, event),
                    "additionalContext": result["context"],
                },
            }))
    except Exception:  # noqa: BLE001
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
