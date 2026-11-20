"""Eden's gptme hooks: every INTEGRATION.md obligation on gptme's hook surface.

gptme appends yielded messages to the conversation log, so a packet yielded once stays where it landed —
no keep machinery. The party check runs on ``TOOL_EXECUTE_PRE`` (the policy seam that can ``data.deny``),
not ``TOOL_CONFIRM``, which owns user consent.
"""

import os
import sys
from pathlib import Path

_VENDOR = Path(__file__).resolve().parents[1] / "vendor"
if _VENDOR.is_dir() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

from eden_client.gptme import plugin


def _messages(manager):
    log = getattr(manager, "log", None)
    return list(getattr(log, "messages", None) or getattr(manager, "messages", []) or [])


def _input_of(tool_use):
    out = {}
    for name in ("content", "args", "kwargs"):
        value = getattr(tool_use, name, None)
        if value is not None:
            out[name] = value
    return out


def _last_text(log):
    messages = list(getattr(log, "messages", []) or [])
    return getattr(messages[-1], "content", None) if messages else None


def _generation_pre(manager):
    text = plugin().generation(_messages(manager), manager)
    if text:
        from gptme.message import Message

        yield Message("system", text)
    else:
        yield from ()


def _tool_pre(data):
    tool_use = getattr(data, "tool_use", None)
    held = plugin().tool_pre(
        getattr(tool_use, "tool", None), _input_of(tool_use), getattr(data, "workspace", None)
    )
    if held is not None and callable(getattr(data, "deny", None)):
        data.deny(held)
    yield from ()


def _tool_post(log, workspace, tool_use):
    plugin().tool_post(
        getattr(tool_use, "tool", None),
        getattr(tool_use, "output", None) or _last_text(log),
        getattr(log, "logdir", None) or workspace,
    )
    yield from ()


def _turn_post(manager):
    plugin().turn_end(_messages(manager), manager)
    yield from ()


def _session_start(logdir, workspace, initial_msgs):
    plugin().session_start(logdir)
    yield from ()


def _session_end(logdir, workspace, initial_msgs):
    plugin().session_end(logdir)
    yield from ()


def register():
    """Register all Eden hooks; gptme calls this during plugin initialization."""
    from gptme.hooks import HookType, register_hook

    register_hook("eden.session_start", HookType.SESSION_START, _session_start)
    register_hook("eden.session_end", HookType.SESSION_END, _session_end)
    register_hook("eden.generation", HookType.GENERATION_PRE, _generation_pre)
    register_hook("eden.tool_pre", HookType.TOOL_EXECUTE_PRE, _tool_pre, priority=100)
    register_hook("eden.tool_post", HookType.TOOL_EXECUTE_POST, _tool_post)
    register_hook("eden.turn", HookType.TURN_POST, _turn_post)
