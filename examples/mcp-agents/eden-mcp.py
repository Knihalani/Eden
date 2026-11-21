#!/usr/bin/env python3
"""Eden's ask/pending tools for MCP-only agents as a tiny stdio server (no dependencies).

Agents that expose an MCP client but no hook surface (Cline, Roo Code, Amazon Q, Crush,
Zed, Goose, Codex CLI) still get Eden's pull path: ``ask_context`` answers a natural-language
question about the user's context and ``pending_context`` drains whatever the engine has
queued for this session (partner-initiated packets, or anything a sibling hook stashed).
Without hooks nothing observes prompts or checks tool calls — the surface is pull-only.
The agent launches this from its own MCP config; ``install.py`` writes the entry.
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
    env_home = os.environ.get("EDEN_MCP_HOME")
    if env_home:
        return Path(env_home).expanduser()
    here = Path(__file__).resolve()
    return here.parents[1] if here.parent.name == "eden" else Path.home() / ".eden-mcp"


def _plugin():
    from eden_client.gemini import EdenGemini

    return EdenGemini(home=_home(), plugin_file=Path(__file__).resolve())


def _session_id(plugin, agent):
    """The newest sibling hook session's id; a pull-only home has none, so the server's own —
    ``eden-mcp`` (+ the agent's MCP clientInfo name, so ten agents do not share a session) —
    kept in the state dir for later runs and for hooks sharing the home."""
    base = "eden-mcp"
    try:
        from eden_client.claude import latest_session_id

        sid = latest_session_id(plugin.home)
        if sid:
            return sid
    except Exception:  # noqa: BLE001
        pass
    if agent:
        tag = "".join(c for c in agent.lower() if c.isalnum() or c in "-_")[:24]
        if tag:
            base = f"{base}-{tag}"
    try:
        # Minting writes the state file once (session_id so latest_session_id finds us);
        # writing every call would keep our mtime newest and drown a real hook session.
        if not plugin._state_path(base).exists():
            with plugin._locked_state(base):
                pass
    except Exception:  # noqa: BLE001
        pass
    return base


def _queued(plugin, client, sid):
    """Queued packets plus any a sibling hook stashed for a channel-less event. Falls back
    to the live queue."""
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
    agent = {"name": None}
    try:
        from eden_client.hermes import _joined

        sid = _session_id(plugin, None)
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
                info = (msg.get("params") or {}).get("clientInfo") or {}
                if isinstance(info.get("name"), str) and info["name"].strip():
                    agent["name"] = info["name"].strip()[:40]
                try:
                    # A pull-only session is not born of a hook: tell Eden it exists. The
                    # observe may return the session's first packet — stash it, or the server
                    # marks it delivered and neither tool can retrieve it.
                    sid0 = _session_id(plugin, agent["name"])
                    c0 = plugin.client(sid0)
                    if c0 is not None:
                        res = c0.observe({"kind": "session_start"}, wait_ms=0)
                        if isinstance(res, dict) and res.get("injection"):
                            with plugin._locked_state(sid0) as state:
                                state.setdefault("stashed", []).append(res["injection"])
                except Exception:  # noqa: BLE001
                    pass
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
                    sid = _session_id(plugin, agent["name"])
                    if sid:
                        client = clients.get(sid) or plugin.client(sid)
                        if client is not None:
                            clients[sid] = client
                        if name == "pending_context":
                            answer = _queued(plugin, client, sid)
                        elif name == "ask_context":
                            question = str(args.get("question") or "")
                            item = args.get("item")
                            answer = plugin.ask_context(
                                {"question": question,
                                 **({"item": item} if isinstance(item, str) else {})},
                                session_id=sid)
                            # The queue's packets ride the reply: an agent on MCP alone
                            # has no other channel.
                            pushed = _queued(plugin, client, sid)
                            answer = "\n\n".join(t for t in (answer, pushed) if t)
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
