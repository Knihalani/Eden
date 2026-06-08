"""Public tracing API: ``@trace_agent`` decorator + ``with eden.trace(...)``.

The decorator wraps any sync or async callable and emits one
``framework`` ingestion event per invocation, including duration,
outcome, and any error. The context manager exposes the same primitives
manually for users who want full control.

A *trace* is a tree of *spans*; the SDK ships a flat representation
(open spans auto-close on context exit). A background client correlates
events by ``trace_id`` and ``parent_span_id``, matching the columns on
``telemetry_events``.
"""

from __future__ import annotations

import functools
import inspect
import logging
import secrets
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Optional

from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config

logger = logging.getLogger("eden_sdk.trace")


# ── ContextVars: span correlation across async hops ───────────────────
#
# ContextVars (not threading.local) so an async task that awaits a
# child span sees the same trace_id and parent_span_id as its parent.

_active_trace: ContextVar[Optional["TraceContext"]] = ContextVar(
    "eden_active_trace", default=None
)
_active_span: ContextVar[Optional["Span"]] = ContextVar(
    "eden_active_span", default=None
)


def current_trace() -> Optional["TraceContext"]:
    return _active_trace.get()


def current_span() -> Optional["Span"]:
    return _active_span.get()


# ── Span / TraceContext ───────────────────────────────────────────────


@dataclass
class Span:
    """A single in-flight unit of work.

    Auto-instrumentation modules also produce a flattened version of
    this — the dataclass is just for users that drive the SDK by hand.
    """

    span_id: str = field(default_factory=lambda: secrets.token_hex(8))
    name: str = "span"
    start: float = field(default_factory=time.perf_counter)
    end: Optional[float] = None
    parent_span_id: Optional[str] = None
    attributes: dict[str, Any] = field(default_factory=dict)
    outcome: str = "success"
    error: Optional[str] = None
    span_token: Any = None
    trace_token: Any = None

    def set_attribute(self, key: str, value: Any) -> None:
        self.attributes[key] = value

    def finish(self, outcome: str = "success", error: Optional[str] = None) -> None:
        if self.end is not None:
            return
        self.end = time.perf_counter()
        self.outcome = outcome
        self.error = error

    @property
    def duration_ms(self) -> float:
        if self.end is None:
            return (time.perf_counter() - self.start) * 1000.0
        return (self.end - self.start) * 1000.0


@dataclass
class TraceContext:
    """A logical trace — groups a tree of spans under one ``trace_id``."""

    trace_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    name: str = "trace"
    start: float = field(default_factory=time.perf_counter)
    attributes: dict[str, Any] = field(default_factory=dict)


# ── Public context manager ────────────────────────────────────────────


@contextmanager
def trace(
    name: str = "trace",
    *,
    trace_id: Optional[str] = None,
    attributes: Optional[dict[str, Any]] = None,
) -> Iterator[TraceContext]:
    """Open a new trace. Use as a context manager.

    >>> with eden.trace("qa-pipeline") as t:
    ...     with eden.trace("summarise") as s:
    ...         do_work()
    """
    cfg = get_config()
    if not cfg.enabled:
        # Yield a no-op context so user code is unchanged when disabled.
        yield TraceContext(name=name)
        return

    parent = _active_trace.get()
    if trace_id is not None:
        new_trace_id = trace_id
    elif parent is not None:
        new_trace_id = parent.trace_id
    else:
        new_trace_id = uuid.uuid4().hex
    ctx = TraceContext(
        trace_id=new_trace_id,
        name=name,
        attributes=dict(attributes or {}),
    )
    span = Span(
        name=name,
        parent_span_id=_active_span.get().span_id if _active_span.get() else None,
        attributes=dict(attributes or {}),
    )

    trace_token = _active_trace.set(ctx)
    span_token = _active_span.set(span)
    span.trace_token = trace_token
    span.span_token = span_token
    try:
        yield ctx
    except BaseException as exc:
        span.finish(outcome="error", error=repr(exc))
        raise
    else:
        span.finish(outcome="success")
    finally:
        # Always emit a framework event for the trace, even on errors.
        _emit_trace_event(span, ctx)
        # Reset context vars.
        _active_span.reset(span_token)
        _active_trace.reset(trace_token)


def _emit_trace_event(span: Span, ctx: TraceContext) -> None:
    """Build and enqueue a framework-format event for a closed span."""
    from eden_sdk.config import get_config as _gc

    cfg = _gc()
    if not cfg.enabled:
        return
    duration_ms = span.duration_ms
    payload: dict[str, Any] = {
        "event_id": f"eden_span_{span.span_id}",
        "trace_id": ctx.trace_id,
        "name": span.name,
        "event_type": "agent.run",
        "agent_id": ctx.name,
        "agent_version": None,
        "duration_ms": duration_ms,
        "outcome": span.outcome,
        "attributes": {
            **{f"eden.span.{k}": str(v) for k, v in span.attributes.items()},
            "eden.span_id": span.span_id,
            "eden.trace_name": ctx.name,
        },
        "tags": ["eden-sdk", "framework"],
        "source_format": "framework",
        "span_id": span.span_id,
        "parent_span_id": span.parent_span_id,
    }
    if span.error:
        payload["attributes"]["eden.error"] = span.error
    get_default_client().enqueue(
        TraceEvent(payload=payload, source_format="framework")
    )


# ── Decorator ─────────────────────────────────────────────────────────


def trace_agent(
    name: Optional[str] = None,
    *,
    tags: Optional[list[str]] = None,
    attributes: Optional[dict[str, Any]] = None,
    capture_args: bool = True,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorate a function so every call is traced as an agent run.

    Works for sync and async callables. The decorator is a no-op
    when the SDK is disabled — user code is never modified.
    """
    deco_tags = list(tags or [])

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        func_name = name or func.__qualname__ or func.__name__

        if inspect.iscoroutinefunction(func):

            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                attrs: dict[str, Any] = dict(attributes or {})
                if capture_args:
                    attrs["eden.args"] = _safe_repr(args)
                    attrs["eden.kwargs"] = _safe_repr(kwargs)
                attrs["eden.tags"] = ",".join(deco_tags + ["async"])
                with trace(func_name, attributes=attrs):
                    return await func(*args, **kwargs)

            return async_wrapper

        @functools.wraps(func)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            attrs = dict(attributes or {})
            if capture_args:
                attrs["eden.args"] = _safe_repr(args)
                attrs["eden.kwargs"] = _safe_repr(kwargs)
            attrs["eden.tags"] = ",".join(deco_tags + ["sync"])
            with trace(func_name, attributes=attrs):
                return func(*args, **kwargs)

        return sync_wrapper

    return decorator


def _safe_repr(value: Any, max_len: int = 256) -> str:
    """Render an object as a short string for span attributes."""
    try:
        s = repr(value)
    except Exception:  # noqa: BLE001
        s = f"<unrepr {type(value).__name__}>"
    if len(s) > max_len:
        s = s[: max_len - 1] + "…"
    return s
