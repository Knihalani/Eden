"""Eden for Claude Code (D1992): the same contract as ``eden_client.hermes``, adapted to a
harness that runs every hook in its own process — nothing survives between events, so
dedup state lives in a small JSON file per session under ``<claude-home>/eden/state/``.

Used by ``examples/claude-code``:

- ``session_start`` -> ``session_start`` (wait 0);
- ``user_prompt_submit`` -> the ``user_message`` (waits for its lookup) and the packet, if any,
  as the hook's ``additionalContext``; a question-shaped message with no packet gets the ask hint;
- ``pre_tool_use`` -> the ``tool_call`` (wait 0) plus the party check: a ``finding`` returns the
  held result for the hook to deny with, reported like a ``tool_result`` the agent saw;
- ``post_tool_use`` -> the ``tool_result`` (wait 0);
- ``stop`` -> the turn's last reply, read from the transcript, reported once per copy;
- ``session_end`` -> ``end_session`` and the state file removed.

Everything fails open (D14): a hook that errors returns ``None`` and Claude Code proceeds.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Optional

from . import held_result
from .hermes import ASK_HINT, QUESTION, EdenHermes, _is_ask, _joined

STATE_DIR = "state"


def _key(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:32]


class EdenClaude(EdenHermes):
    """Per-event Eden calls with on-disk dedup; ``home`` is the agent's own (e.g. ``~/.claude``)."""

    def _in_scope(self) -> bool:
        # Each hook is its own process; there is no separate launch home to mismatch.
        return self._enabled

    def _state_path(self, session_id: Any) -> Path:
        return self._home / "eden" / STATE_DIR / f"{_key(str(session_id))}.json"

    def _load(self, session_id: Any) -> Dict[str, Any]:
        try:
            return json.loads(self._state_path(session_id).read_text())
        except Exception:  # noqa: BLE001
            return {"copies": {}, "reported": []}

    def _save(self, session_id: Any, state: Dict[str, Any]) -> None:
        try:
            path = self._state_path(session_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            # Bounded: keys roll over so the file stays small across long sessions.
            state["reported"] = state.get("reported", [])[-400:]
            state["copies"] = dict(list(state.get("copies", {}).items())[-400:])
            path.write_text(json.dumps(state))
        except Exception:  # noqa: BLE001
            pass

    # -- events (each returns the hook's payload or None: fail open) ----------------------------------

    def session_start(self, session_id: Any = None, **_: Any) -> None:
        try:
            c = self.client(session_id)
            if c is not None:
                c.observe({"kind": "session_start"}, wait_ms=0)
        except Exception:  # noqa: BLE001
            pass
        return None

    def prompt(self, session_id: Any = None, text: Any = None, **_: Any) -> Optional[Dict[str, str]]:
        """The user message: waits for its lookup; returns ``{"context": ...}`` for the hook."""
        try:
            if not isinstance(text, str) or not text.strip() or not self._in_scope():
                return None
            c = self.client(session_id)
            if c is None:
                return None
            state = self._load(session_id)
            ck = _key(text)
            copies = state["copies"]
            copies[ck] = copies.get(ck, 0) + 1
            seen_key = f"{ck}#{copies[ck]}"
            got = []
            if seen_key not in state["reported"]:
                state["reported"].append(seen_key)
                res = c.observe({"kind": "user_message", "text": text})
                got += c.collect(res.get("injection") if isinstance(res, dict) else None)
            got += c.pending()
            self._save(session_id, state)
            joined = _joined(got)
            if not joined and self.ask_hint and QUESTION.search(text):
                return {"context": ASK_HINT}
            return {"context": joined} if joined else None
        except Exception:  # noqa: BLE001
            return None

    def pre_tool(self, tool_name: Any = None, tool_input: Any = None, tool_use_id: Any = None,
                 session_id: Any = None, **_: Any) -> Optional[Dict[str, str]]:
        """The call is reported (once per tool_use_id); a finding returns ``{"deny": held}``."""
        try:
            if not self._in_scope():
                return None
            c = self.client(session_id)
            if c is None:
                return None
            state = self._load(session_id)
            uid = str(tool_use_id or _key(f"{tool_name}:{tool_input}"))
            if uid not in state["reported"]:
                state["reported"].append(uid)
                c.observe({"kind": "tool_call", "tool": tool_name, "input": tool_input or {}}, wait_ms=0)
            self._save(session_id, state)
            if not self.checks(tool_name):
                return None
            res = c.check(tool_name, tool_input if tool_input is not None else {})
            finding = res.get("finding") if isinstance(res, dict) and res.get("verdict") == "finding" else None
            if not isinstance(finding, dict) or not isinstance(finding.get("text"), str):
                return None
            held = held_result(tool_name, finding)
            # The agent sees the denial: reported like the tool_result it would have been.
            c.observe({"kind": "tool_result", "tool": tool_name, "output": held}, wait_ms=0)
            return {"deny": held}
        except Exception:  # noqa: BLE001
            return None

    def post_tool(self, tool_name: Any = None, result: Any = None, tool_use_id: Any = None,
                  session_id: Any = None, **_: Any) -> None:
        try:
            if not self._in_scope() or _is_ask(str(tool_name or "")) or not tool_name:
                return None
            c = self.client(session_id)
            if c is None:
                return None
            state = self._load(session_id)
            uid = f"result:{tool_use_id or _key(str(result))}"
            if uid in state["reported"]:
                return None
            state["reported"].append(uid)
            self._save(session_id, state)
            output = result if isinstance(result, str) else json.dumps(result, default=str)
            c.observe({"kind": "tool_result", "tool": tool_name, "output": output}, wait_ms=0)
        except Exception:  # noqa: BLE001
            pass
        return None

    def stop(self, session_id: Any = None, transcript_path: Any = None, **_: Any) -> None:
        """The turn's last reply, read from the transcript: reported once per copy."""
        try:
            if not self._in_scope() or not isinstance(transcript_path, str):
                return None
            c = self.client(session_id)
            if c is None:
                return None
            assistant_texts = []
            for line in Path(transcript_path).read_text(errors="replace").splitlines():
                try:
                    row = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                if row.get("type") != "assistant":
                    continue
                content = (row.get("message") or {}).get("content") or []
                text = "\n".join(b.get("text", "") for b in content
                                 if isinstance(b, dict) and b.get("type") == "text")
                if text.strip():
                    assistant_texts.append(text)
            if not assistant_texts:
                return None
            last = assistant_texts[-1]
            ck = _key(last)
            copy_n = sum(1 for t in assistant_texts if _key(t) == ck)
            state = self._load(session_id)
            seen_key = f"{ck}#{copy_n}"
            if seen_key in state["reported"]:
                return None
            state["reported"].append(seen_key)
            self._save(session_id, state)
            c.observe({"kind": "agent_message", "text": last}, wait_ms=0)
        except Exception:  # noqa: BLE001
            pass
        return None

    def session_end(self, session_id: Any = None, **_: Any) -> None:
        try:
            sid = self.session_key(session_id)
            if sid is not None:
                self.end_session(sid)
            self._state_path(session_id).unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        return None


def dispatch(plugin: EdenClaude, event: str, payload: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Map a Claude Code hook event name to the plugin call."""
    sid = payload.get("session_id")
    if event == "session_start":
        plugin.session_start(sid)
    elif event == "user_prompt_submit":
        return plugin.prompt(sid, payload.get("prompt"))
    elif event == "pre_tool_use":
        return plugin.pre_tool(payload.get("tool_name"), payload.get("tool_input"),
                               payload.get("tool_use_id"), sid)
    elif event == "post_tool_use":
        plugin.post_tool(payload.get("tool_name"), payload.get("tool_response"),
                         payload.get("tool_use_id"), sid)
    elif event == "stop":
        plugin.stop(sid, payload.get("transcript_path"))
    elif event == "session_end":
        plugin.session_end(sid)
    return None
