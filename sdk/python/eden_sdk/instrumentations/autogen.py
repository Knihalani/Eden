"""Auto-instrumentation for AutoGen (pyautogen).

AutoGen 0.2+ exposes ``ConversableAgent`` with a ``reply`` hook system
and a per-message event stream. We install a global ``reply_hook`` on
``ConversableAgent`` that emits a framework event on every reply.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import current_trace

logger = logging.getLogger("eden_sdk.instrumentation.autogen")

_installed = False


def install() -> None:
    global _installed
    if _installed:
        return
    try:
        from autogen import ConversableAgent, Agent  # type: ignore
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"pyautogen not importable: {exc}") from exc

    def _reply_hook(recipient: Any, messages: Optional[list] = None,
                    sender: Optional[Any] = None, config: Optional[Any] = None) -> None:
        try:
            cfg = get_config()
            if not cfg.enabled:
                return
            name = getattr(recipient, "name", None) or "agent"
            sender_name = getattr(sender, "name", None) if sender else None
            event: dict[str, Any] = {
                "event_id": f"eden_ag_{uuid.uuid4().hex[:16]}",
                "trace_id": (
                    current_trace().trace_id
                    if current_trace() else uuid.uuid4().hex
                ),
                "name": name,
                "event_type": "framework.callback",
                "agent_id": name,
                "outcome": "success",
                "attributes": {
                    f"autogen.{k}": str(v)
                    for k, v in {
                        "sender": sender_name or "",
                        "message_count": len(messages or []),
                    }.items()
                },
                "tags": ["autogen", "framework"],
                "source_format": "framework",
            }
            get_default_client().enqueue(
                TraceEvent(payload=event, source_format="framework")
            )
        except Exception:  # noqa: BLE001
            return

    # Register once: ConversableAgent.register_reply_hook exists from
    # 0.2.0 onwards. Use getattr so we don't break import-time checks
    # for older installs (which are not supported here).
    if hasattr(ConversableAgent, "register_reply_hook"):
        try:
            ConversableAgent.register_reply_hook(_reply_hook)  # type: ignore[attr-defined]
            _installed = True
            logger.debug("eden: autogen reply_hook registered")
        except Exception as exc:  # noqa: BLE001
            logger.debug("eden: autogen install failed: %s", exc)
    else:
        logger.debug("eden: autogen < 0.2 — skipping")


def uninstall() -> None:
    global _installed
    _installed = False
    # AutoGen doesn't expose a public unregister hook; the global
    # registration sticks for the process lifetime. The EdenSender's
    # ``enabled`` flag in config.py is the canonical off-switch.
