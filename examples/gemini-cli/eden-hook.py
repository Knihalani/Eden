#!/usr/bin/env python3
"""Eden's Gemini CLI hook. Gemini runs one hook per event, each its own process: argv[1] is the
event name, the payload arrives as JSON on stdin (``session_id``, ``cwd``, ``hook_event_name``
plus the event's fields) and a JSON object on stdout steers the turn — a packet becomes
``hookSpecificOutput.additionalContext`` (named for the event it answers) and a party finding
becomes ``{"decision": "deny", "reason": ...}``. Everything fails open: a hook that errors exits 0
with no output so the CLI proceeds (D14).
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # vendored `eden_client` sits beside this script

# The event name additionalContext is attributed to on the wire.
CONTEXT_EVENTS = {
    "session_start": "SessionStart",
    "before_agent": "BeforeAgent",
    "after_tool": "AfterTool",
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

        from eden_client.gemini import EdenGemini, dispatch

        env_home = os.environ.get("GEMINI_CLI_HOME")
        if env_home:
            home = Path(env_home).expanduser()
        else:
            here = Path(__file__).resolve()
            # Installed as <home>/eden/eden-hook.py; in a repo checkout, the default home.
            home = here.parents[1] if here.parent.name == "eden" else Path.home() / ".gemini"
        plugin = EdenGemini(home=home, plugin_file=Path(__file__).resolve())
        result = dispatch(plugin, event, payload)
        if not isinstance(result, dict):
            return 0
        if result.get("deny"):
            # The hook's JSON decision denies the tool call; the finding is the reason Gemini shows.
            print(json.dumps({"decision": "deny", "reason": result["deny"]}))
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
