"""Auto-instrumentation for LangGraph compiled graphs.

Patches :class:`langgraph.pregel.Pregel` (the base of every
``CompiledGraph`` / ``CompiledStateGraph``) so that every graph
invocation emits ``graph.node_start`` / ``graph.node_end`` events with
node names and state keys, following the same patterns as
``pydantic_ai.py`` in this package.

Public API
----------
``install()``    — apply patches (no-op if langgraph is not installed)
``uninstall()``  — reverse patches
"""

from __future__ import annotations

import functools
import logging
import time
import uuid
from typing import Any, Generator

from eden_sdk._instrumentation_ids import _trace_id_or_random
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config

logger = logging.getLogger("eden_sdk.instrumentation.langgraph")

_installed = False
_original_invoke: Any | None = None
_original_ainvoke: Any | None = None
_original_stream: Any | None = None
_original_astream: Any | None = None


# ── helpers ──────────────────────────────────────────────────────────────


def _short(value: Any, limit: int = 400) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _state_keys(state: Any) -> list[str]:
    """Return the top-level keys of a mapping / dataclass-like state object."""
    try:
        if isinstance(state, dict):
            return sorted(state.keys())
        # Pydantic model or TypedDict
        if hasattr(state, "__fields__"):
            return sorted(state.__fields__.keys())
        if hasattr(state, "__dict__"):
            return sorted(k for k in state.__dict__ if not k.startswith("_"))
    except Exception:  # noqa: BLE001
        pass
    return []


def _graph_name(graph: Any) -> str:
    """Best-effort name for a CompiledGraph instance."""
    for attr in ("name", "__name__", "_graph_name"):
        val = getattr(graph, attr, None)
        if val and isinstance(val, str):
            return val
    # Fall back to class name minus "Compiled"
    cls = type(graph).__name__
    return cls.replace("Compiled", "").lower() or "langgraph-graph"


def _emit_span(
    *,
    event_type: str,
    node_name: str,
    graph_name: str,
    state_keys: list[str],
    duration_ms: float,
    outcome: str,
    error: str | None = None,
) -> None:
    cfg = get_config()
    if not cfg.enabled:
        return
    attrs: dict[str, Any] = {
        "langgraph.framework": "langgraph",
        "langgraph.node": node_name,
        "langgraph.state_keys": state_keys,
    }
    if error:
        attrs["langgraph.error"] = error
    payload: dict[str, Any] = {
        "event_id": f"eden_lg_{uuid.uuid4().hex[:16]}",
        "trace_id": _trace_id_or_random(),
        "name": f"{graph_name}.{node_name}",
        "event_type": event_type,
        "agent_id": graph_name,
        "outcome": outcome,
        "duration_ms": duration_ms,
        "attributes": attrs,
        "tags": ["langgraph", "framework"],
        "source_format": "langgraph",
    }
    get_default_client().enqueue(TraceEvent(payload=payload, source_format="webhook"))


# ── invoke / ainvoke ─────────────────────────────────────────────────────
# For non-streaming calls we emit a single pair of start + end events
# for the graph as a whole (node_name == graph name, since invoke does
# not expose per-node results).


