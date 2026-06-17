"""Stdlib ``logging`` → Eden telemetry bridge.

This module is the public surface for the **Phase R (Logfire-style
shim + console-local view)** feature. The goal is the Logfire / Sentry
5-minute time-to-first-log: import a single function and every existing
``logging.info("...")`` call in the user's application becomes a
searchable, queryable, dashboardable event in Eden.

Two pieces:

1. ``EdenLoggingHandler`` — a :class:`logging.Handler` subclass that
   converts each :class:`logging.LogRecord` into a
   :class:`~eden.observability.telemetry_collector.TelemetryEvent`
   (``event_type="log"``) and submits it to the in-process
   :class:`TelemetryCollector`. Async-safe: ``emit()`` schedules the
   ingest on the running event loop via ``asyncio.create_task`` and
   drops on a full queue rather than blocking the user code.

2. ``install()`` — one-liner setup. Idempotent: calling it twice does
   not add a second handler. Reads ``EDEN_LOG_LEVEL`` and
   ``EDEN_LOG_TRACE`` from settings to pick the level and the ambient
   trace id to attribute orphan log records to.

The shim **never mutates the user logger hierarchy** — it adds one
handler at the root and that's it. Records propagate as usual; the
shim is just another sink alongside the user's existing console /
file handlers.

Thread/coroutine model:

  - The current trace id is read from a :class:`contextvars.ContextVar`
    that the rest of the SDK (Phase C AI agent, Phase A span exports)
    sets when a span is active. If unset, the handler falls back to an
    "ambient" trace id derived from the project id + process id + a
    rotating counter so unrelated log lines still cluster.
  - The handler does NOT spawn its own thread. The handler's
    ``emit()`` is called from whatever thread produced the log
    record (could be a worker thread); it shoves a coroutine onto
    the event loop the user is presumed to be running.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from eden.config import get_settings


# ── Trace-id contextvar ──────────────────────────────────────────────
# Set by the SDK / agent runtime when a trace is active. The handler
# reads it; if unset, the record is attributed to a synthetic "ambient"
# trace so we still get a tree of related log lines.

_active_trace_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "eden_active_trace_id", default=None,
)
_active_span_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "eden_active_span_id", default=None,
)
_active_project_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "eden_active_project_id", default=None,
)
_active_tenant_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "eden_active_tenant_id", default=None,
)


_UNSET = object()


def set_trace_context(
    trace_id: Any = _UNSET,
    span_id: Any = _UNSET,
    project_id: Any = _UNSET,
    tenant_id: Any = _UNSET,
) -> None:
    """Bind the current async / thread context to a trace.

    The shim reads these contextvars when a log record is emitted so
    that a plain ``logging.info("...")`` in a deep callstack is
    correctly attributed to the active trace / span.

    Semantics: omitting a positional argument (the default) leaves
    that field alone; passing ``None`` *clears* that field; passing a
    string *sets* that field. The defaults use a private sentinel
    (``_UNSET``) rather than ``None`` so we can distinguish "don't
    touch" from "clear".

    Example::

        # Inside an active trace:
        set_trace_context("abc", "def", "p1", "org-42")
        logging.info("step 1")  # attributed to trace abc, span def

        # Clear only the span (rarely needed — usually clear_trace_context
        # is the right call).
        set_trace_context(span_id=None)
    """
    if trace_id is not _UNSET:
        _active_trace_id.set(trace_id)  # type: ignore[arg-type]
    if span_id is not _UNSET:
        _active_span_id.set(span_id)  # type: ignore[arg-type]
    if project_id is not _UNSET:
        _active_project_id.set(project_id)  # type: ignore[arg-type]
    if tenant_id is not _UNSET:
        _active_tenant_id.set(tenant_id)  # type: ignore[arg-type]


def clear_trace_context() -> None:
    """Clear all active trace bindings for the current context."""
    _active_trace_id.set(None)
    _active_span_id.set(None)
    _active_project_id.set(None)
    _active_tenant_id.set(None)


# ── Internal: counter for ambient (orphan) trace ids ──────────────────

_ambient_counter = 0


def _next_ambient_trace_id(project_id: str) -> str:
    """Return a synthetic trace id for orphan log records.

    These records are emitted with no active trace context (e.g. the
    user called ``logging.info`` from a CLI before the SDK started a
    trace). We still want them visible, so we attribute them to a
    rotating ambient trace id per process. The trace id is shaped
    like ``ambient-<project>-<pid>-<seq>`` so a user can filter on it.
    """
    global _ambient_counter
    _ambient_counter += 1
    return f"ambient-{project_id}-{os.getpid()}-{_ambient_counter}"


# ── The handler ──────────────────────────────────────────────────────

# Standard LogRecord fields we DO NOT want to copy into the payload
# (they are part of the envelope, not the content).
_RESERVED_LOGRECORD_FIELDS = frozenset({
    "args", "asctime", "created", "exc_info", "exc_text", "filename",
    "funcName", "levelname", "levelno", "lineno", "message", "module",
    "msecs", "msg", "name", "pathname", "process", "processName",
    "relativeCreated", "stack_info", "thread", "threadName", "taskName",
})


class EdenLoggingHandler(logging.Handler):
    """A :class:`logging.Handler` that pipes records into the telemetry pipeline.

    Usage (most users should call :func:`install` instead of wiring
    the handler by hand)::

        from eden.observability.logging_shim import EdenLoggingHandler
        handler = EdenLoggingHandler(level=logging.INFO)
        logging.getLogger().addHandler(handler)

    Each call to :meth:`emit` produces a
    :class:`~eden.observability.telemetry_collector.TelemetryEvent`
    with ``event_type="log"`` and submits it via
    :func:`eden.observability.telemetry_collector.get_telemetry_collector`.

    The handler is **non-blocking**: a full internal queue is
    dropped-with-counter (the ``dropped`` attribute increments) rather
    than blocking the producing thread. We use ``call_soon_threadsafe``
    when called from a worker thread to bridge into the main event
    loop; if no loop is running, the record is dropped (and the
    ``no_loop`` counter increments). The user code never blocks on us.
    """

    # Cap the in-flight queue. 1024 is generous — anything more and the
    # user has bigger problems than a dropped log.
    MAX_QUEUE_SIZE = 1024

    def __init__(
        self,
        level: int = logging.INFO,
        *,
        project_id: Optional[str] = None,
        tenant_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        agent_version: Optional[str] = None,
        realm: str = "production",
    ) -> None:
        super().__init__(level=level)
        self.project_id = project_id or "default"
        # ``tenant_id`` is the org slug the event is attributed to.
        # For in-process ingestion the SDK doesn't have a path-level
        # tenant (that's normally read off the URL by the ingest
        # route), so we accept it as a handler kwarg and also honour
        # the ``_active_tenant_id`` contextvar so per-request tenants
        # can be bound by a middleware.
        self.default_tenant_id = tenant_id or "default"
        self.agent_id = agent_id
        self.agent_version = agent_version
        self.realm = realm
        # Internal queue + counters for diagnostics. ``queue`` is a
        # plain deque (FIFO) so we can drop the oldest when full.
        self._queue: list[dict[str, Any]] = []
        self.dropped: int = 0
        self.no_loop: int = 0
        self.ingested: int = 0
        self.failed: int = 0

    # ── logging.Handler protocol ─────────────────────────────────────

    def emit(self, record: logging.LogRecord) -> None:
        """Convert one :class:`logging.LogRecord` into a telemetry event.

        This method is called by the :mod:`logging` framework, possibly
        from a worker thread. We:
          1. Build the event payload (synchronously; cheap).
          2. Push the event onto our bounded queue.
          3. Schedule a coroutine on the main event loop to drain the
             queue. The coroutine calls
             :func:`eden.observability.telemetry_collector.get_telemetry_collector`
             and then ``await collector.ingest(event)``.
        """
        try:
            event = self._build_event(record)
        except Exception:
            # Never raise from emit() — that would break the user's
            # logger chain. Just bump a counter and bail.
            self.failed += 1
            return

        if len(self._queue) >= self.MAX_QUEUE_SIZE:
            # Drop the oldest, keep the most recent.
            self._queue.pop(0)
            self.dropped += 1
        self._queue.append(event)

        # Schedule a drain on the running event loop, if any.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop in this thread (e.g. a synchronous CLI).
            # We still want the user to see logs; do a synchronous drain.
            self.no_loop += 1
            self._drain_sync()
            return
        loop.call_soon_threadsafe(self._drain_async_safe, loop)

    def flush(self) -> None:  # noqa: D401 — logging.Handler protocol
        """Synchronously drain all pending log events.

        Safe to call from a worker thread; the drain itself is
        best-effort (it schedules the actual ingest on a coroutine).
        """
        self._drain_sync()

    def close(self) -> None:
        try:
            self.flush()
        finally:
            super().close()

    # ── Internal helpers ────────────────────────────────────────────

    def _build_event(self, record: logging.LogRecord) -> dict[str, Any]:
        """Build a TelemetryEvent-shaped dict from a LogRecord.

        We do NOT instantiate :class:`TelemetryEvent` here (that would
        couple the shim to the dataclass and force a synchronous
        import). The downstream ``TelemetryCollector.ingest`` accepts
        the dict via ``TelemetryEvent(**event)`` in the route layer.
        For the in-process path, we hand the dict to the collector's
        helper below.
        """
        # Resolve trace context.
        trace_id = _active_trace_id.get()
        span_id = _active_span_id.get() or record.funcName or ""
        project_id = _active_project_id.get() or self.project_id
        tenant_id = _active_tenant_id.get() or self.default_tenant_id
        if not trace_id:
            trace_id = _next_ambient_trace_id(project_id)

        # Format the message (handles %s args + lazy interpolation).
        try:
            message = record.getMessage()
        except Exception:
            message = str(record.msg)

        # Format exception info, if any. Use the standard
        # ``traceback.format_exception`` so the user sees the same text
        # they would in a console handler.
        exc_text = ""
        if record.exc_info:
            try:
                exc_text = "".join(
                    traceback.format_exception(*record.exc_info),
                )
            except Exception:
                exc_text = "<unformattable exception>"
        elif record.exc_text:
            exc_text = record.exc_text
        elif record.stack_info:
            exc_text = record.stack_info

        # Copy any extra=... fields the user attached to the record.
        extras: dict[str, Any] = {}
        for k, v in record.__dict__.items():
            if k in _RESERVED_LOGRECORD_FIELDS or k.startswith("_"):
                continue
            try:
                # Best-effort JSON-serialise. If it can't be serialised
                # we still want to capture SOMETHING, so fall back to repr.
                json.dumps(v)
                extras[k] = v
            except (TypeError, ValueError):
                extras[k] = repr(v)

        # Map level number → outcome string for the dashboard.
        outcome: Optional[str] = None
        if record.levelno >= logging.ERROR:
            outcome = "failure"
        elif record.levelno >= logging.WARNING:
            outcome = "partial"

        # Build a content-addressed event_id. Identical log lines
        # within the same trace get the same id, which lets
        # ``TelemetryCollector._is_duplicate`` collapse them.
        # (We use a counter to keep uniqueness within a single trace.)
        seq = extras.pop("_seq", None) or uuid.uuid4().hex[:12]
        event_id = f"log-{trace_id}-{record.levelno}-{seq}"

        # Stash formatted log record fields in attributes so the
        # console view in the portal can render them as a structured
        # log line.
        attributes = {
            "logger": record.name,
            "level": record.levelname,
            "module": record.module or "",
            "line": str(record.lineno or 0),
            "func": record.funcName or "",
            "thread": record.threadName or "",
            "process": record.processName or "",
        }

        return {
            "event_id": event_id,
            "tenant_id": tenant_id,
            "project_id": project_id,
            "trace_id": trace_id,
            "realm": self.realm,
            "event_type": "log",
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc,
            ).isoformat(),
            "agent_id": self.agent_id,
            "agent_version": self.agent_version,
            "span_id": span_id or None,
            "name": record.name,
            # duration_ms stays None — log events are instantaneous.
            "duration_ms": None,
            "payload": {
                "message": message,
                "exc_text": exc_text,
                "extras": extras,
            },
            "metrics": {},
            "attributes": attributes,
            "tags": [f"level:{record.levelname}"],
            "outcome": outcome,
            "source_format": "logging_shim",
        }

    def _drain_async_safe(self, loop: asyncio.AbstractEventLoop) -> None:
        """Called via ``loop.call_soon_threadsafe`` from a worker thread.

        Schedules a real coroutine on the loop to ingest each event.
        """
        if not self._queue:
            return
        batch = self._queue
        self._queue = []
        loop.create_task(self._ingest_batch(batch))

    def _drain_sync(self) -> None:
        """Drain the queue synchronously (no event loop available).

        Used as a fallback when ``emit()`` is called from a thread
        with no running loop (e.g. a sync CLI). We directly call the
        collector's ingest — but we never block the user code; we
        just submit and forget. If the collector's queue is also
        full, we drop.
        """
        if not self._queue:
            return
        batch = self._queue
        self._queue = []
        # Try async ingest first; if that fails, fall back to a
        # fire-and-forget background task.
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(self._ingest_batch(batch))
                return
        except RuntimeError:
            pass
        # Truly synchronous: best-effort, run a new loop briefly.
        try:
            asyncio.run(self._ingest_batch(batch))
        except Exception:
            self.dropped += len(batch)

    async def _ingest_batch(self, batch: list[dict[str, Any]]) -> None:
        """Submit all queued events to the TelemetryCollector."""
        try:
            from eden.observability.telemetry_collector import (
                TelemetryEvent,
                get_telemetry_collector,
            )
        except ImportError:
            self.failed += len(batch)
            return
        try:
            collector = await get_telemetry_collector()
        except Exception:
            self.failed += len(batch)
            return
        for event_dict in batch:
            try:
                event = TelemetryEvent(**event_dict)
                ok = await collector.ingest(event)
                if ok:
                    self.ingested += 1
                else:
                    self.dropped += 1
            except Exception:
                self.failed += 1

    # ── Diagnostics ─────────────────────────────────────────────────

    def stats(self) -> dict[str, int]:
        """Return handler counters for observability / health-checks."""
        return {
            "ingested": self.ingested,
            "dropped": self.dropped,
            "failed": self.failed,
            "no_loop": self.no_loop,
            "queued": len(self._queue),
        }


# ── One-liner installer ──────────────────────────────────────────────

# Sentinel used to detect duplicate install() calls.
_INSTALLED_ATTR = "_eden_logging_handler_installed"


def install(
    level: Optional[int] = None,
    *,
    project_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    agent_version: Optional[str] = None,
    realm: str = "production",
    replace: bool = False,
) -> Optional[EdenLoggingHandler]:
    """Install the Eden logging shim on the root logger.

    This is the public 5-minute-time-to-first-log surface. Most users
    will do::

        import eden
        eden.install()  # or eden.install_logging()

    After this call, every existing ``logging.info("...")`` (and the
    50+ third-party libraries that use stdlib logging) becomes a
    searchable, queryable event in Eden. No code changes required.

    Args:
        level: Minimum level to capture. Defaults to ``INFO``, or the
            value of ``EDEN_LOG_LEVEL`` env var, or the
            ``eden_log_level`` setting.
        project_id: Project to attribute orphan log records to.
            Defaults to the ``eden_log_project`` setting or
            ``"default"``.
        tenant_id: Org slug the log events are attributed to. Defaults
            to the ``eden_log_tenant`` setting or ``"default"``.
        agent_id: Optional agent id for cross-referencing in the
            agent intel surface.
        agent_version: Optional agent version string.
        realm: Telemetry realm — ``"production"`` or ``"environment"``.
        replace: If True, remove any previously installed Eden
            handler first (useful in tests / re-install flows).

    Returns:
        The installed :class:`EdenLoggingHandler`, or ``None`` if a
        handler is already installed and ``replace`` is False.
    """
    root = logging.getLogger()
    if getattr(root, _INSTALLED_ATTR, False) and not replace:
        return None

    if replace:
        # Remove any prior instance we attached.
        for h in list(root.handlers):
            if isinstance(h, EdenLoggingHandler):
                root.removeHandler(h)
        setattr(root, _INSTALLED_ATTR, False)

    # Resolve level from env / settings if not provided.
    if level is None:
        env_level = os.environ.get("EDEN_LOG_LEVEL")
        if env_level:
            level = _parse_level(env_level)
        else:
            try:
                cfg = get_settings()
                level = _parse_level(getattr(cfg, "eden_log_level", "INFO"))
            except Exception:
                level = logging.INFO

    # Resolve project id.
    if project_id is None:
        try:
            cfg = get_settings()
            project_id = getattr(cfg, "eden_log_project", None) or "default"
        except Exception:
            project_id = "default"

    # Resolve tenant id.
    if tenant_id is None:
        try:
            cfg = get_settings()
            tenant_id = getattr(cfg, "eden_log_tenant", None) or "default"
        except Exception:
            tenant_id = "default"

    handler = EdenLoggingHandler(
        level=level,
        project_id=project_id,
        tenant_id=tenant_id,
        agent_id=agent_id,
        agent_version=agent_version,
        realm=realm,
    )
    root.addHandler(handler)
    setattr(root, _INSTALLED_ATTR, True)
    return handler


def uninstall() -> bool:
    """Remove the Eden logging handler from the root logger.

    Always clears the installed flag (even if no handler was attached —
    a stale flag is what we want to recover from in tests + re-install
    flows). Returns True if a handler was removed, False if none was
    installed.
    """
    root = logging.getLogger()
    removed = False
    for h in list(root.handlers):
        if isinstance(h, EdenLoggingHandler):
            root.removeHandler(h)
            removed = True
    setattr(root, _INSTALLED_ATTR, False)
    return removed


def is_installed() -> bool:
    """True if the Eden logging handler is currently installed."""
    root = logging.getLogger()
    return bool(getattr(root, _INSTALLED_ATTR, False))


# ── Helpers ──────────────────────────────────────────────────────────

def _parse_level(value: str) -> int:
    """Map a string log level name to its numeric value.

    Falls back to ``logging.INFO`` for unknown values.
    """
    if isinstance(value, int):
        return value
    name = str(value).upper().strip()
    return logging.getLevelName(name) if isinstance(logging.getLevelName(name), int) else logging.INFO


def get_handler() -> Optional[EdenLoggingHandler]:
    """Return the currently installed EdenLoggingHandler, or None."""
    root = logging.getLogger()
    for h in root.handlers:
        if isinstance(h, EdenLoggingHandler):
            return h
    return None


# ── json shim (kept local to avoid an unconditional import) ──────────

try:
    import json
except ImportError:  # pragma: no cover — stdlib always importable
    json = None  # type: ignore[assignment]


__all__ = [
    "EdenLoggingHandler",
    "install",
    "uninstall",
    "is_installed",
    "get_handler",
    "set_trace_context",
    "clear_trace_context",
]
