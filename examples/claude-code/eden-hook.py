#!/usr/bin/env python3
"""Claude Code hook command: `eden-hook.py <event>` reads the event's JSON payload on stdin.

Claude Code runs hooks as commands, one process per event; the event names are mapped in
`eden_client.claude.dispatch` (`session_start`, `user_prompt_submit`, `pre_tool_use`,
`post_tool_use`, `stop`, `session_end`).

Output:
- context: `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": t}}`
- deny (pre_tool_use): `permissionDecision: "deny"` with the held result as the reason.

Every failure is silent (D14): the hook exits 0 with no output.
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # the install places vendored `eden_client` beside this script


def home():
    env = os.environ.get("CLAUDE_HOME") or os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(env).expanduser() if env else Path.home() / ".claude"


def main() -> int:
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            payload = {}
    except Exception:  # noqa: BLE001
        payload = {}
    try:
        from eden_client.claude import EdenClaude, dispatch

        plugin = EdenClaude(home=home(), plugin_file=Path(__file__).resolve())
        result = dispatch(plugin, event, payload)
    except Exception:  # noqa: BLE001
        return 0
    if not result:
        return 0
    if "deny" in result:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": result["deny"],
            }
        }))
    elif "context" in result:
        names = {
            "user_prompt_submit": "UserPromptSubmit",
            "session_start": "SessionStart",
            "post_tool_use": "PostToolUse",
        }
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": names.get(event, event),
                "additionalContext": result["context"],
            }
        }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
