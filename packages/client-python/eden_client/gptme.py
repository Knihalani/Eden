"""Eden as a gptme plugin (D1990): a package under ``~/.config/gptme/plugins/eden/`` whose ``hooks/`` and
``tools/`` modules delegate here.

gptme's surface differs from Hermes': ``GENERATION_PRE`` hook messages reach only that one model call
(they join a transient ``generation_msgs`` copy, never the log), so packets are re-yielded every
generation until ``TURN_POST`` appends them to the log — after that they ride along in history. The
party check runs on ``TOOL_EXECUTE_PRE`` plus ``TOOL_CONFIRM``: a pre-hook finding is stashed per call
and the confirm hook returns ``ConfirmationResult.skip`` with the held result for the tools that
route through confirmation (``shell``, ``save``, ``patch``…); tools that never confirm cannot be
denied — their finding is still reported.

- ``eden.generation`` (``GENERATION_PRE``): each fresh message reported — the latest ``user_message``
  waits for its lookup, everything else waits 0 — and every un-persisted packet yielded as ``system``
  messages so context stays live through the turn's tool loop.
- ``eden.tool_pre`` (``TOOL_EXECUTE_PRE``): the call reported, then checked; a finding's held result
  is reported (Eden sees what the agent would see) and stashed for ``eden.tool_confirm``.
- ``eden.tool_confirm`` (``TOOL_CONFIRM``): returns ``ConfirmationResult.skip`` on a stashed finding,
  ``None`` otherwise so user consent hooks still run.
- ``eden.tool_post`` (``TOOL_EXECUTE_POST``): the tool's result reported, deduped by call.
- ``eden.turn`` (``TURN_POST``): the turn's last assistant message reported; un-persisted packets
  appended to the log so later turns keep them.
- ``eden.session_*`` (``SESSION_START``/``SESSION_END``): the session's start reported, its end dropped.
- ``ask_context`` (tool): answered by ``EdenClient.ask``; never reported, never checked.

Each gptme logdir is its own Eden session (``session_id`` through ``eden_id``). Fails open (D14): Eden down
or erroring never stops gptme — hooks yield nothing, a failed check runs the tool.
"""

from __future__ import annotations

