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
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from eden_sdk.capture import capture_value, limits_from_config, stamp_capture_attributes
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config

logger = logging.getLogger("eden_sdk.trace")


# ── ContextVars: span correlation across async hops ───────────────────
#
# ContextVars (not threading.local) so an async task that awaits a
# child span sees the same trace_id and parent_span_id as its parent.

_active_trace: ContextVar[TraceContext | None] = ContextVar(
    "eden_active_trace", default=None
)
_active_span: ContextVar[Span | None] = ContextVar(
    "eden_active_span", default=None
)


def current_trace() -> TraceContext | None:
    return _active_trace.get()


def current_span() -> Span | None:
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
    end: float | None = None
    parent_span_id: str | None = None
    attributes: dict[str, Any] = field(default_factory=dict)
    outcome: str = "success"
    error: str | None = None
    span_token: Any = None
    trace_token: Any = None

    def set_attribute(self, key: str, value: Any) -> None:
        self.attributes[key] = value

    def set_input(self, value: Any) -> Span:
        """Attach structured input to the span (logged as ``eden.input``)."""
        self.attributes["eden.input"] = value
        return self

    def set_output(self, value: Any) -> Span:
        """Attach structured output to the span (logged as ``eden.output``)."""
        self.attributes["eden.output"] = value
        return self

    def set_tag(self, *tags: str) -> Span:
        """Append tags to the span. Emitted alongside framework tags."""
        # Tolerate a pre-existing string attribute (older decorator
        # versions wrote eden.tags as a comma-joined string;
        # treating that as iterable would spread its characters
        # into the tag list). Coerce known shapes explicitly; a
        # missing attribute starts as an empty list.
        raw = self.attributes.get("eden.tags")
        if isinstance(raw, str):
            existing: list[str] = [t for t in raw.split(",") if t]
        elif isinstance(raw, (list, tuple)):
            existing = [str(t) for t in raw]
        else:
            existing = []
        for t in tags:
            if t and t not in existing:
                existing.append(t)
        self.attributes["eden.tags"] = existing
        return self

    def set_status(self, status: str, *, error: str | None = None) -> Span:
        """Mark the span's outcome explicitly.

        ``status`` is one of ``"ok"`` / ``"error"`` / ``"unset"``
        (matching OTel status codes). When ``error`` is given the
        span outcome is forced to ``"error"`` regardless of ``status``.
        """
        normalized = {"ok": "success", "error": "error", "unset": "unset"}.get(
            status, status
        )
        # If the caller passed ``error=...`` the outcome is
        # always ``"error"`` regardless of the ``status`` kwarg.
        # Compute the final outcome first, then mirror it into
        # both the public ``eden.status`` field and the internal
        # ``eden._pending_outcome`` slot. The previous code wrote
        # ``eden.status`` BEFORE the error-override, so a span
        # with ``set_status("ok", error="boom")`` was emitted
        # with ``status="success"`` but ``outcome="error"`` —
        # the two fields disagreed.
        if error is not None:
            self.error = error
            normalized = "error"
        self.attributes["eden.status"] = normalized
        # Do not call finish() here — finish() is invoked at context exit.
        # Stash the intent so finish() picks it up.
        self.attributes["eden._pending_outcome"] = normalized
        return self

    def finish(self, outcome: str | None = None, error: str | None = None) -> None:
        if self.end is not None:
            return
        self.end = time.perf_counter()
        # Allow set_status() to override the default success outcome.
        pending = self.attributes.pop("eden._pending_outcome", None)
        self.outcome = pending or outcome or "success"
        if error is not None:
            self.error = error
            self.outcome = "error"

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
    trace_id: str | None = None,
    attributes: dict[str, Any] | None = None,
    stream: bool | None = None,
) -> Iterator[Span]:
    """Open a new trace as a context manager. The yielded ``Span``
    supports ``set_input`` / ``set_output`` / ``set_tag`` / ``set_status``
    and exposes ``span.trace_id`` / ``span.span_id`` for correlation.

    Pass ``stream=True`` (or set ``EDEN_LIVE=1``) to publish in-flight
    span events to the N11 live channel while the trace runs.

    >>> with eden.trace("qa-pipeline") as root:
    ...     root.set_input({"q": "hi"})
    ...     with eden.trace("summarise") as child:
    ...         child.set_input("summarising")
    ...         result = do_work()
    ...         child.set_output(result)
    """
    cfg = get_config()
    if not cfg.enabled:
        # Yield a no-op span so user code is unchanged when disabled.
        yield Span(name=name)
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
    # Attach the trace context to the span so users can read trace_id
    # directly off the yielded value. ``span.trace_id`` is a convenience
    # alias for ``span.trace_context.trace_id``.
    span.trace_context = ctx  # type: ignore[attr-defined]
    span.trace_id = new_trace_id  # type: ignore[attr-defined]

    trace_token = _active_trace.set(ctx)
    span_token = _active_span.set(span)
    span.trace_token = trace_token  # type: ignore[attr-defined]
    span.span_token = span_token  # type: ignore[attr-defined]

    live_on = False
    try:
        from eden_sdk.live import emit_span_live, live_mode_enabled

        live_on = live_mode_enabled(stream=stream) or bool(
            getattr(cfg, "live", False)
        )
        if live_on:
            emit_span_live(
                session_id=new_trace_id,
                event_type="span_start",
                span_id=span.span_id,
                name=name,
                trace_id=new_trace_id,
                parent_id=span.parent_span_id,
                stream=True,
            )
    except Exception:
        live_on = False

    try:
        yield span
    except BaseException as exc:
        span.finish(error=repr(exc))
        raise
    else:
        if span.end is None:
            span.finish()
    finally:
        # Always emit a framework event for the trace, even on errors.
        _emit_trace_event(span, ctx)
        if live_on:
            try:
                from eden_sdk.live import emit_span_live, get_live_publisher

                emit_span_live(
                    session_id=new_trace_id,
                    event_type="span_end",
                    span_id=span.span_id,
                    name=name,
                    trace_id=new_trace_id,
                    parent_id=span.parent_span_id,
                    status="ok" if span.outcome == "success" else "error",
                    attributes={"duration_ms": span.duration_ms},
                    stream=True,
                )
                # Root span finalize: no parent active after reset below —
                # finalize when this is the outermost stream-enabled span.
                if parent is None:
                    get_live_publisher().finalize(
                        session_id=new_trace_id,
                        trace_id=new_trace_id,
                    )
            except Exception:
                pass
        # Reset context vars.
        _active_span.reset(span_token)
        _active_trace.reset(trace_token)


