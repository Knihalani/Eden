"""Ingest hot-path Prometheus counters (A5 emit / A10 register).

Stable series names (contract with A5):

* ``eden_ingest_redis_commands`` — Redis commands issued on the ingest
  publish path (counter).
* ``eden_ch_flush_batch_size`` — ClickHouse flush batch size samples
  (summary: sum + count; mean = sum/count).
* ``eden_sse_publish_skipped`` — SSE publishes skipped when NUMSUB==0
  (counter).

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


def get_ingest_hot_path_metrics() -> dict[str, Any]:
    with _lock:
        return dict(_stats)


__all__ = [
    "get_ingest_hot_path_metrics",
    "record_ch_flush_batch_size",
    "record_ingest_redis_commands",
    "record_sse_publish_skipped",
    "reset_for_tests",
]
