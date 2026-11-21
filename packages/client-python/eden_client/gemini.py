"""Eden for Gemini CLI: the Claude Code contract (``eden_client.claude``) adapted to Gemini's
hook events. Like Claude Code every hook is its own process — dedup lives in the same on-disk
state file under ``<gemini-home>/eden/state/``, and the shared local server outlives it.

Event map (argv names on ``eden-hook.py``):

- ``session_start`` (SessionStart) -> ``session_start``; source ``clear`` resets delivery marks
  first (D2006), as Claude's ``compact``/``clear`` do;
- ``before_agent`` (BeforeAgent) -> the ``user_message`` (waits for its lookup) and the packet as
  ``additionalContext``;
- ``before_tool`` (BeforeTool) -> the ``tool_call`` plus the party check; a finding denies;
- ``after_tool`` (AfterTool) -> the ``tool_result``;
- ``after_agent`` (AfterAgent) -> the turn's final reply (``prompt_response``) once per copy;
- ``pre_compress`` (PreCompress) -> ``context_reset``: Gemini's own compaction signal;
- ``session_end`` (SessionEnd) -> ``end_session`` and the state file removed;
- ``notification`` -> ignored.

Everything fails open (D14): a hook that errors returns ``None`` and the CLI proceeds.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .claude import EdenClaude, _key


class EdenGemini(EdenClaude):
    """The Claude adapter's per-process mechanics on Gemini's home (``~/.gemini``)."""

    def pre_tool(self, tool_name: Any = None, tool_input: Any = None, tool_use_id: Any = None,
                 session_id: Any = None, **_: Any) -> Optional[Dict[str, str]]:
        # BeforeTool carries no call id (Claude's ``tool_use_id``): an identical repeat call must
        # still report as its own event, so the dedup uid counts prior copies from the state file.
        if tool_use_id is None:
            try:
                base = _key(f"{tool_name}:{tool_input}")
                state = self._load(session_id)
                n = sum(1 for r in state.get("reported", [])
                        if isinstance(r, str) and r.split("#")[0] == base)
                tool_use_id = f"{base}#{n}"
            except Exception:  # noqa: BLE001
                pass
        return super().pre_tool(tool_name, tool_input, tool_use_id, session_id)

    def reply(self, session_id: Any = None, text: Any = None, **_: Any) -> None:
        """The turn's final answer (AfterAgent's ``prompt_response``): reported once per copy."""
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
                seen_key = f"a:{ck}#{copies[ck]}"
                if seen_key in state["reported"]:
                    return None
                state["reported"].append(seen_key)
                res = c.observe({"kind": "agent_message", "text": text}, wait_ms=0)
                self._stash(state, c, res)
        except Exception:  # noqa: BLE001
            pass
        return None

    def compress(self, session_id: Any = None, **_: Any) -> None:
        """PreCompress: the transcript is being compacted — drop the delivery marks (D2006)."""
        try:
            c = self.client(session_id)
            if c is not None:
                c.observe({"kind": "context_reset"}, wait_ms=0)
        except Exception:  # noqa: BLE001
            pass
        return None


def dispatch(plugin: EdenGemini, event: str, payload: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Map a Gemini CLI hook event (the hook's argv name) to the plugin call."""
    sid = payload.get("session_id")
    if event == "session_start":
        plugin.session_start(sid, source=payload.get("source"))
    elif event == "before_agent":
        return plugin.prompt(sid, payload.get("prompt"))
    elif event == "before_tool":
        return plugin.pre_tool(payload.get("tool_name"), payload.get("tool_input"), None, sid)
    elif event == "after_tool":
        resp = payload.get("tool_response") or {}
        # `llmContent` is what the model saw; `returnDisplay` is the UI form. No call id either.
        result = resp.get("llmContent") or resp.get("returnDisplay") or resp
        return plugin.post_tool(payload.get("tool_name"), result, None, sid)
    elif event == "after_agent":
        plugin.reply(sid, payload.get("prompt_response"))
    elif event == "pre_compress":
        plugin.compress(sid)
    elif event == "session_end":
        plugin.session_end(sid)
    return None
