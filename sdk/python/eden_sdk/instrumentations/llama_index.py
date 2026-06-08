"""Auto-instrumentation for LlamaIndex.

LlamaIndex 0.10+ exposes a ``BaseSpanHandler`` protocol that is the
modern, supported way to instrument the framework. We register a
handler that emits a framework event per span enter/exit. Older
``CallbackManager``-style handlers are no longer the recommended path.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Optional

from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import current_trace

logger = logging.getLogger("eden_sdk.instrumentation.llama_index")

_handler: Optional["EdenLlamaSpanHandler"] = None


def install() -> None:
    global _handler
    if _handler is not None:
        return
    try:
        from llama_index.core.callbacks import BaseSpanHandler  # type: ignore
        from llama_index.core.callbacks.base import CallbackManager  # type: ignore
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"llama-index-core not importable: {exc}") from exc

    class SpanDataLike:
        """Minimal shim matching what BaseSpanHandler expects.

        Real LlamaIndex passes its own ``SpanData`` instances, but
        the handler only reads ``.metadata`` / ``.span_id`` / ``.parent_id``,
        so we just store arbitrary attributes for our own use.
        """

    class EdenLlamaSpanHandler(BaseSpanHandler):  # type: ignore[misc]
        def __init__(self) -> None:
            super().__init__()
            self._starts: dict[str, float] = {}

        def class_name(cls) -> str:  # type: ignore[override]
            return "EdenLlamaSpanHandler"

        def on_start(
            self,
            id_: str,
            bound_arity: int,
            metadata: Optional[dict[str, Any]] = None,
            parent_id: Optional[str] = None,
            **kwargs: Any,
        ) -> None:
            self._starts[id_] = time.perf_counter()

        def on_end(
            self,
            id_: str,
            bound_arity: int,
            metadata: Optional[dict[str, Any]] = None,
            parent_id: Optional[str] = None,
            error: Optional[BaseException] = None,
            **kwargs: Any,
        ) -> None:
            t0 = self._starts.pop(id_, None)
            if t0 is None:
                return
            cfg = get_config()
            if not cfg.enabled:
                return
            duration_ms = (time.perf_counter() - t0) * 1000.0
            md = dict(metadata or {})
            payload: dict[str, Any] = {
                "event_id": f"eden_li_{id_}",
                "trace_id": (
                    current_trace().trace_id
                    if current_trace() else uuid.uuid4().hex
                ),
                "name": str(md.get("class_name") or md.get("name") or "span"),
                "event_type": "framework.callback",
                "agent_id": str(md.get("class_name") or "llama_index"),
                "duration_ms": duration_ms,
                "outcome": "error" if error else "success",
                "attributes": {
                    f"llamaindex.{k}": str(v)
                    for k, v in md.items()
                    if isinstance(v, (str, int, float, bool))
                },
                "tags": ["llama_index", "framework"],
                "source_format": "framework",
                "span_id": id_,
                "parent_span_id": parent_id,
            }
            if error is not None:
                payload["attributes"]["llamaindex.error"] = repr(error)
            get_default_client().enqueue(
                TraceEvent(payload=payload, source_format="framework")
            )

    _handler = EdenLlamaSpanHandler()
    try:
        # Add to the global callback manager if it exists.
        from llama_index.core.callbacks.base import CallbackManager  # type: ignore
        from llama_index.core import global_service_context  # type: ignore  # noqa: F401
        # Newer llama_index: Settings.callback_manager
        try:
            from llama_index.core import Settings  # type: ignore
            cm = getattr(Settings, "callback_manager", None)
            if cm is None:
                from llama_index.core.callbacks import CallbackManager
                cm = CallbackManager([])
                Settings.callback_manager = cm  # type: ignore[attr-defined]
            if _handler not in cm.handlers:
                cm.add_handler(_handler)
        except Exception:  # noqa: BLE001
            # Fallback: just construct a manager and store the handler
            cm = CallbackManager([_handler])
    except Exception as exc:  # noqa: BLE001
        logger.debug("eden: llama_index global wiring failed: %s", exc)
    logger.debug("eden: llama_index BaseSpanHandler registered")


def uninstall() -> None:
    global _handler
    if _handler is None:
        return
    try:
        from llama_index.core import Settings  # type: ignore
        cm = getattr(Settings, "callback_manager", None)
        if cm is not None:
            cm.remove_handler(_handler)
    except Exception:  # noqa: BLE001
        pass
    _handler = None