def _wrap_invoke(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return original(self, *args, **kwargs)
        gname = _graph_name(self)
        inp = args[0] if args else kwargs.get("input", {})
        in_keys = _state_keys(inp)
        _emit_span(
            event_type="graph.node_start",
            node_name=gname,
            graph_name=gname,
            state_keys=in_keys,
            duration_ms=0.0,
            outcome="running",
        )
        t0 = time.perf_counter()
        try:
            result = original(self, *args, **kwargs)
            _emit_span(
                event_type="graph.node_end",
                node_name=gname,
                graph_name=gname,
                state_keys=_state_keys(result),
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                outcome="success",
            )
            return result
        except Exception as exc:  # noqa: BLE001
            _emit_span(
                event_type="graph.node_end",
                node_name=gname,
                graph_name=gname,
                state_keys=in_keys,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                outcome="error",
                error=repr(exc),
            )
            raise

    return wrapper


def _wrap_ainvoke(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return await original(self, *args, **kwargs)
        gname = _graph_name(self)
        inp = args[0] if args else kwargs.get("input", {})
        in_keys = _state_keys(inp)
        _emit_span(
            event_type="graph.node_start",
            node_name=gname,
            graph_name=gname,
            state_keys=in_keys,
            duration_ms=0.0,
            outcome="running",
        )
        t0 = time.perf_counter()
        try:
            result = await original(self, *args, **kwargs)
            _emit_span(
                event_type="graph.node_end",
                node_name=gname,
                graph_name=gname,
                state_keys=_state_keys(result),
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                outcome="success",
            )
            return result
        except Exception as exc:  # noqa: BLE001
            _emit_span(
                event_type="graph.node_end",
                node_name=gname,
                graph_name=gname,
                state_keys=in_keys,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                outcome="error",
                error=repr(exc),
            )
            raise

    return wrapper


# ── stream / astream ─────────────────────────────────────────────────────
# Streaming calls yield {node_name: state_updates} dicts (stream_mode=
# "updates") or full state snapshots (stream_mode="values").  For each
# chunk we emit a start event before yielding it and an end event after.


def _wrap_stream(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs) -> Generator:  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            yield from original(self, *args, **kwargs)
            return
        gname = _graph_name(self)
        for chunk in original(self, *args, **kwargs):
            # Each chunk is typically {node_name: state_dict}.
            if isinstance(chunk, dict):
                for node_name, node_state in chunk.items():
                    node_keys = _state_keys(node_state)
                    t0 = time.perf_counter()
                    _emit_span(
                        event_type="graph.node_start",
                        node_name=str(node_name),
                        graph_name=gname,
                        state_keys=node_keys,
                        duration_ms=0.0,
                        outcome="running",
                    )
                    yield chunk
                    _emit_span(
                        event_type="graph.node_end",
                        node_name=str(node_name),
                        graph_name=gname,
                        state_keys=node_keys,
                        duration_ms=(time.perf_counter() - t0) * 1000.0,
                        outcome="success",
                    )
            else:
                # Non-dict chunk (e.g. stream_mode="values"): emit for
                # the graph as a whole, not a specific node.
                t0 = time.perf_counter()
                _emit_span(
                    event_type="graph.node_start",
                    node_name=gname,
                    graph_name=gname,
                    state_keys=_state_keys(chunk),
                    duration_ms=0.0,
                    outcome="running",
                )
                yield chunk
                _emit_span(
                    event_type="graph.node_end",
                    node_name=gname,
                    graph_name=gname,
                    state_keys=_state_keys(chunk),
                    duration_ms=(time.perf_counter() - t0) * 1000.0,
                    outcome="success",
                )

    return wrapper


def _wrap_astream(original):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            async for chunk in original(self, *args, **kwargs):
                yield chunk
            return
        gname = _graph_name(self)
        async for chunk in original(self, *args, **kwargs):
            if isinstance(chunk, dict):
                for node_name, node_state in chunk.items():
                    node_keys = _state_keys(node_state)
                    t0 = time.perf_counter()
                    _emit_span(
                        event_type="graph.node_start",
                        node_name=str(node_name),
                        graph_name=gname,
                        state_keys=node_keys,
                        duration_ms=0.0,
                        outcome="running",
                    )
                    yield chunk
                    _emit_span(
                        event_type="graph.node_end",
                        node_name=str(node_name),
                        graph_name=gname,
                        state_keys=node_keys,
                        duration_ms=(time.perf_counter() - t0) * 1000.0,
                        outcome="success",
                    )
            else:
                t0 = time.perf_counter()
                _emit_span(
                    event_type="graph.node_start",
                    node_name=gname,
                    graph_name=gname,
                    state_keys=_state_keys(chunk),
                    duration_ms=0.0,
                    outcome="running",
                )
                yield chunk
                _emit_span(
                    event_type="graph.node_end",
                    node_name=gname,
                    graph_name=gname,
                    state_keys=_state_keys(chunk),
                    duration_ms=(time.perf_counter() - t0) * 1000.0,
                    outcome="success",
                )

    return wrapper


# ── install / uninstall ───────────────────────────────────────────────────


def install() -> None:
    """Patch LangGraph ``CompiledGraph`` invoke / stream methods in-place.

    Silently no-ops when langgraph is not installed so SDK startup never
    breaks apps that don't use LangGraph.
    """
    global _installed, _original_invoke, _original_ainvoke
    global _original_stream, _original_astream
    if _installed:
        return
    try:
        # LangGraph's public graph lives in langgraph.pregel; the
        # Pregel class is the base of every CompiledGraph / StateGraph
        # compiled output.
        from langgraph.pregel import Pregel as CompiledGraph  # type: ignore[import]
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"langgraph not importable: {exc}") from exc

    if _original_invoke is None:
        _original_invoke = CompiledGraph.invoke
        CompiledGraph.invoke = _wrap_invoke(_original_invoke)
    if _original_ainvoke is None and hasattr(CompiledGraph, "ainvoke"):
        _original_ainvoke = CompiledGraph.ainvoke
        CompiledGraph.ainvoke = _wrap_ainvoke(_original_ainvoke)
    if _original_stream is None and hasattr(CompiledGraph, "stream"):
        _original_stream = CompiledGraph.stream
        CompiledGraph.stream = _wrap_stream(_original_stream)
    if _original_astream is None and hasattr(CompiledGraph, "astream"):
        _original_astream = CompiledGraph.astream
        CompiledGraph.astream = _wrap_astream(_original_astream)
    _installed = True
    logger.debug("eden: langgraph Pregel.invoke/stream patched")


def uninstall() -> None:
    """Reverse the patches applied by :func:`install`."""
    global _installed, _original_invoke, _original_ainvoke
    global _original_stream, _original_astream
    if not _installed:
        return
    try:
        from langgraph.pregel import Pregel as CompiledGraph  # type: ignore[import]
    except Exception:  # noqa: BLE001
        _installed = False
        _original_invoke = _original_ainvoke = _original_stream = _original_astream = None
        return
    if _original_invoke is not None:
        CompiledGraph.invoke = _original_invoke
    if _original_ainvoke is not None and hasattr(CompiledGraph, "ainvoke"):
        CompiledGraph.ainvoke = _original_ainvoke
    if _original_stream is not None and hasattr(CompiledGraph, "stream"):
        CompiledGraph.stream = _original_stream
    if _original_astream is not None and hasattr(CompiledGraph, "astream"):
        CompiledGraph.astream = _original_astream
    _installed = False
    _original_invoke = _original_ainvoke = _original_stream = _original_astream = None
