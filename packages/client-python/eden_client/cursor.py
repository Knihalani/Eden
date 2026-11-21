"""Eden for Cursor's agent (the CLI and editor chat): the Claude Code contract adapted to
Cursor's `hooks.json` events. Each hook is its own process — dedup lives in the same on-disk
state file under ``<cursor-home>/eden/state/``, and the shared local server outlives it
(``EdenGemini``'s mechanics, which Cursor's real ``tool_use_id`` makes exact: its copy-counted
fallback simply never runs).

Event map (argv names on ``eden-hook.py``):

- ``session_start`` (sessionStart) -> ``session_start``. ``/clear`` fires neither sessionEnd
  nor sessionStart upstream — the next ``beforeSubmitPrompt`` arrives on a new
  ``conversation_id``, which is a new session and a fresh dedup file on its own;
- ``before_submit_prompt`` (beforeSubmitPrompt) -> the ``user_message`` (waits for its lookup);
  the packet comes back as ``additional_context``;
- ``pre_tool_use`` (preToolUse) -> the ``tool_call`` plus the party check; a finding denies;
- ``post_tool_use`` (postToolUse) -> the ``tool_result`` (``tool_output`` is a JSON string);
- ``post_tool_use_failure`` -> the failure reported as the ``tool_result`` (the call's real
  outcome — error, timeout or denied);
- ``after_agent_response`` -> the assistant message (``text``) once per copy;
- ``pre_compact`` -> ``context_reset`` (observational, before summarization);
- ``session_end`` -> ``end_session`` and the state file removed.

``beforeShellExecution``/``beforeMCPExecution`` and the ``after*`` family are skipped on
purpose: ``preToolUse``/``postToolUse`` fire for every tool including Shell and MCP — wiring the
pairs too would double-report each call. ``stop`` is likewise covered by ``afterAgentResponse``,
which carries the reply text directly (no transcript read). Everything fails open (D14).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .gemini import EdenGemini


class EdenCursor(EdenGemini):
    """The Gemini adapter's per-process mechanics on Cursor's home (``~/.cursor``)."""


def dispatch(plugin: EdenCursor, event: str, payload: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Map a Cursor hook event (the hook's argv name) to the plugin call."""
    sid = payload.get("conversation_id")
    if event == "session_start":
        plugin.session_start(sid)
    elif event == "before_submit_prompt":
        return plugin.prompt(sid, payload.get("prompt"))
    elif event == "pre_tool_use":
        return plugin.pre_tool(payload.get("tool_name"), payload.get("tool_input"),
                               payload.get("tool_use_id"), sid)
    elif event == "post_tool_use":
        return plugin.post_tool(payload.get("tool_name"), payload.get("tool_output"),
                                payload.get("tool_use_id"), sid)
    elif event == "post_tool_use_failure":
        result = {"failure_type": payload.get("failure_type"),
                  "error": payload.get("error_message")}
        return plugin.post_tool(payload.get("tool_name"), result,
                                payload.get("tool_use_id"), sid)
    elif event == "after_agent_response":
        plugin.reply(sid, payload.get("text"))
    elif event == "pre_compact":
        plugin.compress(sid)
    elif event == "session_end":
        plugin.session_end(sid)
    return None