def _map_attr_key(key: str) -> str:
    """Map a user-supplied span attribute key to its wire name.

    Every attribute used to get an unconditional ``eden.span.`` prefix,
    so a caller setting ``force_trace`` (via
    ``@trace_agent(attributes={"force_trace": True})`` or
    ``span.set_attribute(...)``) shipped as ``eden.span.force_trace`` —
    a key the server's N16 keep-rule reader
    (``eden.observability.sampling.summaries.signals_from_attributes``,
    which looks for the literal ``eden.force_trace``) never sees. Same
    problem for any other ``eden.*``-namespaced key a caller sets by
    hand: it got double-namespaced to ``eden.span.eden.*`` instead of
    reaching the server under its own name.

    * ``force_trace`` → ``eden.force_trace`` (the one key rename).
    * Anything already namespaced under ``eden.`` passes through as-is.
    * Everything else keeps the ``eden.span.`` prefix (back-compat /
      namespacing against framework-internal keys like ``eden.args``).
    """
    if key == "force_trace":
        return "eden.force_trace"
    if key.startswith("eden."):
        return key
    return f"eden.span.{key}"


def _emit_trace_event(span: Span, ctx: TraceContext) -> None:
    """Build and enqueue a framework-format event for a closed span."""
    from eden_sdk.config import get_config as _gc

    cfg = _gc()
    if not cfg.enabled:
        return
    duration_ms = span.duration_ms
    # Split out the structured fields from the general attributes dict.
    # Anything the user attached via set_input / set_output / set_tag /
    # set_status is hoisted to top-level fields on the event payload so
    # the gateway doesn't have to know about the SDK's internal
    # attribute prefix scheme.
    raw_attrs = dict(span.attributes)
    input_val = raw_attrs.pop("eden.input", None)
    output_val = raw_attrs.pop("eden.output", None)
    # Normalise the user-supplied eden.tags attribute into a
    # list-of-strings. The decorator now writes a list, but the
    # emitter is the wire contract — coerce defensively so a
    # legacy string attribute (e.g. from user code that mirrors
    # the SDK's older comma-joined form) does not end up spread
    # into per-character tags on the wire.
    raw_tags = raw_attrs.pop("eden.tags", None)
    if isinstance(raw_tags, str):
        extra_tags: list[str] = [t for t in raw_tags.split(",") if t]
    elif isinstance(raw_tags, (list, tuple)):
        extra_tags = [str(t) for t in raw_tags]
    else:
        extra_tags = []
    status_val = raw_attrs.pop("eden.status", None)
    pending_outcome = raw_attrs.pop("eden._pending_outcome", None)
    final_outcome = pending_outcome or span.outcome

    # Bounded capture applies at emission time (not when set_input/
    # set_output was called) so the error/slow bypass sees the span's
    # FINAL outcome and duration regardless of call order — a span
    # that calls set_input() before it knows it will error still gets
    # the full-fidelity keep.
    limits = limits_from_config(get_config())
    has_error = bool(span.error) or final_outcome == "error"
    input_result = capture_value(
        input_val, has_error=has_error, duration_ms=duration_ms, limits=limits
    )
    output_result = capture_value(
        output_val, has_error=has_error, duration_ms=duration_ms, limits=limits
    )
    input_val = input_result.value
    output_val = output_result.value

    attributes: dict[str, Any] = {
        **{f"eden.span.{k}": str(v) for k, v in raw_attrs.items()},
        "eden.span_id": span.span_id,
        "eden.trace_name": ctx.name,
    }
    stamp_capture_attributes(attributes, input_result, output_result)

    payload: dict[str, Any] = {
        "event_id": f"eden_span_{span.span_id}",
        "trace_id": ctx.trace_id,
        "name": span.name,
        "event_type": "agent.run",
        "agent_id": (getattr(get_config(), "agent_id", None) or ctx.name),
        "agent_version": None,
        "duration_ms": duration_ms,
        "outcome": final_outcome,
        "status": status_val,
        "input": input_val,
        "output": output_val,
        "attributes": attributes,
        "tags": ["eden-sdk", "framework", *extra_tags],
        "source_format": "framework",
        "span_id": span.span_id,
        "parent_span_id": span.parent_span_id,
    }
    if span.error:
        payload["attributes"]["eden.error"] = span.error
        # Mirror to the generic key observability SQL and older
        # portal paths already look for (`attributes->>'error'`).
        payload["attributes"]["error"] = span.error
        payload["error_message"] = span.error
        payload["error_type"] = (
            span.error.split("(", 1)[0].strip()
            if "(" in span.error
            else "error"
        )
    get_default_client().enqueue(
        TraceEvent(payload=payload, source_format="framework")
    )


# ── Decorator ─────────────────────────────────────────────────────────


def trace_agent(
    name: str | None = None,
    *,
    tags: list[str] | None = None,
    attributes: dict[str, Any] | None = None,
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
                # eden.tags is a list (matches Span.set_tag's
                # contract); the emitter does
                # ["eden-sdk", "framework", *extra_tags] so a
                # string here would spread into per-character tags.
                attrs["eden.tags"] = list(deco_tags) + ["async"]
                with trace(func_name, attributes=attrs):
                    return await func(*args, **kwargs)

            return async_wrapper

        @functools.wraps(func)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            attrs = dict(attributes or {})
            if capture_args:
                attrs["eden.args"] = _safe_repr(args)
                attrs["eden.kwargs"] = _safe_repr(kwargs)
            attrs["eden.tags"] = list(deco_tags) + ["sync"]
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
