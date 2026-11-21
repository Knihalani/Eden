"""Eden for Qwen Code (the Gemini CLI fork): the same per-process contract on Qwen's
`settings.json` hooks, whose event names and wire shape follow Claude Code's. Each hook is
its own process — dedup lives in the on-disk state file under ``<qwen-home>/eden/state/``,
and the shared local server outlives it (``EdenGemini``'s mechanics; Qwen supplies a real
``tool_use_id``, so the copy-counted fallback never runs).

Event map (argv names on ``eden-hook.py``):

- ``session_start`` (SessionStart) -> ``session_start``; ``source`` passes through so a
  ``clear``/``compact`` start is a fresh session;
- ``user_prompt_submit`` (UserPromptSubmit) -> the ``user_message`` (waits for its lookup);
  the packet comes back as ``hookSpecificOutput.additionalContext``;
- ``pre_tool_use`` (PreToolUse) -> the ``tool_call`` plus the party check; a finding denies
  as ``permissionDecision: "deny"``;
- ``post_tool_use`` (PostToolUse) -> the ``tool_result`` (``tool_response``);
- ``post_tool_use_failure`` (PostToolUseFailure) -> the failure reported as the call's
  result (``error``);
- ``stop`` (Stop) -> the turn's last reply read from ``transcript_path``, once per copy
  (the transcript is Qwen's own JSONL; an unrecognized shape yields no rows, which is the
  fail-open answer);
- ``pre_compact`` (PreCompact) -> ``context_reset``;
- ``session_end`` (SessionEnd) -> ``end_session`` and the state file removed.

``PostToolBatch``, ``UserPromptExpansion`` and ``Notification`` are skipped: each reports
nothing ``preToolUse``/`postToolUse` don't already cover. Everything fails open (D14).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .gemini import EdenGemini


class EdenQwen(EdenGemini):
    """The per-process mechanics on Qwen's home (``~/.qwen``)."""


def dispatch(plugin: EdenQwen, event: str, payload: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Map a Qwen hook event (the hook's argv name) to the plugin call."""
    sid = payload.get("session_id")
    if event == "session_start":
        plugin.session_start(sid, source=payload.get("source"))
    elif event == "user_prompt_submit":
        return plugin.prompt(sid, payload.get("prompt"))
    elif event == "pre_tool_use":
        return plugin.pre_tool(payload.get("tool_name"), payload.get("tool_input"),
                               payload.get("tool_use_id"), sid)
    elif event == "post_tool_use":
        return plugin.post_tool(payload.get("tool_name"), payload.get("tool_response"),
                                payload.get("tool_use_id"), sid)
    elif event == "post_tool_use_failure":
        return plugin.post_tool(payload.get("tool_name"), payload.get("error"),
                                payload.get("tool_use_id"), sid)
    elif event == "stop":
        plugin.stop(sid, transcript_path=payload.get("transcript_path"))
    elif event == "pre_compact":
        plugin.compress(sid)
    elif event == "session_end":
        plugin.session_end(sid)
    return None
