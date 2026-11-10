"""Eden as a Hermes Agent plugin, in the measured ``hermes-eden`` shape (D422): Eden's ``ask_context`` in place of the
agent's source tools, Eden's packet before each turn, and each acting call checked first.

Install (docs/INTEGRATION.md, "Hermes Agent"): ``pip install`` this package into Hermes' environment, copy
``examples/hermes/eden`` to ``~/.hermes/plugins/eden``, enable it (``plugins: enabled: [eden]``) and give the agent
the ``eden`` toolset instead of your source MCP servers. Configuration comes from the environment:

- ``EDEN_USER_ID`` (required; mapped with ``eden_id``): the end user whose sources Eden reads. Unset, the plugin
  registers nothing and says so once.
- ``EDEN_URL`` (default ``http://127.0.0.1:8790``), ``EDEN_API_KEY``, ``EDEN_TENANT_ID``: as for ``EdenClient``.
- ``EDEN_CHECK_TOOLS``: which tool calls go through ``check`` first: ``*`` (the default: every tool but Eden's own),
  a comma list of tool names, or empty to check none.

What it registers (hook names and contracts as Hermes defines them at the lab's pin, 06433066; read in its source,
``hermes_cli/plugins.py`` and ``model_tools.py``, not run here):

- ``pre_llm_call``: the user's message goes to Eden (``observe``, waiting up to 3 s as the client does) and the
  turn's packet, if any, is returned as ``{"context": ...}``. Only the new packet: Hermes stores the context it sent
  on the turn's message and sends it again on later calls and turns (A27, D385), so re-sending would repeat it.
- ``pre_tool_call``: a checked tool's call goes to ``check``; a finding blocks the call and its ``held_result``
  becomes the tool's result (``{"action": "block", "message": ...}``). Calling again with the same arguments proceeds.
- ``post_tool_call`` / ``transform_tool_result``: each tool result is reported, and packets Eden queued since are
  appended to it, so context found mid-turn reaches the agent before its next model call.
- ``ask_context`` (toolset ``eden``), with Eden's own description (D70), answered by ``EdenClient.ask``.
- ``on_session_end``: the session's end is reported and its client dropped.

Each Hermes session is its own Eden session (``session_id`` through ``eden_id``). Fails open (D14): any error,
timeout or refusal is "no context" and never breaks the agent's turn.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from collections import OrderedDict
from typing import Any, Callable, Dict, Optional

from . import ASK_CONTEXT_DESCRIPTION, EdenClient, eden_id, held_result

#: Eden's own tool. Its answers are Eden's, so they are neither checked nor reported back.
ASK_TOOL = "ask_context"
#: The Hermes toolset the ask tool is registered in; give the agent this one in place of the source toolsets.
TOOLSET = "eden"
#: Hermes sessions with a live client; the least recent is dropped past this.
MAX_SESSIONS = 256

ASK_SCHEMA = {
    "name": ASK_TOOL,
    "description": ASK_CONTEXT_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {"question": {"type": "string", "description": "The question, in your own words."}},
        "required": ["question"],
    },
}


def _warn(message: str) -> None:
    try:
        print(f"[eden] {message}", file=sys.stderr)
    except Exception:  # noqa: BLE001
        pass


class EdenHermes:
    """The plugin's state: one ``EdenClient`` per Hermes session. ``client_factory`` is for tests."""

    def __init__(self, env: Optional[Dict[str, str]] = None,
                 client_factory: Optional[Callable[..., Any]] = None) -> None:
        env = dict(os.environ if env is None else env)
        raw_user = (env.get("EDEN_USER_ID") or "").strip()
        self.user = eden_id(raw_user) if raw_user else None
        self.tenant = (env.get("EDEN_TENANT_ID") or "").strip() or None
        self.base_url = (env.get("EDEN_URL") or "").strip() or None
        self.api_key = env.get("EDEN_API_KEY") or None
        tools = env.get("EDEN_CHECK_TOOLS", "*")
        self.check_all = tools.strip() == "*"
        self.check_tools = {t.strip() for t in tools.split(",") if t.strip()} if not self.check_all else set()
        self._factory = client_factory or EdenClient
        self._clients: "OrderedDict[str, Any]" = OrderedDict()
        self._lock = threading.Lock()

    def client(self, session_id: Any) -> Optional[Any]:
        """The session's client, made on first use; None when there is no user (the plugin is then inert)."""
        if not self.user:
            return None
        sid = eden_id(str(session_id)) if session_id else "hermes"
        with self._lock:
            c = self._clients.get(sid)
            if c is not None:
                self._clients.move_to_end(sid)
                return c
        try:
            c = self._factory(user_id=self.user, session_id=sid, api_key=self.api_key, tenant_id=self.tenant,
                              base_url=self.base_url, on_error=lambda e: _warn(str(e)))
        except Exception as e:  # noqa: BLE001
            _warn(f"could not make a client: {e}")
            return None
        with self._lock:
            self._clients[sid] = c
            while len(self._clients) > MAX_SESSIONS:
                self._clients.popitem(last=False)
        return c

    def checks(self, tool_name: Any) -> bool:
        if not isinstance(tool_name, str) or tool_name == ASK_TOOL or tool_name.endswith("_" + ASK_TOOL):
            return False
        return self.check_all or tool_name in self.check_tools

    # -- hooks (each returns None on anything unexpected: fail open) ------------------------------------------------

    def pre_llm_call(self, session_id: Any = None, user_message: Any = None, **_: Any) -> Optional[Dict[str, str]]:
        try:
            if not isinstance(user_message, str) or not user_message.strip():
                return None
            c = self.client(session_id)
            if c is None:
                return None
            res = c.observe({"kind": "user_message", "text": user_message})
            text = _joined(c.collect(res.get("injection") if isinstance(res, dict) else None))
            return {"context": text} if text else None
        except Exception as e:  # noqa: BLE001
            _warn(f"pre_llm_call: {e}")
            return None

    def pre_tool_call(self, tool_name: Any = None, args: Any = None, session_id: Any = None,
                      **_: Any) -> Optional[Dict[str, str]]:
        try:
            if not self.checks(tool_name):
                return None
            c = self.client(session_id)
            if c is None:
                return None
            res = c.check(tool_name, args if args is not None else {})
            finding = res.get("finding") if isinstance(res, dict) and res.get("verdict") == "finding" else None
            if not isinstance(finding, dict) or not isinstance(finding.get("text"), str):
                return None
            return {"action": "block", "message": held_result(tool_name, finding)}
        except Exception as e:  # noqa: BLE001
            _warn(f"pre_tool_call: {e}")
            return None

    def post_tool_call(self, tool_name: Any = None, result: Any = None, session_id: Any = None, **_: Any) -> None:
        try:
            if not isinstance(tool_name, str) or tool_name == ASK_TOOL or tool_name.endswith("_" + ASK_TOOL):
                return None
            c = self.client(session_id)
            if c is None:
                return None
            output = result if isinstance(result, str) else json.dumps(result, default=str)
            c.observe({"kind": "tool_result", "tool": tool_name, "output": output})
        except Exception as e:  # noqa: BLE001
            _warn(f"post_tool_call: {e}")
        return None

    def transform_tool_result(self, result: Any = None, session_id: Any = None, **_: Any) -> Optional[str]:
        try:
            if not isinstance(result, str):
                return None
            c = self.client(session_id)
            if c is None:
                return None
            text = _joined(c.pending())
            return f"{result}\n\n{text}" if text else None
        except Exception as e:  # noqa: BLE001
            _warn(f"transform_tool_result: {e}")
            return None

    def on_session_end(self, session_id: Any = None, **_: Any) -> None:
        try:
            if not self.user:
                return None
            sid = eden_id(str(session_id)) if session_id else "hermes"
            with self._lock:
                c = self._clients.pop(sid, None)
            if c is not None:
                c.observe({"kind": "session_end"})
        except Exception as e:  # noqa: BLE001
            _warn(f"on_session_end: {e}")
        return None

    def ask_context(self, args: Any = None, session_id: Any = None, **_: Any) -> str:
        try:
            question = args.get("question") if isinstance(args, dict) else None
            if not isinstance(question, str) or not question.strip():
                return "ask_context needs a question."
            c = self.client(session_id)
            answer = c.ask(question) if c is not None else None
            if isinstance(answer, dict) and isinstance(answer.get("answer"), str):
                return answer["answer"]
        except Exception as e:  # noqa: BLE001
            _warn(f"ask_context: {e}")
        return "No context available."

    def register(self, ctx: Any) -> None:
        if not self.user:
            _warn("EDEN_USER_ID is not set: the Eden plugin registers nothing")
            return
        ctx.register_hook("pre_llm_call", self.pre_llm_call)
        ctx.register_hook("pre_tool_call", self.pre_tool_call)
        ctx.register_hook("post_tool_call", self.post_tool_call)
        ctx.register_hook("transform_tool_result", self.transform_tool_result)
        ctx.register_hook("on_session_end", self.on_session_end)
        ctx.register_tool(name=ASK_TOOL, toolset=TOOLSET, schema=ASK_SCHEMA, handler=self.ask_context,
                          description=ASK_CONTEXT_DESCRIPTION)


def _joined(injections: Any) -> Optional[str]:
    texts = [i["text"] for i in injections or [] if isinstance(i, dict) and isinstance(i.get("text"), str)]
    text = "\n\n".join(t for t in texts if t.strip())
    return text or None


def register(ctx: Any) -> None:
    """Hermes' plugin entry point (``register(ctx)``), configured from the environment."""
    try:
        EdenHermes().register(ctx)
    except Exception as e:  # noqa: BLE001 - a plugin that fails to load must not stop Hermes
        _warn(f"not registered: {e}")
