#!/usr/bin/env python3
"""`ask_context` for Claude Code as a minimal MCP stdio server (newline-delimited JSON-RPC).

Claude Code cannot add tools through hooks, so the installer registers this as an MCP server
(`mcpServers.eden`). It implements the three messages the host sends — `initialize`,
`tools/list`, `tools/call` — and answers `ask_context` through `EdenClaude`'s own ask path.
Never reported, never checked. Stdlib only; dies quietly on anything unexpected.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # vendored `eden_client` sits beside this script

TOOLS = [
    {
        "name": "ask_context",
        "description": "Ask Eden what the user's sources know, in plain words.",
        "inputSchema": {
            "type": "object",
            "properties": {"question": {"type": "string", "description": "The question, in plain words."}},
            "required": ["question"],
        },
    }
]


def _home():
    import os

    env_home = next((os.environ[n] for n in ("CLAUDE_HOME", "CLAUDE_CONFIG_DIR") if os.environ.get(n)), None)
    return Path(env_home).expanduser() if env_home else Path.home() / ".claude"


def _plugin():
    from eden_client.claude import EdenClaude

    return EdenClaude(home=_home(), plugin_file=Path(__file__).resolve())


def reply(msg_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
    sys.stdout.flush()


def main() -> int:
    plugin = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        method = msg.get("method")
        msg_id = msg.get("id")
        if method == "initialize":
            reply(msg_id, {
                "protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "eden", "version": "0.0.0"},
            })
        elif method == "tools/list":
            reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params") or {}
            if params.get("name") != "ask_context":
                reply(msg_id, {"content": [{"type": "text", "text": "Unknown tool."}], "isError": True})
                continue
            if plugin is None:
                plugin = _plugin()
            question = str((params.get("arguments") or {}).get("question") or "")
            try:
                # MCP calls carry no Claude session id; the hooks' state files name the live one,
                # so the ask lands in the same session the tool hooks check.
                from eden_client.claude import latest_session_id

                sid = latest_session_id(_home()) or "eden-mcp"
                answer = plugin.ask_context({"question": question}, session_id=sid)
            except Exception:  # noqa: BLE001
                answer = None
            reply(msg_id, {"content": [{"type": "text", "text": answer or "No context available."}]})
        elif msg_id is not None and method:
            reply(msg_id, {})
    return 0


if __name__ == "__main__":
    sys.exit(main())
