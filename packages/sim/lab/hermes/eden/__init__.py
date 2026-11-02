"""Eden as a Hermes plugin, the way a tenant would integrate it (lab: hermes-ab.ts).

- ``pre_llm_call``: the user's message goes to Eden; its packet, if any, is injected into the turn.
- ``post_tool_call``: each tool result goes to Eden, so it does not deliver what the agent already read.
- ``transform_tool_result``: packets Eden queued since then are appended to the tool's result, so context that
  arrives mid-task reaches the agent before its next model request.

Eden's ``ask_context`` is not here: it is Eden's own MCP server, configured beside the source tools.

Fail open: Eden is advisory. Any error, timeout or refusal means "no context" and never breaks the agent's turn.
Configuration comes from the environment at call time (the lab's worker sets it per task):
``EDEN_LAB_URL`` (the stream's Eden routes) and ``EDEN_LAB_TASK`` (the running task's token).
"""

import json
import os
import urllib.request

# The first observe waits up to 3 s for Eden's slow path (the client's default); the rest are quick.
OBSERVE_TIMEOUT_S = 10.0
QUICK_TIMEOUT_S = 5.0
# Eden's ask tool is the agent asking Eden itself: its answer is not a source read Eden needs to see again.
ASK_TOOL_SUFFIX = "ask_context"


def _call(route, payload, timeout):
    """POST to one Eden route; the parsed reply, or None on any failure (fail open)."""
    base = os.environ.get("EDEN_LAB_URL")
    token = os.environ.get("EDEN_LAB_TASK")
    if not base or not token:
        return None
    body = json.dumps({**payload, "token": token}).encode()
    req = urllib.request.Request(
        f"{base}/{route}", data=body, method="POST", headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            out = json.loads(res.read().decode())
            return out if isinstance(out, dict) else None
    except Exception:
        return None


def _context(reply):
    text = reply.get("context") if reply else None
    return text if isinstance(text, str) and text.strip() else None


def pre_llm_call(user_message=None, **kwargs):
    if not isinstance(user_message, str) or not user_message:
        return None
    text = _context(_call("observe", {"text": user_message}, OBSERVE_TIMEOUT_S))
    return {"context": text} if text else None


def post_tool_call(tool_name=None, result=None, **kwargs):
    if not isinstance(tool_name, str) or tool_name.endswith(ASK_TOOL_SUFFIX):
        return None
    try:
        # A result that is not text is sent as JSON; anything JSON cannot encode, as its text.
        output = result if isinstance(result, str) else json.dumps(result, default=str)
    except Exception:
        return None
    _call("tool", {"tool": tool_name, "output": output}, QUICK_TIMEOUT_S)
    return None


def transform_tool_result(tool_name=None, result=None, **kwargs):
    if not isinstance(result, str):
        return None
    text = _context(_call("pending", {}, QUICK_TIMEOUT_S))
    return f"{result}\n\n{text}" if text else None


def register(ctx):
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_tool_call", post_tool_call)
    ctx.register_hook("transform_tool_result", transform_tool_result)
