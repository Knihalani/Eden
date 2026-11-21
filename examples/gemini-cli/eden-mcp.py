#!/usr/bin/env python3
"""`ask_context` for Gemini CLI as a minimal MCP stdio server (newline-delimited JSON-RPC).

Gemini CLI cannot add tools through hooks, so the installer registers this as an MCP server
(`mcpServers.eden` in settings.json). It implements the three messages the host sends —
`initialize`, `tools/list`, `tools/call` — and answers `ask_context` through `EdenGemini`'s own
ask path. `pending_context` drains the packets Eden pushed; an `ask_context` reply carries them
too, after the answer — the pending queue is the shared one the hooks drain, so a packet goes
once. Never reported, never checked. Stdlib only; dies quietly on anything unexpected.
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
            "properties": {
                "question": {"type": "string", "description": "The question, in plain words."},
                "item": {"type": "string",
                         "description": "An item id from an earlier answer's Sources list ([item: ...]): "
                                        "return that item's parts in full."},
            },
            "required": ["question"],
        },
    },
    {
        "name": "pending_context",
        "description": "Context Eden pushed for this session since the last call; the queue drains, so each packet "
        "is seen once. Call between turns — an agent on MCP alone gets Eden's answers but no push without it.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _home():
    import os

    env_home = os.environ.get("GEMINI_CLI_HOME")
    if env_home:
        return Path(env_home).expanduser()
    here = Path(__file__).resolve()
    # Installed as <home>/eden/eden-mcp.py; in a repo checkout, the default home.
    return here.parents[1] if here.parent.name == "eden" else Path.home() / ".gemini"


def _plugin():
    from eden_client.gemini import EdenGemini

    return EdenGemini(home=_home(), plugin_file=Path(__file__).resolve())


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
            if plugin is None:
                plugin = _plugin()
            try:
                # MCP calls carry no Gemini session id; the hooks' state files name the live one,
                # so the ask lands in the same session the tool hooks check.
                from eden_client.claude import latest_session_id
                from eden_client.hermes import _joined

                sid = latest_session_id(_home()) or "eden-mcp"
                client = plugin.client(sid)
                if params.get("name") == "pending_context":
                    answer = _joined(client.pending()) if client is not None else None
                elif params.get("name") == "ask_context":
                    call_args = params.get("arguments") or {}
                    question = str(call_args.get("question") or "")
                    item = call_args.get("item")
                    answer = plugin.ask_context(
                        {"question": question, **({"item": item} if isinstance(item, str) else {})},
                        session_id=sid)
                    # The queue's packets ride the reply: an MCP-only agent has no other channel.
                    pushed = _joined(client.pending()) if client is not None else None
                    answer = "\n\n".join(t for t in (answer, pushed) if t)
                else:
                    reply(msg_id, {"content": [{"type": "text", "text": "Unknown tool."}], "isError": True})
                    continue
            except Exception:  # noqa: BLE001
                answer = None
            reply(msg_id, {"content": [{"type": "text", "text": answer or "No context available."}]})
        elif msg_id is not None and method:
            reply(msg_id, {})
    return 0


if __name__ == "__main__":
    sys.exit(main())
