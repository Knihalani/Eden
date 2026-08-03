"""Ingest hot-path Prometheus counters (A5 emit / A10 register).

Stable series names (contract with A5):

* ``eden_ingest_redis_commands`` — Redis commands issued on the ingest
  publish path (counter).
* ``eden_ch_flush_batch_size`` — ClickHouse flush batch size samples
  (summary: sum + count; mean = sum/count).
* ``eden_sse_publish_skipped`` — SSE publishes skipped when NUMSUB==0
  (counter).
* ``eden_ingest_sampled_out`` — events dropped by the N16 sampling
  gate before ever reaching a sink (counter). This duplicates the
  ``(sample, sampled_out)`` pair already recorded in
  :mod:`eden.observability.drop_metrics`, deliberately: that module's
  vocabulary is org-wide "why did an event disappear" accounting, and
  this module's stable ``eden_ingest_*`` series is the narrower ingest
  hot-path dashboard contract with A5/A10. Two views of the same event
  is the intended trade-off, not drift — the source of truth for the
  "was this event dropped, and why" question stays ``drop_metrics``.
* ``eden_ws_fanout_skipped`` — WebSocket trace fan-outs skipped on this
  pod because no local subscriber was connected for the job (counter).
  Mirrors ``eden_sse_publish_skipped``'s NUMSUB==0 pattern for the
  other real-time fan-out path.
* ``eden_ws_fanout_publish_skipped`` — cross-pod WebSocket fanout
  Redis PUBLISHes skipped because the ``eden:ws:fanout`` channel had no
  subscriber besides this pod itself (counter; Phase 3 ingest hot-path
  batching). Distinct from ``eden_ws_fanout_skipped`` above: that one
  fires when *this pod* has no local socket for the job; this one fires
  when the cross-pod round trip itself is skipped because nobody else
  could possibly receive it.
* ``eden_ingest_bytes`` — raw (pre-decompression) request body bytes
  accepted by the ingest endpoints (counter). Cheap: the byte count is
  already computed for the existing body-size guard, so this adds a
  lock + float-add, not a new pass over the payload.

A5 owns emit call sites; this module is the shared registry so
``/metrics`` always exposes the series (zeros until traffic).
"""

from __future__ import annotations

import threading
from typing import Any

_lock = threading.Lock()

_stats: dict[str, float] = {
    "eden_ingest_redis_commands": 0.0,
    "eden_ch_flush_batch_size_sum": 0.0,
    "eden_ch_flush_batch_size_count": 0.0,
    "eden_sse_publish_skipped": 0.0,
    "eden_ingest_sampled_out": 0.0,
    "eden_ws_fanout_skipped": 0.0,
    "eden_ws_fanout_publish_skipped": 0.0,
    "eden_ingest_bytes": 0.0,
}


def reset_for_tests() -> None:
    with _lock:
        for key in _stats:
            _stats[key] = 0.0


def record_ingest_redis_commands(n: int = 1) -> None:
    if n <= 0:
        return
    with _lock:
        _stats["eden_ingest_redis_commands"] += float(n)


def record_ch_flush_batch_size(size: int) -> None:
    if size < 0:
        return
    with _lock:
        _stats["eden_ch_flush_batch_size_sum"] += float(size)
        _stats["eden_ch_flush_batch_size_count"] += 1.0


def record_sse_publish_skipped(n: int = 1) -> None:
    if n <= 0:
        return
    with _lock:
        _stats["eden_sse_publish_skipped"] += float(n)


def record_ingest_sampled_out(n: int = 1) -> None:
    """Count ``n`` events dropped by the N16 sampling gate."""
    if n <= 0:
        return
    with _lock:
        _stats["eden_ingest_sampled_out"] += float(n)


def record_ws_fanout_skipped(n: int = 1) -> None:
    """Count ``n`` WebSocket fan-outs skipped for lack of a local subscriber."""
    if n <= 0:
        return
    with _lock:
        _stats["eden_ws_fanout_skipped"] += float(n)


def record_ws_fanout_publish_skipped(n: int = 1) -> None:
    """Count ``n`` cross-pod WS fanout PUBLISHes skipped (no subscriber)."""
    if n <= 0:
        return
    with _lock:
        _stats["eden_ws_fanout_publish_skipped"] += float(n)


def record_ingest_bytes(n: int) -> None:
    """Count ``n`` raw request body bytes accepted by ingest."""
    if n <= 0:
        return
    with _lock:
        _stats["eden_ingest_bytes"] += float(n)


def get_ingest_hot_path_metrics() -> dict[str, Any]:
    with _lock:
        return dict(_stats)


__all__ = [
    "get_ingest_hot_path_metrics",
    "record_ch_flush_batch_size",
    "record_ingest_bytes",
    "record_ingest_redis_commands",
    "record_ingest_sampled_out",
    "record_sse_publish_skipped",
    "record_ws_fanout_publish_skipped",
    "record_ws_fanout_skipped",
    "reset_for_tests",
]