import hashlib
import json
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
        self._delivered: Dict[str, List[str]] = {}
        self._persisted: Dict[str, set] = {}
        self._held: Dict[int, str] = {}

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
        if isinstance(value, dict):
            for k in ("logdir", "log"):
                if value.get(k) is not None:
                    found = EdenGptme._sid(value[k])
                    if found:
                        return found
        for attr in ("logdir", "log"):
            inner = getattr(value, attr, None)
            if inner is not None:
                found = EdenGptme._sid(inner)
                if found:
                    return found
        for attr in ("persisted_path", "path"):
            inner = getattr(value, attr, None)
            if isinstance(inner, (str, Path)) and inner:
                # <logdir>/conversation.jsonl: the conversation id is the parent directory's name.
                found = Path(inner).parent.name
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

    def generation(self, messages: List[Any], session_id: Any = None) -> List[str]:
        """``GENERATION_PRE``: report fresh messages, return the un-persisted packet texts to yield.

        ``GENERATION_PRE`` context joins a transient copy of the log, so every packet the session has
        delivered but not yet persisted is returned again each call — the packet stays live through
        the turn's tool loop. ``persist`` moves them into the log at ``TURN_POST``.
        """
        try:
            if not self._in_scope():
                return []
            sid = self._session_id(session_id)
            c = self.client(sid)
            if c is None:
                return []
            seen = self._seen_for(sid)
            first = sid not in self._first
            roles = [getattr(m, "role", "") for m in messages]
            last_user = len(roles) - 1 - roles[::-1].index("user") if "user" in roles else -1
            got: List[Any] = []
            copies: Dict[str, int] = {}
            for i, m in enumerate(messages):
                if getattr(m, "role", "") == "system":
                    continue
                h = _key_of(m)
                n = copies.get(h, 0)
                copies[h] = n + 1
                key = f"{h}#{n}"  # the Nth copy of identical content is its own message
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
            fresh = [i["text"] for i in got if isinstance(i, dict) and isinstance(i.get("text"), str)]
            fresh = [t for t in fresh if t.strip()]
            if fresh:
                self._delivered.setdefault(sid, []).extend(t for t in fresh if t not in self._delivered.get(sid, []))
            return self._unpersisted(sid)
        except Exception as e:  # noqa: BLE001
            _warn(f"generation: {e}")
            return []

    def _unpersisted(self, sid: str) -> List[str]:
        persisted = self._persisted.setdefault(sid, set())
        return [t for t in self._delivered.get(sid, []) if t not in persisted]

    def persist(self, session_id: Any = None) -> List[str]:
        """``TURN_POST``: the packet texts to append to the log; afterwards they ride along in history."""
        try:
            sid = self._session_id(session_id)
            texts = self._unpersisted(sid)
            self._persisted.setdefault(sid, set()).update(texts)
            return texts
        except Exception as e:  # noqa: BLE001
            _warn(f"persist: {e}")
            return []

    def turn_end(self, messages: List[Any], session_id: Any = None) -> None:
        """``TURN_POST``: report the turn's last assistant message if it is new."""
        try:
            if not self._in_scope():
                return None
            sid = self._session_id(session_id)
            seen = self._seen_for(sid)
            copies: Dict[str, int] = {}
            key = ""
            for m in messages:
                if getattr(m, "role", "") == "system":
                    continue
                h = _key_of(m)
                n = copies.get(h, 0)
                copies[h] = n + 1
                if getattr(m, "role", "") == "assistant":
                    key = f"{h}#{n}"
            if not key or key in seen:
                return None
            last = next((m for m in reversed(messages) if getattr(m, "role", "") == "assistant"), None)
            if last is None:
                return None
            seen[key] = 1
            c = self.client(sid)
            if c is None:
                return None
            self._report(c, _events_of(last), False)
        except Exception as e:  # noqa: BLE001
            _warn(f"turn_end: {e}")
        return None

    def tool_pre(self, tool_use: Any, session_id: Any = None) -> Optional[str]:
        """``TOOL_EXECUTE_PRE``: report the call, then stash the deny reason on a finding (else ``None``).

        ``tool_use`` is gptme's ToolUse (or any object with ``tool``/``content``/``args``/``kwargs``);
        a finding is keyed by the object so ``tool_confirm`` — which fires mid-execution on the same
        ToolUse — can skip with the held result.
        """
        tool_name = getattr(tool_use, "tool", None) or getattr(tool_use, "name", None)
        try:
            if not self._in_scope() or not _is_tool(tool_name) or _is_ask(tool_name):
                return None
            tool_input: Dict[str, Any] = {}
            for field in ("content", "args", "kwargs"):
                value = getattr(tool_use, field, None)
                if value is not None:
                    tool_input[field] = value
            c = self.client(self._session_id(session_id))
            if c is None:
                return None
            c.observe({"kind": "tool_call", "tool": tool_name, "input": tool_input}, wait_ms=0)
            if not self.checks(tool_name):
                return None
            res = c.check(tool_name, tool_input)
            finding = res.get("finding") if isinstance(res, dict) and res.get("verdict") == "finding" else None
            if not isinstance(finding, dict) or not isinstance(finding.get("text"), str):
                return None
            held = held_result(tool_name, finding)
            c.observe({"kind": "tool_result", "tool": tool_name, "output": held}, wait_ms=0)
            self._held[id(tool_use)] = held
            return held
        except Exception as e:  # noqa: BLE001
            _warn(f"tool_pre: {e}")
            return None

    def tool_confirm(self, tool_use: Any) -> Optional[str]:
        """``TOOL_CONFIRM``: the held result for this call's stashed finding (else ``None``)."""
        try:
            return self._held.pop(id(tool_use), None)
        except Exception:  # noqa: BLE001
            return None

    def tool_post(self, tool_use: Any, output: Any, session_id: Any = None) -> None:
        """``TOOL_EXECUTE_POST``: report the result, deduped with whatever the log already reported."""
        self._held.pop(id(tool_use), None)
        tool_name = getattr(tool_use, "tool", None) or getattr(tool_use, "name", None)
        try:
            if not self._in_scope() or not _is_tool(tool_name) or _is_ask(tool_name):
                return None
            c = self.client(self._session_id(session_id))
            if c is None:
                return None
            text = output if isinstance(output, str) else (_message_text(output) or json.dumps(output, default=str))
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
            sid = self._session_id(session_id)
            # The next identity on this logdir is a new session: its dedup and first-call state reset.
            self._seen.pop(sid, None)
            self._first.pop(sid, None)
            self._delivered.pop(sid, None)
            self._persisted.pop(sid, None)
            self._held.clear()
            self.end_session(session_id=sid)
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
