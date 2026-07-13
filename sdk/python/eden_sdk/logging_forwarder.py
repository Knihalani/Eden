"""Forward stdlib ``logging`` records to Eden as ``event_type: log`` events.

Mirrors the server-side :mod:`eden.observability.logging_shim` UX but
ships inside the SDK so ``eden.install_logging()`` works from user code
without a full Eden server install.
"""

from __future__ import annotations

import logging
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any

from eden_sdk._instrumentation_ids import _trace_id_or_random
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import current_span, current_trace

_HANDLER: EdenLoggingHandler | None = None


class EdenLoggingHandler(logging.Handler):
    """Convert :class:`logging.LogRecord` instances into Eden log events."""

    def __init__(self, level: int = logging.INFO) -> None:
        super().__init__(level=level)
        self._installed = False

    def emit(self, record: logging.LogRecord) -> None:
        cfg = get_config()
        if not cfg.enabled:
            return
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001
            message = str(record.msg)
        exc_text = None
        if record.exc_info:
            exc_text = "".join(traceback.format_exception(*record.exc_info))
        trace = current_trace()
        span = current_span()
        trace_id = trace.trace_id if trace is not None else _trace_id_or_random()
        span_id = span.span_id if span is not None else None
        outcome = "error" if record.levelno >= logging.ERROR else "success"
        event_id = f"log-{trace_id}-{record.levelno}-{uuid.uuid4().hex[:8]}"
        payload: dict[str, Any] = {
            "event_id": event_id,
            "trace_id": trace_id,
            "span_id": span_id,
            "event_type": "log",
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "name": record.name,
            "duration_ms": None,
            "outcome": outcome,
            "source_format": "eden-sdk-logging",
            "payload": {
                "message": message,
                "exc_text": exc_text,
            },
            "attributes": {
                "logger": record.name,
                "level": record.levelname,
                "module": record.module or "",
                "line": str(record.lineno or 0),
                "func": record.funcName or "",
            },
            "tags": [f"level:{record.levelname}"],
        }
        get_default_client().enqueue(TraceEvent(payload=payload, source_format="custom"))


def install_logging(level: int | str = logging.INFO) -> None:
    """Attach an Eden log handler to the root logger (idempotent)."""
    global _HANDLER
    if _HANDLER is not None:
        return
    if isinstance(level, str):
        level = getattr(logging, level.upper(), logging.INFO)
    _HANDLER = EdenLoggingHandler(level=level)
    logging.getLogger().addHandler(_HANDLER)


def uninstall_logging() -> None:
    """Remove the Eden log handler from the root logger."""
    global _HANDLER
    if _HANDLER is None:
        return
    logging.getLogger().removeHandler(_HANDLER)
    _HANDLER = None
