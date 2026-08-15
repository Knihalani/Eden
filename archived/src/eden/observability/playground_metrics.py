"""F49 playground run metrics (histogram + cost counter).

Stable series (rendered by :mod:`eden.observability.metrics_endpoint`):

* ``eden_playground_run_seconds`` — end-to-end playground run duration
  (histogram; no labels — ``org_id`` is deliberately excluded so the
  series cardinality stays bounded).
* ``eden_playground_cost_usd_total`` — cumulative playground LLM spend
  accumulated from handler responses (counter, no labels).

The playground service owns the emit call sites; this module is the
shared registry so ``/metrics`` always exposes the series (zeros until
traffic) — same contract as ``ingest_hot_path_metrics``.
"""

from __future__ import annotations

import threading
from typing import Any

_lock = threading.Lock()

RUN_SECONDS_BUCKETS: tuple[float, ...] = (
    0.1,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    30.0,
    60.0,
)

_stats: dict[str, float] = {
    "eden_playground_run_seconds_sum": 0.0,
    "eden_playground_run_seconds_count": 0.0,
    "eden_playground_cost_usd_total": 0.0,
}
_run_seconds_buckets: dict[float, float] = dict.fromkeys(RUN_SECONDS_BUCKETS, 0.0)


def reset_for_tests() -> None:
    with _lock:
        for key in _stats:
            _stats[key] = 0.0
        for bucket in _run_seconds_buckets:
            _run_seconds_buckets[bucket] = 0.0


def record_playground_run_seconds(seconds: float) -> None:
    """Observe one run duration into the histogram."""
    value = max(0.0, float(seconds))
    with _lock:
        _stats["eden_playground_run_seconds_sum"] += value
        _stats["eden_playground_run_seconds_count"] += 1.0
        for bound in RUN_SECONDS_BUCKETS:
            if value <= bound:
                _run_seconds_buckets[bound] += 1.0


def record_playground_cost_usd(cost_usd: float) -> None:
    """Accumulate run spend into the cost counter."""
    with _lock:
        _stats["eden_playground_cost_usd_total"] += max(0.0, float(cost_usd))


def get_playground_metrics() -> dict[str, Any]:
    """Snapshot for the /metrics renderer: scalar stats + histogram buckets."""
    with _lock:
        return {
            "stats": dict(_stats),
            "run_seconds_buckets": dict(_run_seconds_buckets),
        }


__all__ = [
    "RUN_SECONDS_BUCKETS",
    "get_playground_metrics",
    "record_playground_cost_usd",
    "record_playground_run_seconds",
    "reset_for_tests",
]
