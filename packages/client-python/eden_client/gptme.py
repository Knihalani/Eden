"""Eden as a gptme plugin (D1990): a package under ``~/.config/gptme/plugins/eden/`` whose ``hooks/`` and
``tools/`` modules delegate here.

gptme's surface differs from Hermes': its hook messages append to the conversation log, so a packet yielded
once stays where it landed — no keep machinery — and the party check runs on ``TOOL_EXECUTE_PRE``'s policy
seam (``data.deny``), not on ``TOOL_CONFIRM``, which owns user consent.

- ``eden.generation`` (``GENERATION_PRE``): each fresh message reported — the latest ``user_message`` waits
  for its lookup, everything else waits 0 — and fresh packets yielded as one ``system`` message.
- ``eden.tool_pre`` (``TOOL_EXECUTE_PRE``): a checked call goes to ``check``; a finding calls ``data.deny``
  with the held result, which is also reported so Eden sees what the agent saw.
- ``eden.tool_post`` (``TOOL_EXECUTE_POST``): the tool's result reported, deduped by call.
- ``eden.turn`` (``TURN_POST``): the turn's last assistant message reported.
- ``eden.session_*`` (``SESSION_START``/``SESSION_END``): the session's start reported, its end dropped.
- ``ask_context`` (tool): answered by ``EdenClient.ask``; never reported, never checked.

Each gptme logdir is its own Eden session (``session_id`` through ``eden_id``). Fails open (D14): Eden down
or erroring never stops gptme — hooks yield nothing, a failed check runs the tool.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import ASK_CONTEXT_DESCRIPTION, held_result
from .hermes import ASK_SCHEMA, ASK_TOOL, EdenHermes, _is_ask, _is_tool, _warn

#: Fresh-message keys retained per session before the oldest drop (same bound as the TS adapters).
MAX_SEEN = 4_000
#: The gptme session key when a hook gives no logdir.
DEFAULT_SESSION = "default"

_DEFAULT_HOME = Path.home() / ".config" / "gptme"

ASK_FUNCTION = {
    "name": ASK_TOOL,
    "desc": "Ask Eden for context",
    "instructions": ASK_CONTEXT_DESCRIPTION,
}


def _gptme_home(env: Optional[Dict[str, str]] = None) -> Path:
    env = os.environ if env is None else env
    return Path(env.get("GPTME_HOME") or _DEFAULT_HOME).expanduser().resolve()


def _message_text(message: Any) -> str:
    content = getattr(message, "content", message)
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        return "\n".join(p for p in (_message_text(c) for c in content) if p)
    return ""


def _key_of(message: Any) -> str:
    role = getattr(message, "role", "")
    h = hashlib.sha256()
    h.update(f"{role}\0{_message_text(message)}".encode())
    return h.hexdigest()[:32]


class EdenGptme(EdenHermes):
    """The plugin's state: one ``EdenClient`` per gptme logdir. ``client_factory`` is for tests."""

    def __init__(self, env: Optional[Dict[str, str]] = None,
                 client_factory=None, *, plugin_file=None, home=None) -> None:
        super().__init__(env, client_factory, plugin_file=plugin_file,
                         home=home or _gptme_home(env))
        self._seen: "OrderedDict[str, OrderedDict[str, int]]" = OrderedDict()
        self._first: Dict[str, bool] = {}
        self._current = DEFAULT_SESSION

    def _in_scope(self) -> bool:
        # gptme runs the plugin in its own process; there is no separate launch home to mismatch.
        return self._enabled

    def _seen_for(self, sid: str) -> "OrderedDict[str, int]":
        seen = self._seen.get(sid)
        if seen is None:
            seen = OrderedDict()
            self._seen[sid] = seen
            while len(self._seen) > 64:
                self._seen.popitem(last=False)
        return seen

    @staticmethod
    def _sid(value: Any) -> str:
        """A stable session name from a hook's manager/logdir/workspace."""
        for attr in ("logdir", "log"):
            inner = getattr(value, attr, None)
            if inner is not None:
                found = EdenGptme._sid(inner)
                if found:
                    return found
        if isinstance(value, (str, Path)):
            text = str(value)
            return Path(text).name or DEFAULT_SESSION
        name = getattr(value, "name", None)
        return str(name) if name else ""

    def _session_id(self, *sources: Any) -> str:
        for s in sources:
            found = self._sid(s)
            if found:
                self._current = found
                return found
        return self._current

    def _report(self, client: Any, events: List[Dict[str, Any]], waits: bool) -> List[Any]:
        got: List[Any] = []
        for ev in events:
            res = client.observe(ev) if waits else client.observe(ev, wait_ms=0)
            if isinstance(res, dict) and res.get("injection"):
                got.extend(client.collect(res["injection"]))
        return got

    # -- hook callbacks (tested without gptme: the hooks/ wrappers translate gptme objects to these) -------

    def generation(self, messages: List[Any], session_id: Any = None) -> Optional[str]:
        """``GENERATION_PRE``: report fresh messages, return the packet text to yield (or ``None``)."""
        try:
            if not self._in_scope():
                return None
            c = self.client(self._session_id(session_id))
            if c is None:
                return None
            sid = self._session_id(session_id)
            seen = self._seen_for(sid)
            first = sid not in self._first
            roles = [getattr(m, "role", "") for m in messages]
            last_user = len(roles) - 1 - roles[::-1].index("user") if "user" in roles else -1
            got: List[Any] = []
            for i, m in enumerate(messages):
                if getattr(m, "role", "") == "system":
                    continue
                key = _key_of(m)
                if key in seen:
                    continue
                seen[key] = 1
                if len(seen) > MAX_SEEN:
                    seen.popitem(last=False)
                if first and i < last_user:
                    continue  # a resumed session reports only its latest user message
                waits = getattr(m, "role", "") == "user" and i == last_user
                got.extend(self._report(c, _events_of(m), waits))
            self._first[sid] = True
            got.extend(c.pending())
            texts = [i["text"] for i in got if isinstance(i, dict) and isinstance(i.get("text"), str)]
            text = "\n\n".join(t for t in texts if t.strip())
            return text or None
        except Exception as e:  # noqa: BLE001
            _warn(f"generation: {e}")
            return None

    def turn_end(self, messages: List[Any], session_id: Any = None) -> None:
        """``TURN_POST``: report the turn's last assistant message if it is new."""
        try:
            if not self._in_scope():
                return None
            last = next((m for m in reversed(messages) if getattr(m, "role", "") == "assistant"), None)
            if last is None:
                return None
            sid = self._session_id(session_id)
            seen = self._seen_for(sid)
            key = _key_of(last)
            if key in seen:
                return None
            seen[key] = 1
            c = self.client(sid)
            if c is None:
                return None
            self._report(c, _events_of(last), False)
        except Exception as e:  # noqa: BLE001
            _warn(f"turn_end: {e}")
        return None

    def tool_pre(self, tool_name: Any, tool_input: Any = None, session_id: Any = None) -> Optional[str]:
        """``TOOL_EXECUTE_PRE``: the deny reason on a finding, else ``None`` (the tool runs)."""
        try:
            if not self._in_scope() or not self.checks(tool_name):
                return None
            c = self.client(self._session_id(session_id))
            if c is None:
                return None
            res = c.check(tool_name, tool_input if tool_input is not None else {})
            finding = res.get("finding") if isinstance(res, dict) and res.get("verdict") == "finding" else None
            if not isinstance(finding, dict) or not isinstance(finding.get("text"), str):
                return None
            held = held_result(tool_name, finding)
            c.observe({"kind": "tool_result", "tool": tool_name, "output": held}, wait_ms=0)
            return held
        except Exception as e:  # noqa: BLE001
            _warn(f"tool_pre: {e}")
            return None

    def tool_post(self, tool_name: Any, output: Any, session_id: Any = None) -> None:
        """``TOOL_EXECUTE_POST``: report the result, deduped with whatever the log already reported."""
        try:
            if not self._in_scope() or not _is_tool(tool_name) or _is_ask(tool_name):
                return None
            c = self.client(self._session_id(session_id))
            if c is None:
                return None
            text = output if isinstance(output, str) else _message_text(output)
            c.observe({"kind": "tool_result", "tool": tool_name, "output": text}, wait_ms=0)
        except Exception as e:  # noqa: BLE001
            _warn(f"tool_post: {e}")
        return None

    def session_start(self, session_id: Any = None) -> None:
        try:
            c = self.client(self._session_id(session_id))
            if c is not None:
                c.observe({"kind": "session_start"}, wait_ms=0)
        except Exception as e:  # noqa: BLE001
            _warn(f"session_start: {e}")
        return None

    def session_end(self, session_id: Any = None) -> None:
        try:
            self.end_session(session_id=self._session_id(session_id))
        except Exception as e:  # noqa: BLE001
            _warn(f"session_end: {e}")
        return None

    def ask(self, question: Any) -> str:
        """The ``ask_context`` tool body: the question as a plain string."""
        return self.ask_context({"question": question} if isinstance(question, str) else {},
                                session_id=self._current)


def _events_of(message: Any) -> List[Dict[str, Any]]:
    role = getattr(message, "role", "")
    text = _message_text(message)
    if role == "user":
        return [{"kind": "user_message", "text": text}] if text else []
    if role == "assistant":
        return [{"kind": "agent_message", "text": text}] if text else []
    return []


#: The one plugin instance gptme's hook/tool modules share.
_PLUGIN: Optional[EdenGptme] = None


def plugin() -> EdenGptme:
    global _PLUGIN
    if _PLUGIN is None:
        _PLUGIN = EdenGptme(plugin_file=__file__)
    return _PLUGIN
