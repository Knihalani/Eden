"""Eden for Devin CLI / Devin Local (Devin Desktop's agent): the per-process contract on
Devin's ``hooks.v1.json`` events. Each hook is its own process — dedup lives in the on-disk
state file under ``<devin-home>/eden/state/``, and the shared local server outlives it
(``EdenGemini``'s mechanics; Devin's ``PreToolUse`` carries no ``tool_use_id``, so the
copy-counted fallback makes identical repeats their own event).

Event map (argv names on ``eden-hook.py``):

- ``session_start`` (SessionStart) -> ``session_start``; ``source`` (``startup``/``resume``)
  passes through;
- ``user_prompt_submit`` (UserPromptSubmit) -> the ``user_message`` (waits for its lookup);
  the packet comes back as ``hookSpecificOutput.additionalContext``;
- ``pre_tool_use`` (PreToolUse) -> the ``tool_call`` plus the party check; a finding denies
  as ``decision: "block"``;
- ``post_tool_use`` (PostToolUse) -> the ``tool_result`` (``tool_response``'s ``output``,
  or its ``error`` when the call failed);
- ``post_compaction`` (PostCompaction) -> ``context_reset``;
- ``session_end`` (SessionEnd) -> ``end_session`` and the state file removed (local only —
  cloud sessions never fire it, so their state file simply outlives the session).

``Stop`` is skipped: it carries only ``stop_hook_active`` — no reply text or transcript —
so an agent's final reply goes unreported here (the prompt and every tool event still
report). ``PermissionRequest`` is likewise skipped: the party check denies at
``pre_tool_use`` and a second check at permission time would re-report the same call.
Everything fails open (D14).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .gemini import EdenGemini


class EdenDevinCli(EdenGemini):
    """The per-process mechanics on Devin's config home (``~/.config/devin``)."""


def _tool_result(response: Any) -> Any:
    """tool_response is {success, output, error}; the result the agent saw is output, or the
    error when the call failed."""
    if isinstance(response, dict):
        if response.get("success") is False and response.get("error"):
            return response["error"]
        if "output" in response:
            return response["output"]
    return response


def dispatch(plugin: EdenDevinCli, event: str, payload: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Map a Devin hook event (the hook's argv name) to the plugin call."""
    sid = payload.get("session_id")
    if event == "session_start":
        plugin.session_start(sid, source=payload.get("source"))
    elif event == "user_prompt_submit":
        return plugin.prompt(sid, payload.get("prompt"))
    elif event == "pre_tool_use":
        return plugin.pre_tool(payload.get("tool_name"), payload.get("tool_input"), None, sid)
    elif event == "post_tool_use":
        return plugin.post_tool(payload.get("tool_name"),
                                _tool_result(payload.get("tool_response")), None, sid)
    elif event == "post_compaction":
        plugin.compress(sid)
    elif event == "session_end":
        plugin.session_end(sid)
    return None
