"""Eden's gptme hooks: every INTEGRATION.md obligation on gptme's hook surface.

Signatures follow gptme 0.35.x: ``GENERATION_PRE`` gets ``(messages, **kwargs)`` and its yielded
messages reach only that model call; ``TOOL_EXECUTE_PRE``/``TOOL_EXECUTE_POST`` get one ``data``
object (``log``/``workspace``/``tool_use``/``result_msgs``); ``TOOL_CONFIRM`` returns a
``ConfirmationResult``; ``SESSION_END``/``TURN_*`` get the ``LogManager``.
"""

import sys
from pathlib import Path

_VENDOR = Path(__file__).resolve().parents[1] / "vendor"
if _VENDOR.is_dir() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

from eden_client.gptme import plugin


def _messages(manager):
    log = getattr(manager, "log", None)
    return list(getattr(log, "messages", None) or getattr(manager, "messages", []) or [])


def _last_text(log):
    messages = list(getattr(log, "messages", []) or [])
    return getattr(messages[-1], "content", None) if messages else None


def _generation_pre(messages, **kwargs):
    from gptme.message import Message

    for text in plugin().generation(list(messages)):
        yield Message("system", text)


def _tool_pre(data):
    plugin().tool_pre(getattr(data, "tool_use", None), data)
    yield from ()


def _tool_confirm(tool_use, preview=None, workspace=None):
    """Return ``ConfirmationResult.skip`` on an Eden finding, ``None`` to fall through."""
    held = plugin().tool_confirm(tool_use)
    if held is None:
        return None
    from gptme.hooks.confirm import ConfirmationResult

    return ConfirmationResult.skip(held)


def _tool_post(data):
    tool_use = getattr(data, "tool_use", None)
    msgs = getattr(data, "result_msgs", None) or []
    out = getattr(msgs[-1], "content", None) if msgs else _last_text(getattr(data, "log", None))
    plugin().tool_post(tool_use, out, data)
    yield from ()


def _turn_post(manager):
    from gptme.message import Message

    plugin().turn_end(_messages(manager), manager)
    for text in plugin().persist(manager):
        yield Message("system", text)


def _session_start(logdir, workspace, initial_msgs):
    plugin().session_start(logdir)
    yield from ()


def _session_end(manager):
    plugin().session_end(manager)
    yield from ()


def register():
    """Register all Eden hooks; gptme calls this during plugin initialization."""
    from gptme.hooks import HookType, register_hook

    register_hook("eden.session_start", HookType.SESSION_START, _session_start)
    register_hook("eden.session_end", HookType.SESSION_END, _session_end)
    register_hook("eden.generation", HookType.GENERATION_PRE, _generation_pre)
    register_hook("eden.tool_pre", HookType.TOOL_EXECUTE_PRE, _tool_pre, priority=100)
    register_hook("eden.tool_confirm", HookType.TOOL_CONFIRM, _tool_confirm, priority=100)
    register_hook("eden.tool_post", HookType.TOOL_EXECUTE_POST, _tool_post)
    register_hook("eden.turn", HookType.TURN_POST, _turn_post)
