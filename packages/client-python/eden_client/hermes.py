"""Eden as a Hermes Agent plugin (D422), built on the ``hermes-eden`` arm the lab measured: Eden's ``ask_context`` in
place of the agent's source tools and Eden's packet before each turn; plus, unmeasured inside Hermes, a check before
each acting call.

Install (docs/INTEGRATION.md, "Hermes Agent"): ``pip install`` this package into Hermes' environment, copy
``examples/hermes/eden`` to ``~/.hermes/plugins/eden``, enable it (``plugins: enabled: [eden]``) and give the agent
the ``eden`` toolset instead of your source MCP servers. Configuration comes from the environment:

- ``EDEN_USER_ID`` (required; mapped with ``eden_id``): the end user whose sources Eden reads. Unset, the plugin
  registers nothing and says so once.
- ``EDEN_URL`` (default ``http://127.0.0.1:8790``), ``EDEN_API_KEY``, ``EDEN_TENANT_ID``: as for ``EdenClient``.
- ``EDEN_CHECK_TOOLS``: which tool calls go through ``check`` first. Unset: the tools whose name carries an acting
  verb as a whole word, camelCase split (``ACTING``: send, reply, forward, share, invite, book, schedule, pay,
  transfer, grant, post, purchase, order, create, update, add, respond, deploy: ``send_email``, ``sendEmail``,
  ``create_event``, ``mcp_gmail_send_message``, not ``list_messages`` or ``read_file``), which is where the party
  check finds anything (a calendar create or update adds guests); a read-only tool gains nothing from a check and
  would send its arguments to Eden for nothing. A comma list names the tools exactly; ``*`` checks every tool but
  Eden's own; empty checks none.

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
- ``on_session_finalize`` / ``on_session_reset``: the session's end is reported and its client dropped. Not
  ``on_session_end``: Hermes fires that after every turn (``run_conversation``), and ending Eden's session each turn
  would drop its queued packets, its record of what the agent read and its per-session budget.

Each Hermes session is its own Eden session (``session_id`` through ``eden_id``; a hook with no session id falls back
to its ``task_id``, and with neither Eden is skipped, so two conversations never share a session). Fails open (D14):
any error, timeout or refusal is "no context" and never breaks the agent's turn.
"""

from __future__ import annotations

