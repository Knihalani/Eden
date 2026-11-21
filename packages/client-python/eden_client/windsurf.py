"""Eden for Windsurf Cascade (the legacy agent in Devin Desktop): the Claude Code contract
(``eden_client.claude``) adapted to Cascade's hook events. Every hook is its own process —
dedup lives in the same on-disk state file under ``<windsurf-home>/eden/state/``, and the
shared local server outlives it.

The payload on every hook's stdin is ``{agent_action_name, trajectory_id, execution_id,
timestamp, model_name, tool_info}``; ``trajectory_id`` keys the session.

Event map (``agent_action_name`` values — one payload names its own event):

- ``pre_user_prompt`` -> the ``user_message``: reported and stashed (Cascade shows hook
  stdout only in the UI — a prompt's packet cannot be injected, so it rides the next
  ``post_*`` hook or an MCP ask, like a PreToolUse's stash);
- ``pre_run_command``/``pre_write_code``/``pre_read_code``/``pre_mcp_tool_use`` -> the
  ``tool_call`` plus the party check; a finding exits 2 with the held text on stderr —
  the only channel that reaches the agent;
- ``post_run_command``/``post_write_code``/``post_read_code``/``post_mcp_tool_use`` -> the
  ``tool_result`` (the event's ``tool_info``; ``post_mcp_tool_use`` also carries
  ``mcp_result``), and any stashed packet leaves on stdout for the transcript;
- ``post_cascade_response`` -> the turn's final reply (``tool_info.response``) once per copy;
- ``post_user_prompt``, ``post_setup_worktree``, ``post_cascade_response_with_transcript``
  -> ignored: the prompt is already reported, the response is already reported, and a
  worktree is no agent action.

Cascade has no session lifecycle events: the session starts when the first hook reports it
and ends only when the process tree does — ``session_end`` is never sent (documented gap).

Everything fails open (D14): a hook that errors returns ``None`` and the agent proceeds.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .claude import _key
from .gemini import EdenGemini
from .hermes import _joined


class EdenWindsurf(EdenGemini):
    """The Gemini adapter's per-process mechanics on Cascade's home
    (``~/.codeium/windsurf``)."""

    def prompt_stash(self, session_id: Any = None, text: Any = None, **_: Any) -> None:
        """``pre_user_prompt``: report the message; park the packet it yields — Cascade shows
        hook stdout in the UI only, so the packet waits for the next ``post_*`` hook or an
        MCP ask instead of being collected into a reply the agent never sees."""
        try:
            if not self._in_scope() or not isinstance(text, str) or not text.strip():
                return None
            c = self.client(session_id)
            if c is None:
                return None
            with self._locked_state(session_id) as state:
                ck = _key(text)
                copies = state["copies"]
                copies[ck] = copies.get(ck, 0) + 1
                seen_key = f"u:{ck}#{copies[ck]}"
                if seen_key not in state["reported"]:
                    state["reported"].append(seen_key)
                    res = c.observe({"kind": "user_message", "text": text})
                    got = c.collect(res.get("injection") if isinstance(res, dict) else None)
                    got += c.pending()
                    stash = state.setdefault("stashed", [])
                    for item in got:
                        if item not in stash:
                            stash.append(item)
        except Exception:  # noqa: BLE001
            pass
        return None

    def post_tool_stash_out(self, tool_name: Any = None, result: Any = None,
                            tool_use_id: Any = None, session_id: Any = None,
                            **_: Any) -> Optional[str]:
        """``post_*``: report the result like ``post_tool``, then return the stash's text so
        the hook can echo it — Cascade keeps a post hook's stdout for the transcript."""
        out = super().post_tool(tool_name, result, tool_use_id, session_id)
        if isinstance(out, dict):
            return out.get("context")
        return None


_TOOL_NAMES = {
    "run_command": "run_command",
    "write_code": "write_code",
    "read_code": "read_code",
    "mcp_tool_use": "mcp_tool_use",
}


def _input(tool_info: Any) -> Dict[str, Any]:
    return tool_info if isinstance(tool_info, dict) else {}


def dispatch(plugin: EdenWindsurf, payload: Dict[str, Any]) -> Optional[str]:
    """Map a Cascade hook payload to the plugin call. Returns deny text (the hook exits 2
    with it on stderr) or stdout text for the transcript; ``None`` reports silently."""
    sid = payload.get("trajectory_id")
    event = str(payload.get("agent_action_name") or "")
    info = _input(payload.get("tool_info"))
    uid = payload.get("execution_id")

    if event == "pre_user_prompt":
        plugin.prompt_stash(sid, info.get("user_prompt"))
    elif event in ("pre_run_command", "pre_write_code", "pre_read_code", "pre_mcp_tool_use"):
        name = event[len("pre_"):]
        tool_name = (info.get("mcp_tool_name")
                     if name == "mcp_tool_use" and info.get("mcp_tool_name")
                     else _TOOL_NAMES[name])
        held = plugin.pre_tool(tool_name, info, None, sid)
        if isinstance(held, dict) and held.get("deny"):
            return f"DENY:{held['deny']}"
    elif event in ("post_run_command", "post_write_code", "post_read_code", "post_mcp_tool_use"):
        name = event[len("post_"):]
        tool_name = (info.get("mcp_tool_name")
                     if name == "mcp_tool_use" and info.get("mcp_tool_name")
                     else _TOOL_NAMES[name])
        result = info.get("mcp_result") if name == "mcp_tool_use" and info.get("mcp_result") else info
        return plugin.post_tool_stash_out(tool_name, result, f"{uid}:{event}" if uid else None, sid)
    elif event == "post_cascade_response":
        plugin.reply(sid, info.get("response"))
    return None
