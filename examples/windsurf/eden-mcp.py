#!/usr/bin/env python3
"""Eden's ask/pending tools for Windsurf Cascade as a tiny MCP stdio server (no dependencies):
``pending_context`` drains the queue (plus anything a hook stashed for a channel-less event),
``ask_context`` answers a natural-language question. Cascade surfaces hook stdout in the UI
only, so an MCP reply is the path that puts context into the model's reach. Windsurf launches
this from its ``mcp_config.json`` ``mcpServers`` entry.
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # vendored `eden_client` sits beside this script

TOOLS = {
    "pending_context": {
        "description": "Newest things your user has seen in their other apps (sessions, topics, priorities). Call before answering so your reply knows them.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    "ask_context": {
        "description": "Ask a natural-language question about the user's context in their other apps; returns what is relevant to it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "What to look up"},
                "item": {"type": "string", "description": "An item id from a Sources line to go deeper on"},
            },
            "required": ["question"],
        },
    },
}


def _home() -> Path:
    env_home = os.environ.get("WINDSURF_HOME") or os.environ.get("CODEIUM_WINDSURF_HOME")
    if env_home:
        return Path(env_home).expanduser()
    here = Path(__file__).resolve()
    return here.parents[1] if here.parent.name == "eden" else Path.home() / ".codeium" / "windsurf"


def _plugin():
    from eden_client.windsurf import EdenWindsurf

    return EdenWindsurf(home=_home(), plugin_file=Path(__file__).resolve())


def _queued(plugin, client, sid):
    """Queued packets plus any a sibling hook stashed: a prompt or check observed this MCP
    call and cannot show its packets (Cascade's stdout is UI-only), so it parks them in the
    session's state file — the reply is the channel that can. Falls back to the live queue."""
    from eden_client.hermes import _joined

    try:
        with plugin._locked_state(sid) as state:
            return _joined(list(state.pop("stashed", []))
                           + (client.pending() if client is not None else []))
    except Exception:  # noqa: BLE001
        return _joined(client.pending()) if client is not None else None


def main() -> int:
    plugin = _plugin()
    clients = {}
    try:
        from eden_client.hermes import _joined, latest_session_id

        sid = latest_session_id(plugin.home)
        if sid:
            clients[sid] = plugin.client(sid)
    except Exception:  # noqa: BLE001
        _joined = None

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        msg_id = msg.get("id")
        method = msg.get("method")
        try:
            if method == "initialize":
                emit({"jsonrpc": "2.0", "id": msg_id, "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "eden", "version": "1.0.0"},
                }})
            elif method == "notifications/initialized":
                pass
            elif method == "ping":
                emit({"jsonrpc": "2.0", "id": msg_id, "result": {}})
            elif method == "tools/list":
                emit({"jsonrpc": "2.0", "id": msg_id, "result": {
                    "tools": [{"name": n, "description": t["description"],
                               "inputSchema": t["inputSchema"]} for n, t in TOOLS.items()]}})
            elif method == "tools/call":
                name = (msg.get("params") or {}).get("name")
                args = (msg.get("params") or {}).get("arguments") or {}
                answer = None
                try:
                    sid = latest_session_id(plugin.home) if latest_session_id else None
                    if sid:
                        client = clients.get(sid) or plugin.client(sid)
                        if client is not None:
                            clients[sid] = client
                        if name == "pending_context":
                            answer = _queued(plugin, client, sid)
                        elif name == "ask_context":
                            answer = client.ask(args.get("question") or "", args.get("item"))
                except Exception:  # noqa: BLE001
                    answer = None
                emit({"jsonrpc": "2.0", "id": msg_id, "result": {
                    "content": [{"type": "text",
                                 "text": answer or "No context available."}]}})
            elif msg_id is not None:
                emit({"jsonrpc": "2.0", "id": msg_id,
                      "error": {"code": -32601, "message": "method not found"}})
        except Exception:  # noqa: BLE001
            if msg_id is not None:
                emit({"jsonrpc": "2.0", "id": msg_id,
                      "error": {"code": -32603, "message": "internal error"}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