import json
import os
import re
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
#: The default ``EDEN_CHECK_TOOLS``: a tool whose name carries one of these verbs as a word acts on someone's behalf.
ACTING = re.compile(
    r"(?:^|[_\-.])(send|reply|forward|share|invite|invites|book|schedule|pay|transfer|grant|post|purchase|order"
    r"|create|update|add|respond|deploy)(?=$|[_\-.])",
    re.I,
)

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
        tools = env.get("EDEN_CHECK_TOOLS")
        # None: the acting-verb default; "*": every tool; otherwise exactly the names listed (empty: none).
        self.check_mode = "acting" if tools is None else "all" if tools.strip() == "*" else "list"
        self.check_tools = {t.strip() for t in (tools or "").split(",") if t.strip()}
        self._factory = client_factory or EdenClient
        self._clients: "OrderedDict[str, Any]" = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def session_key(session_id: Any, task_id: Any = None) -> Optional[str]:
        """The Eden session id for a hook's ids; None when it has neither (Eden is then skipped for that call)."""
        raw = session_id or task_id
        return eden_id(str(raw)) if raw else None

    def client(self, session_id: Any, task_id: Any = None) -> Optional[Any]:
        """The session's client, made on first use; None when there is no user or no session id."""
        sid = self.session_key(session_id, task_id)
        if not self.user or sid is None:
            return None
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
        if not _is_tool(tool_name) or _is_ask(tool_name):
            return False
        if self.check_mode == "all":
            return True
        if self.check_mode == "list":
            return tool_name in self.check_tools
        # camelCase as words: sendEmail -> send_Email, chat.postMessage -> chat.post_Message.
        return ACTING.search(re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", tool_name)) is not None

    # -- hooks (each returns None on anything unexpected: fail open) ------------------------------------------------

    def pre_llm_call(self, session_id: Any = None, user_message: Any = None, task_id: Any = None,
                     **_: Any) -> Optional[Dict[str, str]]:
        try:
            if not isinstance(user_message, str) or not user_message.strip():
                return None
            c = self.client(session_id, task_id)
            if c is None:
                return None
            res = c.observe({"kind": "user_message", "text": user_message})
            text = _joined(c.collect(res.get("injection") if isinstance(res, dict) else None))
            return {"context": text} if text else None
        except Exception as e:  # noqa: BLE001
            _warn(f"pre_llm_call: {e}")
            return None

    def pre_tool_call(self, tool_name: Any = None, args: Any = None, session_id: Any = None, task_id: Any = None,
                      **_: Any) -> Optional[Dict[str, str]]:
        try:
            if not self.checks(tool_name):
                return None
            c = self.client(session_id, task_id)
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

    def post_tool_call(self, tool_name: Any = None, result: Any = None, session_id: Any = None, task_id: Any = None,
                       **_: Any) -> None:
        try:
            if not _is_tool(tool_name) or _is_ask(tool_name):
                return None
            c = self.client(session_id, task_id)
            if c is None:
                return None
            output = result if isinstance(result, str) else json.dumps(result, default=str)
            c.observe({"kind": "tool_result", "tool": tool_name, "output": output})
        except Exception as e:  # noqa: BLE001
            _warn(f"post_tool_call: {e}")
        return None

    def transform_tool_result(self, result: Any = None, session_id: Any = None, task_id: Any = None,
                              **_: Any) -> Optional[str]:
        # Eden's own answer gets queued packets appended too, as the lab's plugin (the measured arm) did.
        try:
            if not isinstance(result, str):
                return None
            c = self.client(session_id, task_id)
            if c is None:
                return None
            text = _joined(c.pending())
            return f"{result}\n\n{text}" if text else None
        except Exception as e:  # noqa: BLE001
            _warn(f"transform_tool_result: {e}")
            return None

    def end_session(self, session_id: Any = None, old_session_id: Any = None, **_: Any) -> None:
        """``on_session_finalize`` (``session_id``) and ``on_session_reset`` (``old_session_id``): the identity ends.

        Hermes' CLI reset passes only the new ``session_id``: that pops a session with no client yet and sends
        nothing, and the old one was already ended by the ``on_session_finalize`` its ``/new`` fires first."""
        try:
            sid = self.session_key(old_session_id or session_id)
            if not self.user or sid is None:
                return None
            with self._lock:
                c = self._clients.pop(sid, None)
            if c is not None:
                c.observe({"kind": "session_end"})
        except Exception as e:  # noqa: BLE001
            _warn(f"end_session: {e}")
        return None

    def ask_context(self, args: Any = None, session_id: Any = None, task_id: Any = None, **_: Any) -> str:
        try:
            question = args.get("question") if isinstance(args, dict) else None
            if not isinstance(question, str) or not question.strip():
                return "ask_context needs a question."
            c = self.client(session_id, task_id)
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
        ctx.register_hook("on_session_finalize", self.end_session)
        ctx.register_hook("on_session_reset", self.end_session)
        ctx.register_tool(name=ASK_TOOL, toolset=TOOLSET, schema=ASK_SCHEMA, handler=self.ask_context,
                          description=ASK_CONTEXT_DESCRIPTION)


def _is_tool(name: Any) -> bool:
    return isinstance(name, str) and bool(name)


def _is_ask(name: str) -> bool:
    """Eden's own tool, registered here or reached as an MCP tool (``mcp_eden_ask_context``)."""
    return name == ASK_TOOL or name.endswith("_" + ASK_TOOL)


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
